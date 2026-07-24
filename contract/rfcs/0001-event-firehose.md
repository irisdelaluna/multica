# RFC 0001: Event Firehose Seam

- **Status**: Proposed
- **Issue**: IRI-17
- **Author**: Golden Architect
- **Inputs**: `contract/maps/realtime.md` (IRI-14, in review at time of writing),
  `contract/maps/storage.md`, `contract/maps/api.md`,
  `contract/maps/agent-pipeline.md`, and direct reads of
  `server/internal/events/bus.go`, `server/cmd/server/listeners.go`,
  `server/cmd/server/activity_listeners.go`, `server/internal/realtime/*`,
  `server/internal/handler/webhook_delivery.go`,
  `server/internal/handler/autopilot.go`, `server/pkg/protocol/events.go`.

## Recommendation (TL;DR)

Add an append-only **Postgres outbox table `event_log`**, populated by a
`SubscribeAll` tap on the existing in-process `events.Bus`, exposed to
subscribers through a **cursor-based pull API** plus an **SSE live tail**,
with events described by a **lexicon-style versioned schema registry** under
`contract/lexicons/`. Auth reuses the existing session/PAT + workspace
membership stack under one invariant: **a principal can read from the
firehose exactly what its WebSocket connection would have been sent live.**

The firehose is the *durable, replayable form of the existing WS stream* —
same event types, same payload shapes (the IRI-14 catalog is the payload
contract), plus an envelope with identity, ordering, and visibility. We do
not invent a second event vocabulary.

Not chosen (details in §8): LISTEN/NOTIFY as the seam, Redis Streams as the
log, reusing `webhook_delivery`, an external broker (Kafka/NATS), and
CDC/logical replication.

## 1. Current fabric (verified)

One in-process, synchronous fan-out point already exists and every event
producer goes through it:

```
HTTP handler / service
  └─ h.publish{,Task,Chat}()            handler.go:436 — after the DB write,
      └─ events.Bus.Publish()           NOT in the write transaction
          ├─ registerListeners          → WS envelope {type,payload,actor_id,actor_type}
          │    └─ realtime.Broadcaster  → local Hub rooms
          │         └─ Redis sharded streams (optional, cross-node transport,
          │            MAXLEN ~100k, 5-minute replay grace — not a log)
          ├─ registerActivityListeners  → activity_log rows (curated subset)
          │                               → derived activity:created event
          ├─ registerNotificationListeners → inbox_item rows → inbox:* events
          ├─ registerAutopilotListeners → run-state sync
          ├─ registerSubscriberListeners, lark/slack outbound, daemon wakeup
```

Load-bearing properties of today's fabric:

- **~88 event types** (`server/pkg/protocol/events.go`,
  `packages/core/types/events.ts`), cataloged with payloads and cache
  semantics in `contract/maps/realtime.md`. This is the de facto protocol.
- **Delivery is fire-and-forget.** The bus is in-memory and synchronous;
  publish happens after the domain write but outside its transaction. A crash
  between commit and publish loses the event. Clients tolerate this because
  reconnect triggers a full invalidation sweep (realtime map §6).
- **Redis is optional** (storage map): single-node deployments run a pure
  in-memory hub. Any design requiring Redis for correctness is out.
- **Routing classes already exist**: workspace broadcast (default), personal
  send-to-user (inbox:*, invitation:created/revoked, member:added), global
  daemon broadcast, and dormant per-task/per-chat scopes (MUL-1138 phase 1).
- **`activity_log` is a curated per-issue projection**, not an event log: a
  hand-picked subset of actions with diff-shaped `details`, written by a bus
  listener with the same loss window. IRI-36's workspace timeline reads it
  (`ListWorkspaceActivities`) for backfill and `activity:created` for live.
- **`webhook_delivery` is an inbound receipt ledger** for autopilot webhook
  triggers — despite the "outbound path" framing in IRI-17's description, the
  code (`handler/webhook_delivery.go`, `autopilot_webhook.go`) records
  *received* third-party webhooks: dedupe, signature status, attempts,
  operator replay. It points the wrong direction to reuse, but its
  status/attempts/replay row shape is the right template for a future push
  (webhook-out) subscription layer.
