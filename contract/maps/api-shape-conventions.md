# Multica REST API — Shape Conventions & Irregularities

> Companion to `contract/maps/api.md` (route table). Where `api.md` answers
> "which endpoint, which auth, which schema", this map answers the cross-cutting
> question a Haskell client must encode exactly: **what is the wire shape of
> each field kind, and where does the surface stop being uniform?**
>
> Lane: MAP (IRI-43). Every claim is backed by a `file:line` citation and a
> short verbatim snippet. Irregularities are labelled **Irregularity:** with an
> impression of Go-handler-artifact vs genuine-domain-distinction and a
> confidence (low/med/high). Irregularities are recorded as **facts**, not fixes.
>
> Source priority: `packages/core/api/schemas.ts` (zod = real response shapes) >
> `packages/core/api/client.ts` + `packages/core/types/` (request bodies, TS
> enum unions) > `server/internal/handler/*.go` (Go structs = literal wire
> shape) > `server/cmd/server/router.go` (mounting/scoping) >
> `server/migrations/*.up.sql` (DB-level CHECK constraints = enum ground truth)
> > `e2e/fixtures.ts` (recorded live values).

---

## A. ID FORMAT

**Entity primary keys are Postgres UUID (v4) strings, generated server-side.**
Every `id` column is `UUID PRIMARY KEY DEFAULT gen_random_uuid()`:

`server/migrations/001_init.up.sql:6` (and ~10 more tables):
```
id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
```
On the wire they are plain UUID strings — `schemas.ts` types every `id` as
`z.string()` (e.g. `IssueSchema.id`, `schemas.ts:444`; `SquadSchema.id`,
`schemas.ts:1126`; `LabelSchema.id`, `schemas.ts:52`). The Go side round-trips
via `uuidToString` (`server/internal/handler/handler.go:362`) and rejects
non-UUIDs at the boundary with `parseUUIDOrBadRequest`.

**Numeric (integer) identifiers DO exist — they are not UUIDs.** Three distinct
uses, all `z.number()` / Go integer:

| field | type | citation |
|-------|------|----------|
| `issue.number` | `z.number()` | `schemas.ts:446` (`number: z.number(),`); DB `issue.number INT` |
| `issue.position` | `z.number()` | `schemas.ts:458`; fixtures seed `position ?? index + 1` (`e2e/fixtures.ts:289`) |
| `issue.stage` | `z.number().nullable()` | `schemas.ts:461` |
| `task.priority` | `int32` / `z.number()` | `AgentTaskResponse.Priority int32` (`agent.go:287`); `AgentTaskSchema.priority z.number()` (`schemas.ts:888`) |
| `workspace.issue_counter` | integer (DB) | `e2e/fixtures.ts:227-234` reserves a range atomically |

`issue.number` plus the workspace `issue_prefix` compose the human `identifier`
string (e.g. `MUL-43`) — `identifier` itself is a `z.string()` (`schemas.ts:447`).

**Prefixed/token string IDs — yes, four prefixes, all auth-machine credentials
(NOT entity IDs):**

| prefix | meaning | minted at | citation |
|--------|---------|-----------|----------|
| `mdt_` | daemon token (`mdt_` + 40 hex) | `GenerateDaemonToken` | `server/internal/auth/jwt.go:40-46` |
| `mat_` | agent task-scoped token (`mat_` + 40 hex) | `GenerateAgentTaskToken` | `server/internal/auth/jwt.go:49-59` |
| `mul_` | personal access token (PAT) | (PAT flow; ref `server/internal/auth/cloud_pat.go:27`) | — |
| `mcn_` | cloud-node PAT | ref `server/internal/handler/personal_access_token.go:156`, `actor_guards.go:34` | — |

These appear as the `Authorization: Bearer <prefix>...` value and are hashed
server-side (`HashToken`, `jwt.go:63`). They never appear as a JSON entity `id`
field. **Irregularity (med confidence, genuine domain distinction):** the same
"authenticated actor" concept is represented by four different token prefixes
depending on what the caller *is* (daemon / agent-task / human-PAT /
cloud-node); a client that only models `Bearer <jwt>` will mis-classify three
of them.

---

## B. TIMESTAMP FORMAT

**Timestamps are RFC3339 strings everywhere on responses.** The single
serializer is:

`server/internal/util/pgx.go:80-84`:
```
func TimestampToString(t pgtype.Timestamptz) string {
    ...
    return t.Time.Format(time.RFC3339)
```
`schemas.ts` types every timestamp field as `z.string()` (e.g.
`IssueSchema.created_at`, `schemas.ts:470`; `SquadSchema.created_at`,
`schemas.ts:1134`). **No unix integers, no `time.Time` structs leak to the
wire.** Dates (`start_date`, `due_date`) are date-only `"YYYY-MM-DD"` — see
`packages/core/types/issue.ts:56-60` comment ("no time, no timezone") and
`DateToPtr` (`pgx.go:98`); the parser also accepts a full RFC3339 timestamp for
back-compat (`pgx.go:109-120`).

**"Unset time" is represented three different ways — this is the irregularity:**

1. **`null`** — the dominant convention for nullable timestamps on responses.
   Go uses `*string` (nil → `null`), no `omitempty`. Examples:
   - `IssueSchema.start_date: z.string().nullable()` / `due_date` (`schemas.ts:462-463`)
   - `AgentTaskResponse.DispatchedAt *string json:"dispatched_at"` (`agent.go:288`, no omitempty → emitted as `null`)
   - `UserSchema.onboarded_at: z.string().nullable()` (`schemas.ts:1416`)
   - `CommentResponse.ResolvedAt *string json:"resolved_at"` (`comment.go:34`)

2. **Omitted (field absent)** — when the Go field has `omitempty` AND is a nil
   pointer. Examples:
   - `AutopilotListItemSchema.last_run_at: z.string().nullable().optional()` (`schemas.ts:1303`)
   - `CommentResponse.SourceTaskID *string json:"source_task_id,omitempty"` (`comment.go:37`)
   - `CommentResponse.LastActivityAt *string json:"last_activity_at,omitempty"` (`comment.go:47`)

3. **Empty string `""`** — for fields whose DB column is `TEXT NOT NULL DEFAULT ''`,
   so "unset" is `""`, never `null`. Example:
   - `UserSchema.profile_description: z.string().default("")` (`schemas.ts:1420`) — comment explicitly: *"server emits `""` when unset (NOT NULL DEFAULT '')"*.
   - `WebhookDelivery.available_at: z.string().default("")` (`schemas.ts:1252`) — *not* nullable, unlike its sibling `received_at` (`z.string()`, `schemas.ts:1258`).

**Irregularity (high confidence, Go/DB artifact):** within the *same*
`CommentResponse` struct (`comment.go:24-69`), `parent_id` is always emitted as
`null` when unset (`json:"parent_id"`, no omitempty, line 31) while
`source_task_id` is **omitted** when unset (`json:"source_task_id,omitempty"`,
line 37) — both are nullable strings, both model "no value", three lines apart.
A Haskell decoder must treat `null`-or-absent as the same `Maybe` for
`source_task_id` but expect `parent_id` to always be present. See §E.

---

## C. ENUM REPRESENTATION

**On the wire, every enum is a JSON string.** Confirmed at the DB layer by
`CHECK (... IN (...))` constraints, and at the TS/zod layer by `z.string()`.
The zod schemas intentionally do NOT use `z.enum()` — `schemas.ts:196-199`:
> *"String enums are stored as `z.string()` rather than `z.enum([...])`. A new
> server-side enum value should render as a fallback in the UI, never crash a
> `safeParse`."*

The **canonical allowed values** (DB CHECK = ground truth; TS unions mirror
them exactly):

| enum | allowed values | DB CHECK | TS union |
|------|----------------|----------|----------|
| `issue.status` | `backlog` `todo` `in_progress` `in_review` `done` `blocked` `cancelled` | `001_init.up.sql:58` | `types/issue.ts:4-11` |
| `issue.priority` | `urgent` `high` `medium` `low` `none` | `001_init.up.sql:59-60` | `types/issue.ts:13` |
| `member.role` | `owner` `admin` `member` | `001_init.up.sql:30` | — |
| `task.status` | `queued` `dispatched` `running` `waiting_local_directory` `completed` `failed` `cancelled` | `109_agent_task_waiting_local_directory.up.sql:15` (extends original `001:132`) | — |
| `project.status` | `planned` `in_progress` `paused` `completed` `cancelled` | `034_projects.up.sql:9` | — |
| `autopilot.status` | `active` `paused` `archived` | `042_autopilot.up.sql:13` | — |
| `autopilot_run.status` | `issue_created` `running` `completed` `failed` `skipped` | `079_autopilot_run_skipped_status.up.sql:9` | — |
| `chat_session.status` | `active` `archived` | `033_chat.up.sql:12` | — |
| `webhook_delivery.status` | `queued` `dispatched` `rejected` `ignored` `failed` | `093_webhook_deliveries.up.sql:56` | — |
| `workspace_invitation.status` | `pending` `accepted` `declined` `expired` | `041_workspace_invitation.up.sql:8` | — |
| `runtime.status` | `online` `offline` | `004_agent_runtime_loop.up.sql:8` | — |
| `dispatch.status` (trigger outcomes) | `queued` `coalesced` `deferred` `blocked` | `admission.go:33-41` | — |

