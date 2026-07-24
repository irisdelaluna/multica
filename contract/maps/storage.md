# Storage contract map

Verified against `02794fcbd` (2026-07-24). The authoritative sources are
`server/migrations`, `server/pkg/db/queries`, `server/internal/storage`, and
the Redis implementations under `server/internal/{auth,handler,realtime,service}`.
Generated sqlc files are derived output, not a contract source.

## Backend boundaries

| Backend | Contract |
| --- | --- |
| PostgreSQL | Durable system of record for users, workspaces, issues, execution, integrations, and attachment metadata. The current migrated schema has 79 public tables. |
| Object storage | Durable attachment bytes. `S3_BUCKET` selects S3/S3-compatible storage; otherwise the server uses local disk. PostgreSQL stores the object URL and metadata in `attachment`. |
| Redis | Optional shared, ephemeral coordination and cache layer selected by `REDIS_URL`. It accelerates auth/membership/liveness/claims, holds short-lived runtime requests, and relays realtime events. Durable domain records remain in PostgreSQL. |
| Process memory | Single-node fallback for realtime fan-out, runtime request stores, and webhook limits when Redis is absent. Auth/membership/claim/liveness caches fall back to PostgreSQL or DB heartbeats. Public auth rate limiting is disabled without Redis. |

## PostgreSQL schema

### Domain table groups

“Inherits” means the row is scoped through a parent ID rather than carrying a
duplicate `workspace_id`. Access queries must still join or load the parent in
the request's workspace.

| Domain | Tables | Ownership / scoping contract |
| --- | --- | --- |
| Migration ledger | `schema_migrations` | Database-global; one row per applied migration filename stem. |
| Identity, workspaces, account settings | `user`, `workspace`, `member`, `workspace_invitation`, `verification_code`, `personal_access_token`, `daemon_token`, `notification_preference`, `pinned_item`, `feedback`, `contact_sales_inquiry`, `client_usage_daily`, `user_composio_connection` | `user`, verification, PAT, contact-sales, and Composio connection rows are user/global scoped. Membership is `(workspace_id, user_id)`. Invitations, daemon tokens, preferences, and pinned items carry `workspace_id`; preferences and pins also carry `user_id`. Feedback and client usage may carry workspace attribution. |
| Issues and collaboration | `issue`, `issue_dependency`, `issue_label`, `issue_to_label`, `issue_reaction`, `issue_subscriber`, `issue_property`, `comment`, `comment_reaction`, `inbox_item`, `activity_log`, `attachment` | Core rows carry `workspace_id` (`issue`, labels, properties, comments, reactions, inbox, activity, attachments). Join tables inherit through `issue_id`/`label_id`. Assignees, recipients, actors, and uploaders are polymorphic `*_type` + `*_id` pairs and are application-validated. |
| Projects and resources | `project`, `project_resource` | Both carry `workspace_id`; resources also carry `project_id` and `created_by`. |
| Agents, runtimes, tasks, usage | `agent`, `agent_runtime`, `runtime_profile`, `daemon_connection`, `agent_task_queue`, `task_message`, `task_token`, `task_usage`, `task_usage_hourly`, `task_usage_hourly_dirty`, `task_usage_hourly_rollup_state`, `agent_invocation_target` | Agent/runtime/profile rows carry `workspace_id`. Queue/message/raw-usage rows mostly inherit through agent, runtime, issue, or task IDs; task tokens and hourly rollups carry workspace attribution directly. Invocation targets inherit the agent workspace and store polymorphic target IDs. |
| Skills and resource labels | `skill`, `skill_file`, `agent_skill`, `agent_to_label`, `skill_to_label` | `skill` carries `workspace_id`; files and binding tables inherit through skill/agent/label IDs. Label bindings deliberately rely on application cleanup rather than foreign keys. |
| Squads | `squad`, `squad_member` | `squad` carries `workspace_id`; membership inherits through `squad_id`. Member rows are polymorphic (`member_type`, `member_id`). |
| Chat | `chat_session`, `chat_message`, `chat_pinned_agent`, `chat_draft_restore` | Sessions and pins carry `workspace_id`; messages and restore records inherit via `chat_session_id`. Sessions are additionally scoped by creator, agent, and optional runtime. Attachments join this domain through `chat_session_id`, `chat_message_id`, and transient `task_id`. |
| Autopilots and internal jobs | `autopilot`, `autopilot_trigger`, `autopilot_run`, `autopilot_subscriber`, `autopilot_collaborator`, `autopilot_rule_version`, `webhook_delivery`, `sys_cron_executions` | `autopilot`, rule versions, and webhook deliveries carry `workspace_id`; triggers/runs/subscribers/collaborators inherit through `autopilot_id`. `sys_cron_executions` is database-global distributed job state. |
| GitHub | `github_installation`, `github_pending_installation`, `github_pull_request`, `github_pull_request_check_suite`, `github_pending_check_suite`, `issue_pull_request` | Installation, PR, and pending-check rows carry `workspace_id`. Pending installations are intentionally pre-workspace. Check suites and issue links inherit through PR/issue IDs. |
| Generalized channels | `channel_installation`, `channel_user_binding`, `channel_chat_session_binding`, `channel_inbound_message_dedup`, `channel_inbound_audit`, `channel_outbound_card_message`, `channel_binding_token` | Installation and binding-token rows carry `workspace_id`; other rows inherit through `installation_id` and/or `chat_session_id`. Generalized channel tables were introduced without foreign keys. |
| Legacy Lark channel model | `lark_installation`, `lark_user_binding`, `lark_chat_session_binding`, `lark_inbound_message_dedup`, `lark_inbound_audit`, `lark_outbound_card_message`, `lark_binding_token` | Installation and binding-token rows carry `workspace_id`; other rows inherit through installation/session IDs. These older tables still contain historical foreign keys and coexist with the generalized channel tables. |