- **Autopilot triggers are `schedule | webhook`** (+ manual dispatch)
  (`handler/autopilot.go:1237`). There is no domain-event trigger kind today;
  `event_filters` JSONB (migration 110) already anticipates event matching.

## 2. Goals and non-goals

Goals:

1. A subscribable, durable, replayable stream of domain events (issue
   lifecycle, comments, status, agent runs) — the composability point for
   consumers that are not browser tabs.
2. Zero new infrastructure requirements: Postgres-only correctness, works
   single-node, Redis stays an optimization.
3. Contract-first: event payloads identical to the WS surface, schema
   versioned and conformance-testable (feeds IRI-7 golden fixtures).
4. Cheap consumers: a sidecar in any language needs HTTP + JSON and a stored
   cursor. No SDK required.

Non-goals (v1):

- Exactly-once delivery. We provide at-least-once with stable event IDs;
  consumers dedupe/idempote.
- A general workflow engine, event sourcing, or making `event_log` the
  system of record. Postgres domain tables remain truth; the firehose is a
  feed, and REST remains the resync path.
- Streaming `task:message` / chat token traffic. That is transport, not
  domain fact (and chat payloads are permission-sensitive, MUL-4159).
- Push delivery to external URLs (webhook-out). The seam enables it later;
  v1 subscribers pull or tail.

## 3. Decision 1 — the log: Postgres outbox `event_log`

### Options considered

| Option | Durability | Replay | Ordering | Infra | Verdict |
| --- | --- | --- | --- | --- | --- |
| **A. Postgres append-only `event_log`** | yes | arbitrary window (retention-bound) | per-workspace total order via `seq` | none new | **chosen** |
| B. LISTEN/NOTIFY | none (lost on disconnect/crash) | none | none | none | rejected as seam; optional wakeup later (§9 phase 3) |
| C. Reuse `webhook_delivery` | yes | operator replay only | none | none | rejected — inbound receipt ledger keyed to autopilot/trigger; wrong ownership, direction, retention |
| D. Redis Streams (existing relay) | bounded MAXLEN, optional component | ~5 min grace | per-shard | Redis becomes mandatory | rejected — storage map is explicit: "bounded transport, not an event log" |
| E. External broker (Kafka/NATS JetStream) | yes | yes | yes | heavy | rejected — ops weight unjustified at self-host/small-team scale; revisit only with evidence |
| F. CDC / logical replication (wal2json) | yes | yes | yes | medium | rejected — couples consumers to the *physical schema*; our contract is the domain event surface, and "the contract IS the protocol" |

### Write path: tap the bus, not the handlers

A single `SubscribeAll` listener (registered alongside `registerListeners`)
persists allow-listed events to `event_log`. It marshals the payload with the
same envelope construction as `listeners.go`, so **the stored payload is
byte-equivalent to what WS clients received**. One listener, ~100 lines, no
changes to any of the ~330 endpoints.

Consequence to name honestly: the tap inherits today's loss window (crash
between domain commit and publish drops the event; a listener panic is
recovered and logged but the row is lost). This is the same guarantee the WS
stream and `activity_log` already have, and every planned consumer already
needs a reconciliation path (REST resync) for the cursor-expiry case (§6), so
the marginal risk buys a dramatically cheaper phase 1. If evidence later
shows the gap matters for specific types (e.g. issue status transitions
feeding autopilot event triggers), phase 3 moves those producers to
transactional emit — an `emit(tx, event)` helper that inserts the row inside
the domain transaction and publishes to the bus after commit. The table and
API do not change; only the producer's guarantee does. That reversibility is
why the tap is safe to start with.

### Schema (DDL sketch)

Per repo migration rules: no FKs, every index `CREATE INDEX CONCURRENTLY` in
its own single-statement migration, numeric prefix ≥ 213.