**TS-side narrowed unions** (client reference values; the wire is still `string`):
- `IssueStatus` / `IssuePriority` — `packages/core/types/issue.ts:4-13`
- `IssueAssigneeType = "member" | "agent" | "squad"` — `types/issue.ts:15`
- `TestIssueStatus` / `TestIssuePriority` (e2e) — `e2e/fixtures.ts:22-31`

**Irregularity (high confidence, genuine domain distinction + DB artifact):**
`issue.priority` is a **string enum** (`urgent..none`) but `task.priority` is an
**integer** (`AgentTaskResponse.Priority int32`, `agent.go:287`; DB `priority
INT NOT NULL DEFAULT 0`, `001_init.up.sql:133`). Two resources, same word
"priority", two different types. A Haskell client needs two distinct types.

**Open-ended enums (deliberately `z.string()`, not a missing constraint):**
`assignee_type`, `creator_type`, `author_type`, `actor_type`, `status` (in
Issue/AgentTask/Squad/Autopilot/User schemas), `severity`, `signature_status`,
`provider`, `tx_type`, `source`, `member_type`, `target_type` — all `z.string()`
in `schemas.ts`. The two genuine `z.enum()` literals are narrow-UI facets:
`IssueTableGroupValueSchema.value_state: z.enum(["value","unavailable","unset"])`
(`schemas.ts:605,611`) and `IssueTableFacetSchema.kind: z.enum(["status",
"priority","assignee","creator","project","label","property"])` (`schemas.ts:667`).

---

## D. ASSIGNEE POLYMORPHISM — AND EVERY OTHER `*_type` + `*_id` PAIR

**Confirmed: `assignee_type` ∈ {`member`, `agent`, `squad`} on issues.**
`packages/core/types/issue.ts:15`:
```
export type IssueAssigneeType = "member" | "agent" | "squad";
```
DB allows any text but the service branches on exactly those three:
`server/internal/service/task.go:3439-3441`:
```
case issue.AssigneeType.String == "agent" && issue.AssigneeID.Valid:
case issue.AssigneeType.String == "squad" && issue.AssigneeID.Valid:
```
On the wire both halves are nullable together — `IssueSchema` (`schemas.ts:452-453`):
```
assignee_type: z.string().nullable(),
assignee_id:   z.string().nullable(),
```

**The polymorphism pattern is REUSED EVERYWHERE — but with at least fifteen
different field-name vocabularies and three different allowed-type sets.** This
is the headline irregularity for a Haskell sum-type design. Full inventory:

| # | pair | allowed types | citation |
|---|------|---------------|----------|
| 1 | `assignee_type` / `assignee_id` | member, agent, squad | `issue.go:41`; `schemas.ts:452-453`; `types/issue.ts:15` |
| 2 | `assignee_type` / `assignee_id` (autopilot) | **agent, squad** (no member) | `autopilot.go:40`; `analytics/events.go:368`; default `"agent"` `schemas.ts:1296` |
| 3 | `creator_type` / `creator_id` | member, agent | `issue.go:43`; `service/issue.go:61,439`; TS reuses `IssueAssigneeType` (`types/issue.ts:47`) |
| 4 | `created_by_type` / `created_by_id` (autopilot) | member, agent | `autopilot.go:45`; `schemas.ts:1301-1302` |
| 5 | `author_type` / `author_id` (comment) | member, agent | `comment.go:27-28`; `attribution.go:181` |
| 6 | `resolved_by_type` / `resolved_by_id` (comment) | (actor) | `comment.go:35-36` |
| 7 | `actor_type` / `actor_id` (reaction, timeline, activity) | member, agent, system | `reaction.go:18`; `schemas.ts:222-223,285-286`; `events/bus.go:12` |
| 8 | `user_type` / `user_id` (subscriber) | (actor — vocabulary "user") | `subscriber.go:15`; `schemas.ts:686-687` |
| 9 | `member_type` / `member_id` (squad member) | member, agent | `squad.go:40,53`; `schemas.ts:1120-1121` |
| 10 | `lead_type` / `lead_id` (project) | (actor) | `project.go:30`; `schemas.ts:528-529` |
| 11 | `uploader_type` / `uploader_id` (attachment) | (actor) | `file.go:64`; `EMPTY_ATTACHMENT schemas.ts:265-266` |
| 12 | `recipient_type` / `recipient_id` (inbox) + `actor_type` | (actor) | `inbox.go:19,30`; `schemas.ts:1476-1477` |
| 13 | `target_type` / `target_id` (comment trigger outcome, agent invocation target) | agent, squad | `comment.go:77-78`; `agent_permission.go:18`; `schemas.ts:403-404,1050-1053` |
| 14 | `published_by_type` / `published_by_id` (skill/trigger publish) | member, agent | `service/task.go:517,541` |
| 15 | `trigger_author_type` (task) | agent, member | `agent.go:327` |

**And two pair-shapes that point at ENTITIES, not actors:**

| # | pair | allowed types | citation |
|---|------|---------------|----------|
| 16 | `item_type` / `item_id` (pin) | **issue, project** | `pin.go:20,39`; validated `pin.go:87` (`"item_type must be 'issue' or 'project'"`) |
| 17 | `type` / `id` (DispatchTarget — **bare, no prefix!**) | agent, squad | `admission.go:69-73`: `Type string json:"type"` / `ID string json:"id"` |

**Irregularity (high confidence, genuine domain distinction expressed through an
inconsistent vocabulary):** the same polymorphic-actor relation is spelled
`assignee` / `creator` / `author` / `actor` / `user` / `member` / `lead` /
`uploader` / `recipient` / `target` / `published_by` / `trigger_author` /
`created_by` / `resolved_by`. The allowed type set is *not* uniform either:
issue assignee allows `member|agent|squad`; autopilot assignee allows only
`agent|squad`; comment author allows `member|agent`; reaction actor adds
`system`. A single `ActorRef { type :: ActorType, id :: UUID }` Haskell type
will lie unless it is parameterised by the allowed-type set per field.

**Irregularity (high confidence, Go-handler artifact):** `DispatchTarget`
(`admission.go:69-73`) uses **bare `type` / `id`** with no prefix, while every
other instance uses `*_type` / `*_id`. Same concept, different shape — a
decoder keyed on `<prefix>_type` will miss it.

---

## E. NULL vs EMPTY vs ABSENT

Three conventions coexist; which one a field uses is **not predictable from its
type**, only from the Go struct tag:

| representation | Go form | when used | example |
|----------------|---------|-----------|---------|
| `null` | `*string` (nil), **no** `omitempty` | nullable scalar, always emitted | `CommentResponse.ParentID` `comment.go:31`; `WorkspaceResponse.Description *string` `workspace.go:41` |
| omitted (absent) | `*string`/`*int`/`*bool` (nil) **with** `omitempty` | optional additive field | `CommentResponse.SourceTaskID` `comment.go:37`; `AgentTaskResponse.WorkspaceContext` `agent.go:284` |
| empty string `""` | `string` (zero value) | `TEXT NOT NULL DEFAULT ''` column | `UserSchema.profile_description` `schemas.ts:1420` |
| empty array `[]` | slice forced non-nil | collection that must iterate safely | `CommentResponse.Reactions`/`Attachments` `comment.go:84-89` (`if reactions == nil { reactions = []ReactionResponse{} }`) |

**Concrete divergences:**

1. **Within one struct, two nullable strings use different null strategies**
   (highest-signal irregularity). `CommentResponse` (`comment.go:24-69`):
   ```
   ParentID       *string `json:"parent_id"`           // → null when unset
   SourceTaskID   *string `json:"source_task_id,omitempty"` // → absent when unset
   ```
   The zod side papers over this — `CommentSchema.parent_id: z.string().nullable()`
   and `source_task_id: z.string().nullable().optional()` (`schemas.ts:381,386`).
   A Haskell decoder must accept `null | absent | string` for both, even though
   the server never emits one of the combinations for each. **(high confidence,
   Go-handler artifact — driven by per-field `omitempty` choices, not domain.)**