Cross-cutting scoping rules:

- Workspace-scoped handler writes resolve or validate IDs before using them.
  The relational schema is not the authorization boundary.
- `workspace_id` is intentionally duplicated on some hot/read-path tables to
  make tenant filters explicit; other children inherit scope from a parent.
- Relationships without foreign keys require explicit validation and cleanup.
  When parent cleanup and dependent cleanup must be atomic, application code
  owns the transaction.
- Historical migrations created many foreign keys and cascades, which remain
  in existing schemas. The current rule is **no new** foreign keys,
  `REFERENCES`, or cascading actions; it is not a claim that the final schema
  contains none.

### sqlc ownership

`server/sqlc.yaml` gives sqlc the entire `server/migrations` directory as its
schema and `server/pkg/db/queries` as its query set. Generated Go lands in
`server/pkg/db/generated`.

- Change tables/columns through paired migrations.
- Change application SQL in the domain query file.
- Run `make sqlc` after either contract changes.
- Do not hand-edit generated models or query wrappers.

At the verified revision there are 253 `.up.sql` migrations and 41 sqlc query
files. The migration set, rather than `generated/models.go`, remains the
canonical history and final-shape input.

### Migration contract

The runner and repository rules establish these invariants:

1. Every migration has matching `.up.sql` and `.down.sql` files. Files are
   applied in lexical order and tracked by full stem in `schema_migrations`.
2. Historical duplicate numeric prefixes are frozen. New migrations use a
   unique numeric prefix after the legacy `001`–`148` range.
3. The runner pins one PostgreSQL connection and takes a session advisory lock,
   so concurrent runners serialize. It does not wrap the migration loop in a
   transaction because PostgreSQL rejects `CREATE INDEX CONCURRENTLY` there.
4. A migration is recorded only after its SQL succeeds. Because files are not
   globally transactional, partially applied DDL must be safe to diagnose and,
   where a known rename/replay path exists, guarded with `IF [NOT] EXISTS`.
5. Do not add foreign keys or cascades. Validate relationships and perform
   dependent cleanup in application code, using an application transaction
   where atomicity matters.
6. Every new index, including unique indexes and indexes for new tables, uses
   `CREATE [UNIQUE] INDEX CONCURRENTLY`. A concurrent create/drop is the only
   statement in its migration file. Column/table DDL and extension creation go
   in separate migrations.

The migration loader is `server/internal/migrations/migrations.go`; the runner
is `server/cmd/migrate/main.go`; filename policy is pinned by
`server/internal/migrations/migrations_lint_test.go`. The current database
requires `pgcrypto` and `pg_trgm` in addition to built-in `plpgsql`.

### Schema-only snapshot procedure

Use an isolated worktree database, never the shared development database. The
PostgreSQL container supplies a `pg_dump` version matching the server. A fixed
restrict key keeps PostgreSQL 17's `\restrict` line deterministic.

```bash
make worktree-env
make setup-worktree

set -a
. ./.env.worktree
set +a

mkdir -p contract/fixtures
docker compose exec -T postgres pg_dump \
  -U "$POSTGRES_USER" \
  -d "$POSTGRES_DB" \
  --schema-only \
  --no-owner \
  --no-privileges \
  --restrict-key=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  > contract/fixtures/postgres-schema.sql

git diff --check -- contract/fixtures/postgres-schema.sql
git diff -- contract/fixtures/postgres-schema.sql
```