```sql
CREATE TABLE event_log (
    seq             BIGINT GENERATED ALWAYS AS IDENTITY,
    id              UUID NOT NULL,            -- UUIDv7, global event identity (dedupe key)
    workspace_id    UUID NOT NULL,
    type            TEXT NOT NULL,            -- 'issue:updated' — existing WS type names
    schema_ref      TEXT NOT NULL,            -- 'multica.issue.updated#1' (§4)
    actor_type      TEXT NOT NULL,            -- member | agent | system
    actor_id        UUID,
    subject_kind    TEXT NOT NULL,            -- issue | comment | task | agent | project | ...
    subject_id      UUID,
    visibility      TEXT NOT NULL DEFAULT 'workspace',  -- workspace | user (§5)
    recipient_id    UUID,                     -- set when visibility = 'user'
    task_id         UUID,                     -- correlation hints, mirrors events.Event
    chat_session_id UUID,
    payload         JSONB NOT NULL,           -- exactly the WS payload
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- separate concurrent-index migrations:
--   UNIQUE (seq); UNIQUE (id); (workspace_id, seq); (created_at) for the purge job
```

`subject_kind`/`subject_id` are extracted by the persister from the known
payload shapes (the realtime map enumerates them) so consumers can filter
"everything about issue X" without parsing payloads.

### Ordering and the reader race

`seq` gives per-workspace total order, but identity values are assigned at
insert and rows become *visible* in commit order — a reader at `seq=42` can
miss a still-uncommitted `seq=41`. v1 mitigation: the pull query reads only
rows with `created_at < now() - EVENT_LOG_READ_HORIZON` (default 1s). With
phase-1 autocommit single-row inserts the in-flight window is milliseconds;
the horizon is a comfortable bound and costs 1s of feed latency, which the
SSE tail (fed from the bus, not the table) hides for live consumers. If
phase 3 introduces transactional emits with longer transactions, upgrade the
reader to `pg_current_snapshot()` xip-exclusion instead of widening the
horizon. Both keep the wire contract unchanged.

### Retention

Time-based purge job (same shape as existing sweepers):
`EVENT_LOG_RETENTION_DAYS`, default 90. No compaction — the firehose is a
feed, not state. Write amplification is one row per domain mutation,
comparable to `activity_log` (which writes up to six rows per issue update
today); payload JSONB is the already-serialized WS response shape, a few KB
typical, retention-bounded.

## 4. Decision 2 — event schema and versioning (lexicon-style)

### Envelope (wire shape, pull and SSE identical)

```json
{
  "id": "0198a3f2-7c1e-7000-8000-3fbb1a2c9d10",
  "seq": 41823,
  "type": "issue:updated",
  "schema": "multica.issue.updated#1",
  "occurred_at": "2026-07-24T02:49:25Z",
  "workspace_id": "91d9fdfc-…",
  "actor": { "type": "agent", "id": "26b1a410-…" },
  "subject": { "kind": "issue", "id": "5a4ff1ed-…" },
  "visibility": "workspace",
  "correlation": { "task_id": null, "chat_session_id": null },
  "payload": { /* exactly the WS payload for this type */ }
}
```

`type` keeps the existing `domain:action` names — 88 deployed types with a
reviewed catalog are worth more than aesthetic renaming. `schema` adds the
AT-Proto-lexicon-style identity: reverse-DNS-ish NSID + integer version. The
mapping is mechanical (`issue:updated` → `multica.issue.updated`), so the
Nostr/AT-Proto lateral stays open without a migration.

### Registry

`contract/lexicons/multica.<domain>.<action>.json` — one JSON Schema per
event type covering envelope + payload, hand-frozen from the IRI-14 catalog
and the zod payload types in `packages/core/types/events.ts`. TS clients keep
parsing with zod; non-TS consumers (Haskell sidecars) codegen from the JSON
Schema. The IRI-7 conformance harness asserts that server-emitted fixtures
validate against the registry — that is what makes the registry authoritative
rather than aspirational. Types whose payload is currently `unknown` in the
catalog (label:*, squad:*, pin:*, skill:*, …) enter the registry as
`#1` with a permissive schema and get tightened by conformance work; they are
not blocked from the firehose.

### Versioning rules

1. Additive optional fields: same version. Consumers must ignore unknown
   fields (Postel; matches the existing `parseWithFallback` posture).