2. **`description` is `null` on Issue but `""`-able on User.** Issue:
   `IssueSchema.description: z.string().nullable()` (`schemas.ts:449`). User:
   `profile_description: z.string().default("")` (`schemas.ts:1420`). Same
   concept ("free text, maybe empty"), opposite null strategy. **(med
   confidence, DB artifact — column nullability differs between tables.)**

3. **Collections are never `null` on responses** — handlers coerce nil slices
   to `[]` (`comment.go:84-89`; `ListWorkspaces` builds `make([]..., len)`
   `workspace.go:111`). But on **requests**, omitted arrays vs `[]` vs `null`
   carry different semantics in some handlers (e.g. batch endpoints). The zod
   default-`[]` rule (`schemas.ts:202-203`) means a missing `reactions` field
   decodes to `[]`, hiding whether the server omitted it.

4. **`IssueSchema.metadata` and `.properties` are always present** (default
   `{}`), never null/absent — `schemas.ts:464-467`, comment at `schemas.ts:440`.
   Diverges from `stage`, which is `z.number().nullable().default(null)`
   (`schemas.ts:461`) — "missing" decodes to `null`, not `0`.

---

## F. MUTATION RESPONSE SHAPES

**Create/Update return the full resource object; Delete returns `204 No
Content`.** But list-wrappers, action endpoints, and quick-create diverge.

| operation | returns | status | citation |
|-----------|---------|--------|----------|
| Create issue | full `IssueResponse` | **201** | `issue.go:2671` `writeJSON(w, http.StatusCreated, resp)` |
| Update issue | full `IssueResponse` | 200 | `issue.go:2983` `writeJSON(w, http.StatusOK, resp)` |
| Delete issue | **nothing** | **204** | `issue.go:3190` `w.WriteHeader(http.StatusNoContent)` |
| Create workspace | full `WorkspaceResponse` | 201 | `workspace.go:241` |
| Create squad | full `SquadResponse` | 201 | `squad.go:317` |
| Delete squad | nothing | 204 | `squad.go:480` |
| Create label | full label | 201 | `label.go:246` |
| Delete label | nothing | 204 | `label.go:373` |
| Create pin | full `PinnedItemResponse` | 201 | `pin.go:151` |
| Delete pin | nothing | 204 | `pin.go:187` |
| Create project | full project | 201 | `project.go:358` |
| Delete project | nothing | 204 | `project.go:597` |
| Create runtime-profile | full profile | 201 | `runtime_profile.go:201` |
| Delete runtime-profile | nothing | 204 | `runtime_profile.go:522` |
| Update member role | full `memberWithUserResponse` | 200 | `workspace.go:615` |

`e2e/fixtures.ts` confirms create-issue returns the bare object (no envelope) —
`createIssue` reads `issue.id` straight off the response (`e2e/fixtures.ts:187-195`).

**Irregularities (the action / quick endpoints break the "full object" pattern):**