The snapshot includes extensions, functions, tables, constraints, triggers,
and indexes, but no rows. Regenerate it only from a database freshly migrated
at the target revision and review the diff with the migrations that caused it.

## Attachments and object storage

### Write path and ownership

`POST /api/upload-file` is capped at 100 MiB and reads the accepted file into
memory. The server sniffs the first 512 bytes, applies a small extension
override map, generates one UUIDv7 for the attachment ID/object basename, and
keeps the original extension.

Object keys encode the owner boundary:

```text
workspaces/<workspace_uuid>/<uuidv7><extension>
users/<user_uuid>/<uuidv7><extension>
```

- Workspace uploads validate membership before writing. Optional issue,
  comment, chat-session, and task bindings are validated before the object
  write.
- Workspace uploads create an `attachment` row with uploader identity,
  original filename, URL, content type, size, and optional owners.
- User-scoped uploads (for example avatars) write only the object and return
  its URL; they do not create an `attachment` row.
- `attachment.task_id` is a transient handle for agent-produced chat files.
  Completion binds still-unclaimed rows to the durable `chat_message_id`.
- The object write happens before the attachment-row insert. If the database
  insert fails, the API returns the usable object URL and logs the failure;
  that object is not discoverable through attachment queries and requires
  operational orphan cleanup.
- Object deletion is best-effort. Local/S3 delete errors are logged rather
  than made transactional with PostgreSQL deletion.

### Backend selection and paths

| Mode | Configuration | Bytes and URL contract |
| --- | --- | --- |
| AWS S3 / S3-compatible | `S3_BUCKET` enables it. `S3_REGION` defaults to `us-west-2`; `AWS_ENDPOINT_URL` enables MinIO/R2/etc.; path style defaults on for a custom endpoint. | `PutObject` stores content type/disposition, `Cache-Control: max-age=432000,public` (5 days), and AWS `INTELLIGENT_TIERING` (`STANDARD` for custom endpoints). Returned URL priority is CloudFront domain, custom endpoint, then regional S3 URL. |
| Local disk fallback | Used when `S3_BUCKET` is empty. `LOCAL_UPLOAD_DIR` defaults to `./data/uploads`; `LOCAL_UPLOAD_BASE_URL` is optional. | Object key maps below the upload directory. A `<key>.meta.json` sidecar preserves original filename/content type. Traversal and direct sidecar reads are rejected. URLs are `/uploads/<key>` unless a base URL is configured. Local disk is node-local and therefore unsuitable for unreplicated multi-node deployments. |

### Read, preview, and cache behavior

`attachment.url` is the durable object locator, while response URLs have
different lifetimes:

| Surface | Behavior |
| --- | --- |
| `url` | Raw stored object URL. It may be private or site-relative. |
| `download_url` | Per-response download target. It can be the stable API path or a short-lived CloudFront URL. Do not persist it. |
| `markdown_url` | Persistable URL. Public durable storage URLs are used directly; otherwise the server emits `/api/attachments/<id>/download`, prefixed by `MULTICA_PUBLIC_URL` when configured. |
| Download endpoint | Re-resolves the attachment workspace, checks membership, then chooses CloudFront signing, S3 presigning, or API proxy. `ATTACHMENT_DOWNLOAD_URL_TTL` defaults to 30 minutes. Private/local hosts are proxied automatically. |
| Proxy download | `Cache-Control: no-store`; supports range requests. Local files use `http.ServeContent`; forward-only S3 streams support one byte range. |
| Text preview | Only allow-listed text/source types, capped at 2 MiB, returned as `text/plain` with `Cache-Control: no-store` and restrictive CSP. |

Source anchors: `server/internal/handler/file.go`,
`server/internal/storage/{storage,local,s3}.go`,
`server/pkg/db/queries/attachment.sql`, and migrations
`029_attachment`, `083_attachment_chat_columns`, `164_attachment_task_id`, and
`165_attachment_task_id_index`.

## Redis and cache layers

All Redis clients derive from `REDIS_URL`. Request-path storage, realtime
writes, and blocking realtime reads use separate clients so `XREAD` cannot
starve cache/auth operations. Redis failures generally degrade to the durable
or in-memory path; the exceptions are short-lived multi-node request workflows,
whose shared lifecycle lives in Redis while configured.

### Keyspaces, authority, TTL, and fallback