2. Breaking change (remove/rename/retype/semantic shift): mint `#N+1`; the
   producer emits the new version only. No dual-emit — it doubles rows and
   creates ambiguity about which row is "the" event for dedupe.
3. The log is immutable: historical rows keep their historical `schema_ref`.
   Replaying across a version boundary means handling both versions or
   resyncing state via REST and resuming from head. Consumers pin the
   versions they understand and treat unknown `schema_ref` per their own
   policy (skip vs halt).

### v1 inclusion

Include: workspace-broadcast domain facts — `issue:*`,
`issue_labels|issue_metadata|issue_properties:changed`, `comment:*`,
`reaction:*`, `issue_reaction:*`, `subscriber:*`, `project:*`, `label:*`,
`property:*`, `squad:*`, `agent:*`, `member:*`, `workspace:updated|deleted`,
`task:queued|dispatch|running|waiting_local_directory|completed|failed|cancelled`,
`skill:*`, `pin:*`, `pull_request:*`, `github_installation:*`,
`invitation:accepted|declined`.

Exclude (with reason):

- `daemon:heartbeat`, `task:progress`, `task:message` — transport/streaming,
  not domain facts; unbounded frequency.
- `chat:*` — payloads are permission-sensitive workspace fanouts (MUL-4159);
  admitting them requires per-event permission classification. Deferred, not
  refused; the `visibility` column is the landing zone.
- `inbox:*`, `invitation:created|revoked` — personal projections of events
  already in the log; if admitted later they are `visibility='user'` rows.
- `activity:created` — derived from `issue:updated` et al. by
  `activity_listeners`; logging both the fact and its projection
  double-represents every change.

## 5. Decision 3 — subscriber API and auth

### Endpoints

```
GET /api/workspaces/{id}/events
    ?after=<cursor>        opaque; encodes seq. Omit → start at head (returns latest_seq only… or empty batch + cursor)
    &limit=<n>             default 100, max 500
    &types=issue:*,comment:created   optional prefix/exact type filter
    &subject=issue:<uuid>  optional subject filter
→ 200 { "events": [ …envelopes… ], "next_cursor": "…", "latest_seq": 41823 }
→ 410 Gone { "oldest_available_cursor": "…" }   when after < retention floor

GET /api/workspaces/{id}/events/stream?after=<cursor>&types=…
→ SSE: `id:` = cursor, `event:` = type, `data:` = envelope; heartbeat comments;
  standard Last-Event-ID resume. Catch-up is served from event_log, then the
  connection switches to live bus delivery.
```

SSE (not WS) for the tail: sidecars get resumable streaming with plain HTTP —
trivial from Haskell/curl, no frame protocol, built-in resume semantics via
`Last-Event-ID`. Browsers keep the existing WS surface unchanged; the
firehose does not replace it (WS also carries personal + chat events the
firehose excludes in v1).

### Auth

No new token type. Session cookie, PAT, or daemon token — the same stack as
every other endpoint (api.md §legend) — plus workspace membership, exactly
like REST. One invariant governs row-level access:

> **Firehose ACL ≡ WS fanout ACL.** A principal may read an event iff the
> live fanout would have delivered it to that principal's connection:
> `visibility='workspace'` rows require membership of `workspace_id`;
> `visibility='user'` rows additionally require `recipient_id = caller`.

This keeps the security review surface identical to the already-reviewed WS
routing table in `listeners.go` and gives future personal-event admission a
defined slot. Rate limiting: `limit` cap + the standard middleware; SSE
connections count against the same per-user connection accounting as WS.

## 6. Decision 4 — replay semantics

- **Delivery**: at-least-once. Consumers dedupe on `id` (UUIDv7) or track
  `seq` monotonically per workspace.
- **Ordering**: `seq` is a per-workspace total order of *observation*
  (publish order), not a causality proof. Good enough for every named
  consumer; consumers needing invariants read current state via REST.
- **Resume**: store `next_cursor` durably, pass as `after`. Identical
  semantics on pull and SSE (`Last-Event-ID`).