1. **Subscribe / unsubscribe return `{subscribed: bool}`, not the resource.**
   `subscriber.go:105` `writeJSON(w, http.StatusOK, map[string]bool{"subscribed": true})`
   and `:158` `{"subscribed": false}`. **(high confidence, genuine domain
   distinction — the call's truth is a boolean, not a resource.)**

2. **Quick-create returns `{task_id}` with HTTP 202 Accepted**, not the issue
   (the issue does not exist yet — a task will create it). `issue.go:2277`:
   ```
   writeJSON(w, http.StatusAccepted, QuickCreateIssueResponse{TaskID: uuidToString(task.ID)})
   ```
   **(high confidence, genuine domain distinction — async handoff.)**

3. **Create-from-template returns a wrapper, not the agent.**
   `CreateAgentFromTemplateResponseSchema = { agent, imported_skill_ids,
   reused_skill_ids }` (`schemas.ts:1073-1077`). **(med confidence, genuine —
   side-effects need to be reported alongside.)**

4. **`writeJSON` always appends a trailing newline** to the body
   (`handler.go:319` `body = append(body, '\n')`) and sets an exact
   `Content-Length`. A strict Haskell decoder that rejects trailing whitespace
   outside the JSON value will fail every response. **(high confidence,
   Go-handler artifact — mirrors `json.Encoder.Encode` historical behaviour.)**

---

## G. ERROR SHAPE

**The default error body is `{"error": "<message>"}` — a single string, no
code, no field, no structure.** Two independent writers produce the identical
shape:

`server/internal/handler/handler.go:345-347`:
```
func writeError(w http.ResponseWriter, status int, msg string) {
    writeJSON(w, status, map[string]string{"error": msg})
}
```
`server/internal/middleware/workspace.go:152-156` (middleware-local copy,
hand-written bytes):
```
w.Write([]byte(`{"error":"` + msg + `"}`))
```
The HTTP status code carries the class; the body carries only an English
string. There is **no `code` field, no `errors[]` array, no `details` map** in
the default path.

**Irregularity (high confidence, genuine domain distinction): TWO structured
error shapes exist on top of the default, for specific cases where the client
must branch:**

1. **Duplicate-issue conflict (409 on POST `/api/workspaces/:wsId/issues`)** —
   `DuplicateIssueErrorBodySchema` (`schemas.ts:1208-1216`):
   ```
   { code: "active_duplicate_issue", error?: string, issue: { id, identifier, title } }
   ```
   `code` is a `z.literal` (drift fails the parse). Emitted at `issue.go:2636`
   (`writeJSON(w, http.StatusConflict, map[string]any{...})`).

2. **Dispatch-blocked (403/409 on sync trigger)** — `dispatchBlockedResponse`
   (`admission.go:91-94`):
   ```
   { error: string, reason_code: DispatchReasonCode }
   ```
   `reason_code` ∈ {`invocation_not_allowed`, `target_unavailable`,
   `runtime_offline`, `attribution_blocked`, `already_active`,
   `self_trigger_suppressed`, `internal_error`, ...} (`admission.go:56-62`).

**Net:** a Haskell error type must model `DefaultError { error :: Text }` AND
detect/decode the two structured bodies by shape (presence of `code` /
`reason_code`). **(med confidence — the default is a Go-handler artifact
[minimal helper]; the two structured bodies are genuine domain distinctions
that grew because the client needed to branch.)**

---

## H. WORKSPACE SCOPING MECHANISM

**Workspace is conveyed by header, by query param, by URL path param, OR by
task-token binding — four channels, with a documented priority order.** The
authoritative resolver is `ResolveWorkspaceIDFromRequest`,
`server/internal/middleware/workspace.go:54-61`:
```
// Priority:
//  1. task-token binding (X-Actor-Source == "task_token") — authoritative
//  2. middleware-injected context (fast path)
//  3. X-Workspace-Slug header → GetWorkspaceBySlug → UUID
//  4. ?workspace_slug query
//  5. X-Workspace-ID header (CLI/daemon compat)
//  6. ?workspace_id query
```
Header names: `X-Workspace-Slug` and `X-Workspace-ID` (both registered in the
CORS allowed-headers list, `router.go:60-61`).

**Frontend path (slug):** the TS client sets the slug header on every request.
`packages/core/api/client.ts:412-413`:
```
const slug = getCurrentSlug();
if (slug) headers["X-Workspace-Slug"] = slug;
```
`getCurrentSlug` is imported from platform workspace-storage
(`client.ts:171`). Per-call override (notification-preferences cross-workspace
fetch): `client.ts:1819,1835-1836` sets `{ "X-Workspace-Slug": workspaceSlug }`.

**E2E confirms both headers are sent and prioritised** — `e2e/fixtures.ts:361-362`:
```
if (this.workspaceSlug) headers["X-Workspace-Slug"] = this.workspaceSlug;
else if (this.workspaceId) headers["X-Workspace-ID"] = this.workspaceId;
```

**URL-path channel:** `RequireWorkspaceMemberFromURL(queries, "id")`
(`workspace.go:173-181`) reads the workspace id from a chi URL param. The
router mounts this on `/api/workspaces/{id}/...` routes
(`router.go:862,923,941`) — so a request to `/api/workspaces/<uuid>/members`
is scoped by the path `{id}`, NOT by header.

**Which endpoints read workspace from URL vs header:**
- **From URL `{id}` param** (via `RequireWorkspaceMemberFromURL`): everything
  under `/api/workspaces/{id}/...` — members, runtime-profiles, invitations,
  github/lark/slack installations (`router.go:856-941`).
- **From header/query** (via `RequireWorkspaceMember` / `resolveWorkspaceUUID`):
  all the top-level workspace-scoped routes — `/api/issues`, `/api/agents`,
  `/api/squads`, `/api/projects`, `/api/labels`, `/api/autopilots`, `/api/pins`,
  `/api/dashboard`, `/api/runtimes`, `/api/chat`, `/api/inbox`, etc.
  (`router.go:1030` mounts `RequireWorkspaceMember` over the big group).
- **Task-token binding (authoritative, override-all):** when
  `X-Actor-Source == "task_token"` (set by auth from an `mat_` token), the
  workspace stamped on the token wins and every other channel is ignored
  (`workspace.go:75-77,119-125,214-220`). This is the agent sandbox.

**Irregularity (high confidence, genuine security distinction expressed as
scoping heterogeneity):** the same logical fact "which workspace" is read from
4 different places depending on route family, and for agent-task traffic the
client's headers are deliberately ignored. A Haskell client must (a) always
send `X-Workspace-Slug` for human traffic, (b) never try to widen scope for
task-token traffic, (c) know that `/api/workspaces/{id}/...` routes want the
id in the path.

---

## I. THE TWO SEEDS — CONFIRMED, PLUS THE FULLER PICTURE

### I.1 Bare-array vs envelope lists

**Confirmed: `/api/workspaces` is bare-array; `/api/issues` is envelope.**

- **Bare array** — `ListWorkspaces` (`workspace.go:111-116`):
  ```
  resp := make([]WorkspaceResponse, len(workspaces))
  ...
  writeJSON(w, http.StatusOK, resp)   // → [ {...}, {...} ]
  ```
  Confirmed live by `e2e/fixtures.ts:116-119` (`getWorkspaces(): Promise<TestWorkspace[]>`).

- **Envelope** — `ListIssues` (`issue.go:1269-1271`):
  ```
  writeJSON(w, http.StatusOK, map[string]any{
      "issues": ...,
      "total":  total,
  })
  ```
  zod: `ListIssuesResponseSchema = { issues: [...], total: number }`
  (`schemas.ts:474-477`).

**The split is NOT binary — the surface has both conventions scattered across
resources, and the envelope key name is itself inconsistent:**

| resource | list shape | key | citation |
|----------|-----------|-----|----------|
| workspaces | **bare array** | — | `workspace.go:111-116` |
| squads | **bare array** | — | `squad.go:217-222`; `SquadListSchema = z.array` `schemas.ts:1142` |
| comments | **bare array** | — | `CommentsListSchema = z.array` `schemas.ts:389` |
| timeline | **bare array** | — | `TimelineEntriesSchema = z.array` `schemas.ts:303` |
| subscribers | **bare array** | — | `subscriber.go:45-50`; `SubscribersListSchema = z.array` `schemas.ts:692` |
| dashboard / runtime usage / inbox / cloud nodes / agent tasks | **bare array** | — | `schemas.ts:756,769,807,914,1449,1471` |
| issues | envelope | `issues` + `total` | `issue.go:1269` |
| search issues | envelope | `issues` + `total` | `issue.go:752` |
| labels | envelope | `labels` + `total` | `label.go:168` |
| projects | envelope | `projects` + `total` | `project.go:171` |
| search projects | envelope | `projects` + `total` | `schemas.ts:547-550` |
| autopilots | envelope | `autopilots` + `total` | `schemas.ts:1315-1318` |
| webhook deliveries | envelope | `deliveries` + `total` | `schemas.ts:1268-1271` |
| properties | envelope | `properties` + `total` | `schemas.ts:132-135` |
| runtime-profiles | envelope | **`runtime_profiles`** (no total) | `runtime_profile.go:225` |
| labels-on-resource | envelope | `labels` (no total) | `label.go:420,491,552` |
| grouped issues | envelope | `groups` | `issue.go:1861`; `schemas.ts:565-567` |
| squad member status | envelope | `members` | `schemas.ts:1180-1182` |
| chat draft restores | envelope | `restores` | `schemas.ts:949-951` |

**Irregularity (high confidence, Go-handler artifact):** there is no rule that
says which lists are bare vs enveloped. The envelope key is the resource
plural in most cases, but `runtime-profiles` uses `runtime_profiles`
(snake_case of the compound) and some envelopes omit `total`. The
`AgentTemplateSummaryListSchema` (`schemas.ts:1006-1011) accepts **both** a
bare array and `{templates: [...]}` because the server "historically returns a
bare array" and the schema hedges against a future migration — direct evidence
that the maintainers know this is inconsistent.

### I.2 Resources only reachable nested under a parent

**Confirmed: members live under `/api/workspaces/{id}/members`** — there is no
top-level `/api/members` route. A grep for `/api/members` in `router.go` and
`client.ts` returns nothing; the only member routes are mounted inside the
`/api/workspaces` group (`router.go:864` `r.Get("/members",
h.ListMembersWithUser)`, `router.go:883-888`).

**Other resources only reachable nested under a parent:**

| nested resource | parent route | citation |
|-----------------|--------------|----------|
| members | `/api/workspaces/{id}/members` | `router.go:864,883` |
| invitations (as member mgmt) | `/api/workspaces/{id}/members` (create) + `/api/workspaces/{id}/invitations` | `router.go:883,881` |
| runtime-profiles | `/api/workspaces/{id}/runtime-profiles` | `router.go:875,890` |
| comments | `/api/issues/{id}/comments` | `router.go:1059-1060` |
| timeline | `/api/issues/{id}/timeline` | `router.go:1061` |
| subscribers | `/api/issues/{id}/subscribers` | `router.go:1062` |
| issue labels | `/api/issues/{id}/labels` | `router.go` (api.md §5.10) |
| issue metadata | `/api/issues/{id}/metadata` | `router.go` (api.md §5.11) |
| issue attachments | `/api/issues/{id}/attachments` | api.md §23 |
| squad members | `/api/squads/{id}/members` | `router.go:1134-1138` |
| project resources | `/api/projects/{id}/resources` | api.md §8 |
| github / lark / slack installations | `/api/workspaces/{id}/{github,lark,slack}` | `router.go` / api.md §24-26 |

**Half-exception (mixed):** a single comment IS reachable top-level for
mutation (`/api/comments/{commentId}` for PUT/DELETE/resolve/reactions,
`router.go:1191`) but the **list** of comments is only reachable nested under
the issue. Same for `/api/attachments/{id}` (top-level lookup) vs
`/api/issues/{id}/attachments` (nested list).

**Irregularity (med confidence, mixed):** the daemon has its OWN parallel
nested surface under `/api/daemon/workspaces/{id}/...`
(`/api/daemon/workspaces/{id}/repos`, `/api/daemon/workspaces/{id}/runtime-profiles`,
`router.go:775` and api.md §29.2) — same resources, different (daemon-auth)
route tree.

---

## SUMMARY — the irregularities a Haskell mirror must encode

1. **Polymorphic actor refs under ~15 different names** (assignee / creator /
   author / actor / user / member / lead / uploader / recipient / target /
   published_by / trigger_author / created_by / resolved_by), with **three
   different allowed-type sets** and **one bare `type`/`id`** outlier
   (`DispatchTarget`). (§D)
2. **`priority` is a string enum on issues but an integer on tasks.** (§C)
3. **List responses are bare-array OR envelope, with no rule**, and the
   envelope key is inconsistent (`runtime_profiles` vs `properties`). (§I.1)
4. **"No value" is `null`, omitted, `""`, or `[]` depending on the field** —
   sometimes within the same struct (`CommentResponse.parent_id` vs
   `source_task_id`). (§B, §E)
5. **Error body is `{"error": string}` by default, but two structured shapes
   (`{code,error,issue}` and `{error,reason_code}`) exist for branchable
   cases.** (§G)
6. **Workspace scoping has 4 channels** (slug header, id header, URL `{id}`
   param, task-token binding) with a strict priority; agent-task traffic
   ignores client headers. (§H)
7. **Mutation returns the full object (201/200) or 204 for delete, but
   subscribe returns `{subscribed: bool}`, quick-create returns `{task_id}`
   with 202, and create-from-template wraps in `{agent, ...}`.** (§F)
8. **Every response body ends with a trailing `\n`.** (§F.4)
9. **Members, comments-list, timeline, runtime-profiles, squad-members are only
   reachable nested under a parent**; there is no top-level `/api/members`. (§I.2)

All nine are facts about the surface, recorded as-is.