| Layer / keyspace | Stored value and authority | Retention / invalidation | Missing or unhealthy Redis |
| --- | --- | --- | --- |
| PAT auth `mul:auth:pat:<token_hash>` | Positive `token_hash → user_id`; PostgreSQL PAT row is authoritative. | `min(10m, token remaining lifetime)`; delete on revoke. | Miss/error queries PostgreSQL; cache errors are swallowed. |
| Daemon-token auth `mul:auth:daemon:<token_hash>` | Positive `{workspace_id, daemon_id}`; PostgreSQL daemon token is authoritative. | `min(10m, token remaining lifetime)`; delete with token. | Miss/error queries PostgreSQL. |
| Cloud PAT `mul:auth:mcn:<token_hash>` | Positive Fleet-verified identity; Fleet plus local owner existence are authoritative. | 60s; negative results are never cached; no push invalidation. | Every request verifies with Fleet; verifier is disabled if Fleet URL is absent. |
| Membership `mul:auth:member:<user_id>:<workspace_id>` | Positive membership existence only; roles always come from PostgreSQL. | 5m; proactive delete on membership changes. | Miss/error queries PostgreSQL. |
| Runtime liveness `mul:runtime:hb:<runtime_id>` | Presence means a recent heartbeat; PostgreSQL remains transition/fallback state. | 90s, refreshed about every 15s. PostgreSQL `last_seen_at` is flushed at most 60s stale (then batched). | Every heartbeat writes PostgreSQL; sweeper uses the DB stale window. |
| Empty claim `mul:claim:runtime:{empty,version}:<runtime_id>` | Negative “no queued task” hint tagged with an invalidation version; queue rows in PostgreSQL are authoritative. | Empty verdict 3m; version 24h sliding. Enqueue increments version before wakeup. Redis calls are bounded to 250ms. | Claims always scan PostgreSQL. Errors never block enqueue. |
| Runtime CLI update `mul:{runtime_pending}:update:*` | Short-lived pending/running/result request shared across API nodes. | Request and active lock 5m; pending ZSET 10m. | Per-process in-memory store in single-node mode. |
| Runtime model discovery `mul:{runtime_pending}:model_list:*` | Short-lived request/result shared across API nodes. | Request 2m; pending ZSET 4m. | Per-process in-memory store. |
| Runtime local-skill list/import `mul:{runtime_pending}:local_skill:*` | Short-lived request/result shared across API nodes. Claims use Lua to atomically remove from the ZSET and mark running. | Request 5m; pending ZSET 10m. | Per-process in-memory stores. |
| Public endpoint rate limit `mul:ratelimit:<path>:<ip>` | Fixed-window request counter; safety control, not domain state. | Auth send/google: 5/min default; verify: 20/min; contact sales: 5/hour. Key TTL equals window. | Limiter is disabled/fail-open. |
| Autopilot webhook rate limits `mul:webhook:{rate,ip,absolute-ip}:*` | Sliding-window ZSETs. | Per token 60/min, bad-credential IP 30/min, absolute IP 600/min; TTL is twice the 1m window. | In-memory single-node equivalents; Redis errors fail open. |
| Realtime sharded streams `ws:relay:shard:<0..N-1>` | Cross-node event transport; PostgreSQL/domain APIs remain durable truth. | Default 8 shards, approximate max length 100,000 each, 5m startup replay window; no time TTL. | In-memory hub, single-node only. |
| Realtime legacy streams `ws:scope:<type>:<id>:stream` and node registry | Per-scope streams plus node-interest ZSETs, retained for legacy/dual rollout mode. | Approximate max length 10,000; node heartbeat TTL 90s, refreshed every 30s; stale registry scores swept every 5m. | In-memory hub. |
| Realtime node heartbeat `ws:node:<node_id>:heartbeat` | Relay health signal. | 90s, refreshed every 30s. | No cross-node relay health exists. |

Realtime sharding knobs are `REALTIME_RELAY_MODE`,
`REALTIME_RELAY_SHARDS`, `REALTIME_RELAY_STREAM_MAXLEN`,
`REALTIME_RELAY_XREAD_COUNT`, `REALTIME_RELAY_XREAD_BLOCK`, and
`REALTIME_RELAY_REPLAY_GRACE`. The default mode is `sharded`; `dual` mirrors
sharded and legacy streams during rollout, and `legacy` uses per-scope streams.

### Failure and consistency summary

- Auth, membership, liveness, and empty-claim Redis entries are hints. Cache
  misses and Redis errors preserve correctness through PostgreSQL/Fleet.
- Runtime update/model/local-skill workflows are intentionally ephemeral.
  Redis makes them cross-node; the in-memory fallback is correct only for a
  single API node and loses requests on process restart.
- Rate limiting is fail-open on Redis errors. Webhook limits retain a
  single-node in-memory safety net; public auth/contact-sales limits do not.
- Realtime streams are bounded transport, not an event log. Clients must
  reconnect/refetch durable state, and downstream delivery is idempotent.
- Redis stores no attachment bytes and no durable copy of PostgreSQL records.