- **Cursor expiry**: `after` older than retention → `410 Gone`. Recovery
  protocol: resync state from REST, resume from `latest_seq`. Every consumer
  must implement this path — it is also the crash-gap and the
  version-boundary recovery, so it is not optional machinery.
- **No server-side subscriber registry in v1**: cursors are client-owned.
  A durable `event_subscription` row (per-subscriber cursor, filters,
  delivery status — the `webhook_delivery`-shaped part) appears only with
  push delivery, later.

## 7. Consumers mapped onto the seam

| Consumer | Mode | Notes |
| --- | --- | --- |
| Workspace timeline v2 (IRI-36) | backfill via pull (`?types=…&limit`), live via SSE or existing WS | v1 deliberately kept its response self-contained; swap `ListWorkspaceActivities` + `activity:created` for firehose envelopes without changing the view. Gains: full event breadth (comments, labels, projects…) vs. the curated activity subset. `activity_log` itself stays — it is a per-issue product feature and attribution source, and long-term can become a firehose projection. |
| Muninn event→memory bridge | pull loop, cursor checkpointed in the vault | at-least-once + `id`-idempotent writes; 410 → resync + resume. The bridge is the reference consumer for the RFC's semantics. |
| Haskell sidecars | pull or SSE; types from JSON Schema codegen | no TS dependency — this is the reason the registry is JSON Schema, not zod-only. |
| Purpose-built views | pull with `types`/`subject` filters | cheap views over the contract, per the project thesis. |
| Autopilot event triggers (future) | in-process consumer with durable cursor | unlocks `kind='event'` triggers reusing existing `event_filters`; wants phase-3 transactional emit for the trigger-relevant types. Out of scope here; the seam is designed so this is additive. |

## 8. What we are NOT choosing, and why

- **LISTEN/NOTIFY as the seam**: no durability, no replay, 8KB payloads,
  connection-pinned. Acceptable later as an intra-Postgres wakeup to reduce
  SSE catch-up polling on multi-node without Redis — an optimization behind
  the same API, never the contract.
- **Redis Streams as the log**: Redis is optional by design; the relay is
  bounded transport with a 5-minute replay grace. Promoting it to the seam
  makes Redis mandatory and its MAXLEN a correctness parameter.
- **Reusing `webhook_delivery`**: inbound receipt ledger, per-autopilot
  ownership, operator-replay semantics. Reuse the *pattern* for push
  delivery later, not the table.
- **External broker**: unjustified operational weight for self-hosted small
  teams; every named consumer is satisfied by Postgres + HTTP. Revisit only
  with throughput evidence.
- **CDC/logical replication**: binds consumers to physical schema and
  migration churn; our composability point is the domain contract, which the
  WS surface already defines and IRI-14 already documents.
- **Transactional outbox in v1**: touches every producer for a guarantee no
  v1 consumer needs (all have resync paths). Kept as phase 3 for the types
  that eventually need it — the cheap-to-reverse ordering.

## 9. Rollout

1. **Phase 1 (build)**: `event_log` migrations; bus-tap persister with
   allowlist + subject/visibility classifier; pull endpoint; purge job;
   `contract/lexicons/` seeded for the included types; conformance fixtures
   (with IRI-7).
2. **Phase 2**: SSE tail with Last-Event-ID; timeline v2 swap; muninn bridge
   onboards as reference consumer.
3. **Phase 3 (evidence-gated)**: transactional `emit()` for
   autopilot-trigger-relevant types; autopilot `kind='event'`;
   LISTEN/NOTIFY wakeup if multi-node-without-Redis latency matters;
   personal/chat event admission via `visibility='user'`.

## 10. Open questions

1. Should `task:message` ever get a durable (sampled or terminal-summary)
   representation for the muninn bridge, or is the task result comment
   sufficient? (Current position: sufficient.)
2. Payload size policy: `issue:updated` embeds the full `IssueResponse`.
   Fine at current scale; if description-heavy workspaces bloat the log,
   introduce payload trimming as a schema version bump per §4.
3. Does the muninn bridge run as a workspace-member PAT (sees exactly what a
   member sees) or does it eventually need an elevated service scope for
   `visibility='user'` rows? v1 assumes member-PAT.
