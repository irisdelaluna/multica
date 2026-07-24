# Multica Realtime WebSocket + Client Cache Semantics

> Generated from survey of:
> - `packages/core/types/events.ts` (~88 WSEventType union + payloads)
> - `packages/core/api/ws-client.ts` (auth handshake, reconnect)
> - `packages/core/realtime/use-realtime-sync.ts` (~1460 lines, central WS sync)
> - `packages/core/issues/ws-updaters.ts` (~446 lines, issue cache patches)
> - `packages/core/inbox/ws-updaters.ts` (~72 lines, inbox cache patches)
> - `CLAUDE.md` state rules (line 42: self-initiated guard)

---

## 1. WebSocket Protocol Overview

### 1.1 Connection Lifecycle

```
Browser ──WebSocket Upgrade──► Server
     │
     ├─ Query Params: workspace_slug, client_platform, client_version, client_os
     ├─ Auth (token mode): First message {type: "auth", payload: {token}}
     └─ Auth (cookie mode): HttpOnly cookie sent automatically

Server ──auth_ack──► Client (connection active)
```

**Key constraints** (from `ws-client.ts`):
- Token is **never** sent as URL query parameter (logged by proxies/CDNs/browser history)
- Reconnect uses exponential backoff with jitter (1s base → 30s cap) to avoid thundering herd
- Frame validation: every message must be an object with string `type`; malformed frames drop silently

### 1.2 Reconnect Behavior

| Aspect | Implementation |
|--------|----------------|
| Backoff | Exponential with ±20% jitter |
| Max delay | 30 seconds |
| Retry limit | Unlimited (UI doesn't expose manual retry) |
| On reconnect | Fires `onReconnect` callbacks → invalidates workspace-scoped queries |

---

## 2. Event Catalog by Domain

### 2.1 Issues (`issue:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `issue:created` | `IssueCreatedPayload` | **Invalidate**: list, flat, table, assigneeGroups, myAssigneeGroups; **Patch**: buckets via `onIssueCreated` | Server flags: none |
| `issue:updated` | `IssueUpdatedPayload` | **Patch**: in-place via `onIssueUpdated` with coordinator; **Invalidate**: stale keys, derivatives | Server flags: `assignee_changed`, `status_changed`, `project_changed` |
| `issue:deleted` | `IssueDeletedPayload` | **Cleanup**: `cleanupDeletedIssueCaches` + invalidate groups | Cascades to inbox |
| `issue_labels:changed` | `IssueLabelsChangedPayload` | **Patch**: labels in buckets, flat, table, detail, byIssue; **Invalidate**: children, myAll, groups | Full label snapshot in payload |
| `issue_metadata:changed` | `IssueMetadataChangedPayload` | **Patch**: metadata in buckets, flat, table, detail; **Invalidate**: myAll, updatedAt-sorted lists | Full metadata bag |
| `issue_properties:changed` | `IssuePropertiesChangedPayload` | **Patch**: properties; **Invalidate**: children, myAll, groups, property-filtered | Full properties bag |

### 2.2 Comments (`comment:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `comment:created` | `CommentCreatedPayload` | **Invalidate**: timeline (refetchType: "none"), updatedAt-sorted issue lists | Bumps parent issue.updated_at |
| `comment:updated` | `CommentUpdatedPayload` | **Invalidate**: timeline (refetchType: "none") | — |
| `comment:deleted` | `CommentDeletedPayload` | **Invalidate**: timeline (refetchType: "none") | — |
| `comment:resolved` | `CommentResolvedPayload` | **Invalidate**: timeline (refetchType: "none") | — |
| `comment:unresolved` | `CommentUnresolvedPayload` | **Invalidate**: timeline (refetchType: "none") | — |

### 2.3 Task Lifecycle (`task:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `task:queued` | `TaskQueuedPayload` | **Set**: `chatKeys.pendingTask` → status "queued" | Triggers aggregate invalidation |
| `task:dispatch` | `TaskDispatchPayload` | **Set**: pendingTask → status "running" | Collapses dispatch→running window |
| `task:running` | `TaskRunningPayload` | **Set**: pendingTask → status "running" | Clears waiting_local_directory |
| `task:waiting_local_directory` | `TaskWaitingLocalDirectoryPayload` | **Set**: pendingTask → status "waiting_local_directory" | Path lock contention |
| `task:completed` | `TaskCompletedPayload` | **Invalidate**: aggregate only | chat:done already cleared pending |
| `task:failed` | `TaskFailedPayload` | **Set**: pendingTask → {}; **Invalidate**: messages, aggregate | FailTask writes failure message |
| `task:cancelled` | `TaskCancelledPayload` | **Set**: pendingTask → {}; **Invalidate**: messages, aggregate | — |
| `task:progress` | `unknown` | *(no handler)* | Reserved for future use |
| `task:message` | `TaskMessagePayload` | **Set**: `chatKeys.taskMessages` via `mergeTaskMessagesBySeq` | Per-message stream, no aggregate invalidate |

### 2.4 Chat (`chat:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `chat:message` | `ChatMessageEventPayload` | **Invalidate**: messages, pendingTask | Does NOT touch aggregate (MUL-4159) |
| `chat:done` | `ChatDonePayload` | **Set**: messages (inline insert), pendingTask → {}; **Invalidate**: messages (reconcile) | Inline assistant message |
| `chat:cancel_finalized` | `ChatCancelFinalizedPayload` | **Conditional**: "stopped" → applyChatDone; "restored" → removeMessage + invalidate draftRestores (if initiator) | Deferred outcome (#5219) |
| `chat:session_read` | `ChatSessionReadPayload` | **Invalidate**: sessions list | — |
| `chat:session_updated` | `ChatSessionUpdatedPayload` | **Patch**: session row inline (title, pinned, status, unread) | Archive zeros unread_count |
| `chat:session_deleted` | `ChatSessionDeletedPayload` | **Set**: sessions list (filter out); **Remove**: messages/pending queries; **Clear**: activeSessionId in Zustand (with guard) | Zustand write: single responder |

### 2.5 Inbox (`inbox:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `inbox:new` | `InboxNewPayload` | **Invalidate**: inbox list, unread summary; **Side effect**: system notification | Cross-workspace summary update |
| `inbox:read` | `InboxReadPayload` | **Invalidate**: inbox list, unread summary | — |
| `inbox:archived` | `InboxArchivedPayload` | **Invalidate**: inbox list, unread summary | — |
| `inbox:unarchived` | `InboxUnarchivedPayload` | **Invalidate**: inbox list, unread summary | — |
| `inbox:batch-read` | `InboxBatchReadPayload` | **Invalidate**: inbox list, unread summary | — |
| `inbox:batch-archived` | `InboxBatchArchivedPayload` | **Invalidate**: inbox list, unread summary | — |

### 2.6 Workspace & Membership (`workspace:*`, `member:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `workspace:updated` | `WorkspaceUpdatedPayload` | **Patch**: workspace list; **Invalidate**: issueKeys.all if prefix changed | — |
| `workspace:deleted` | `WorkspaceDeletedPayload` | **Self-initiated guard**: skip if `isWorkspaceDeletePending`; else clearStorage + relocate | See §3 Self-Initiated Guard |
| `member:added` | `MemberAddedPayload` | **Invalidate**: members list, invitations list; **Toast**: if me | — |
| `member:updated` | `MemberUpdatedPayload` | **Invalidate**: members list | — |
| `member:removed` | `MemberRemovedPayload` | **Conditional**: if me → clearStorage + relocate | — |

### 2.7 Agents (`agent:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `agent:status` | `AgentStatusPayload` | **Invalidate**: agents list, workingAgents, squad members-status | — |
| `agent:created` | `AgentCreatedPayload` | **Invalidate**: agents list | — |
| `agent:archived` | `AgentArchivedPayload` | **Invalidate**: agents list, workingAgents, squad members-status | — |
| `agent:restored` | `AgentRestoredPayload` | **Invalidate**: agents list | — |

### 2.8 Invitations (`invitation:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `invitation:created` | `InvitationCreatedPayload` | **Invalidate**: myInvitations; **Toast** | — |
| `invitation:accepted` | `InvitationAcceptedPayload` | **Invalidate**: invitations, members | — |
| `invitation:declined` | `InvitationDeclinedPayload` | **Invalidate**: invitations | — |
| `invitation:revoked` | `InvitationRevokedPayload` | **Invalidate**: myInvitations | — |

### 2.9 Reactions (`reaction:*`, `issue_reaction:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `reaction:added` | `ReactionAddedPayload` | **Invalidate**: timeline (refetchType: "none") | — |
| `reaction:removed` | `ReactionRemovedPayload` | **Invalidate**: timeline (refetchType: "none") | — |
| `issue_reaction:added` | `IssueReactionAddedPayload` | **Invalidate**: issue reactions | — |
| `issue_reaction:removed` | `IssueReactionRemovedPayload` | **Invalidate**: issue reactions | — |

### 2.10 Activity & Subscribers

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `activity:created` | `ActivityCreatedPayload` | **Invalidate**: timeline (refetchType: "none") | — |
| `subscriber:added` | `SubscriberAddedPayload` | **Invalidate**: issue subscribers | — |
| `subscriber:removed` | `SubscriberRemovedPayload` | **Invalidate**: issue subscribers | — |

### 2.11 Projects (`project:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `project:created` | `ProjectCreatedPayload` | **Invalidate**: projects list | Opaque payload (no formal interface) |
| `project:updated` | `ProjectUpdatedPayload` | **Invalidate**: projects list, issueKeys.all | — |
| `project:deleted` | `ProjectDeletedPayload` | **Invalidate**: projects list, issueKeys.all | — |

### 2.12 Labels & Properties (`label:*`, `property:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `label:created` | `unknown` | **Invalidate**: labels (all scopes), issues, agents, skills | — |
| `label:updated` | `unknown` | **Invalidate**: labels (all scopes), issues, agents, skills | — |
| `label:deleted` | `unknown` | **Invalidate**: labels (all scopes), issues, agents, skills | — |
| `property:created` | `PropertyChangedPayload` | **Invalidate**: property catalog, issue table | Definition change |
| `property:updated` | `PropertyChangedPayload` | **Invalidate**: property catalog, issue table | Definition change |

### 2.13 Squads (`squad:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `squad:created` | `unknown` | **Invalidate**: squads list | — |
| `squad:updated` | `unknown` | **Invalidate**: squads list | — |
| `squad:deleted` | `unknown` | **Invalidate**: squads list, issueKeys.all (assignee transfer) | — |

### 2.14 Daemon & Runtime (`daemon:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `daemon:heartbeat` | `unknown` | *(skipped - no handler)* | Avoids excessive refetch |
| `daemon:register` | `unknown` | **Invalidate**: runtimes list, squad members-status | Runtime came online |

### 2.15 Skills (`skill:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `skill:created` | `unknown` | **Invalidate**: skills list | — |
| `skill:updated` | `unknown` | **Invalidate**: skills list, agents list | — |
| `skill:deleted` | `unknown` | **Invalidate**: skills list, agents list | — |

### 2.16 Pins (`pin:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `pin:created` | `unknown` | **Invalidate**: pins list | — |
| `pin:deleted` | `unknown` | **Invalidate**: pins list | — |
| `pin:reordered` | `unknown` | **Invalidate**: pins list | — |

### 2.17 GitHub Integration (`github_installation:*`, `pull_request:*`)

| Event | Payload | Cache Effect | Notes |
|-------|---------|--------------|-------|
| `github_installation:created` | `unknown` | **Invalidate**: GitHub installations | — |
| `github_installation:deleted` | `unknown` | **Invalidate**: GitHub installations | — |
| `pull_request:linked` | `unknown` | **Invalidate**: PR list for issue | — |
| `pull_request:updated` | `unknown` | **Invalidate**: PR list for issue | — |
| `pull_request:unlinked` | `unknown` | **Invalidate**: PR list for issue | — |

---

## 3. Cache Effect Patterns

### 3.1 Patch vs Invalidate Decision Matrix

| Use Patch When | Use Invalidate When |
|----------------|---------------------|
| Payload carries full updated object | Payload is ID-only or minimal |
| Cache shape matches payload (simple entity) | Cache shape is complex (filtered lists, aggregations) |
| Membership in filtered lists is undecidable client-side | Filter/sort dimensions changed |
| Event is high-frequency (cellular data rule) | Event is rare (cost of refetch is negligible) |
| Optimistic update already showed the change | Need authoritative server state |

### 3.2 The Self-Initiated Guard Pattern

**Rule (from CLAUDE.md line 42)**:
> "WebSocket events invalidate or patch Query cache for server data. They must never mirror server payload data into Zustand; clearing client-owned pointers (active session, selection, current workspace) is allowed only with a single responder and a self-initiated guard when this client can cause the event."

**Implementation: Workspace Delete Example**

```typescript
// packages/core/workspace/pending-delete.ts
const pendingDeletes = new Set<string>();

export function markWorkspaceDeletePending(workspaceId: string) {
  pendingDeletes.add(workspaceId);
}

export function isWorkspaceDeletePending(workspaceId: string): boolean {
  return pendingDeletes.has(workspaceId);
}

// In use-realtime-sync.ts
const unsubWsDeleted = ws.on("workspace:deleted", (p) => {
  const { workspace_id } = p as WorkspaceDeletedPayload;
  // Self-initiated delete: useDeleteWorkspace owns storage cleanup and
  // navigation. Reacting here would race that flow.
  if (isWorkspaceDeletePending(workspace_id)) return;
  // ... handle external delete
});
```

**Why it matters**:
- Mutation flow owns navigation/storage cleanup (runs after DELETE resolves)
- WS handler running simultaneously would cause:
  - CancelledError from in-flight queries
  - Double navigation (race condition)
  - Storage cleanup before navigation completes

**Other self-initiated guards in the codebase**:
- `chat:session_deleted` → checks `useChatStore.getState().activeSessionId`
- Optimistic mutations mark their target IDs; WS handlers skip those IDs

### 3.3 RefetchType: "none" Pattern

Used for timeline invalidation to prevent aggressive refetch:

```typescript
const invalidateTimeline = (issueId: string) => {
  qc.invalidateQueries({
    queryKey: issueKeys.timeline(issueId),
    refetchType: "none",  // ← Only mark stale, don't auto-refetch
  });
};
```

**Why**: Timeline entries render with React.memo. Aggressive refetch replaces all entry references, busting memo and causing visible flash during AI streaming (MUL-1941).

---

## 4. Mobile vs Web Cache Strategy

### 4.1 Cellular Data Rule (Mobile-Only)

From `apps/mobile/CLAUDE.md`:

> "When a WS payload contains the full updated object, **patch** the cache (`setQueryData` / `setQueriesData`). Only fall back to **invalidate** when:
> 1. The payload is ID-only
> 2. The cache shape doesn't match what we can patch
> 3. The event is rare enough that the extra refetch isn't a real cost"

**Web**: Invalidates generously (broadband assumption)
**Mobile**: Patches aggressively (cellular data conservation)

### 4.2 Mobile-Owned Updaters

Mobile maintains its own `apps/mobile/data/realtime/*-ws-updaters.ts` files:
- Do not import web's updaters (different cache shapes, dependency rules)
- Copy the design, adapt to mobile's actual query keys
- Document the mirror at the top of each file

---

## 5. Security Considerations

### 5.1 Chat Aggregate Invalidation (MUL-4159)

**Problem**: Chat `task:*` events are workspace fanouts — every member receives them with no creator/agent visibility in payload.

**Solution**: Never optimistically write the cross-session pending aggregate from these events. Always **invalidate** so it refetches through the permission-filtering endpoint.

```typescript
// WRONG - would leak across users
qc.setQueryData(chatKeys.pendingTasks(wsId), [...]); // ❌

// CORRECT - forces refetch through filtering endpoint
qc.invalidateQueries({ queryKey: chatKeys.pendingTasks(wsId) }); // ✅
```

### 5.2 Draft Restore Invalidation

`chat:cancel_finalized` with `outcome: "restored"` only invalidates `draftRestores` for the **initiator**:

```typescript
const isInitiator =
  !!payload.initiator_user_id &&
  !!currentUserId &&
  payload.initiator_user_id === currentUserId;
if (isInitiator) {
  void qc.invalidateQueries({ queryKey: chatKeys.draftRestores(sessionId) });
}
```

---

## 6. Reconnect & Instance Switch

### 6.1 On Reconnect

All workspace-scoped queries are invalidated:
- Issues, inbox, agents, members, squads, skills, projects, runtimes, autopilots
- Chat sessions, labels, properties
- Cross-workspace: inbox summary, workspace list
- Issue-scoped: timeline, reactions, subscribers, usage, tasks
- Chat-scoped: messages (all sessions), pending tasks, task messages, draft restores

### 6.2 On New WSClient Instance

Detected via ref comparison (`wsInstanceRef`). When workspace switch creates a new client:
- Same invalidation sweep as reconnect
- Skips on first mount to avoid redundant refetch

---

## 7. Event Payload Type Reference

```typescript
// Core message envelope
interface WSMessage<T = unknown> {
  type: WSEventType;
  payload: T;
  actor_id?: string;    // Who triggered the event
  actor_type?: string;  // "member" | "agent" | etc
}

// No self-event filtering by actor_id:
// - actor_id identifies the USER, not the TAB
// - Filtering by actor_id would block other tabs of the same user
// - Instead, use dedup checks to be idempotent
```

**Key insight**: `actor_id`/`actor_type` are **NOT** used for filtering in WS handlers. The self-initiated guard operates on **client-local state** (pendingDeletes Set, mutation markers), not actor identity.

---

## 8. Summary Table: All 88 Event Types

| # | Event | Payload Type | Cache Effect |
|---|-------|--------------|--------------|
| 1 | `issue:created` | `IssueCreatedPayload` | Patch buckets + invalidate lists |
| 2 | `issue:updated` | `IssueUpdatedPayload` | Patch via coordinator + invalidate stale |
| 3 | `issue:deleted` | `IssueDeletedPayload` | Cleanup + invalidate groups |
| 4 | `comment:created` | `CommentCreatedPayload` | Invalidate timeline (none) |
| 5 | `comment:updated` | `CommentUpdatedPayload` | Invalidate timeline (none) |
| 6 | `comment:deleted` | `CommentDeletedPayload` | Invalidate timeline (none) |
| 7 | `comment:resolved` | `CommentResolvedPayload` | Invalidate timeline (none) |
| 8 | `comment:unresolved` | `CommentUnresolvedPayload` | Invalidate timeline (none) |
| 9 | `agent:status` | `AgentStatusPayload` | Invalidate agents, workingAgents, squad status |
| 10 | `agent:created` | `AgentCreatedPayload` | Invalidate agents |
| 11 | `agent:archived` | `AgentArchivedPayload` | Invalidate agents, workingAgents |
| 12 | `agent:restored` | `AgentRestoredPayload` | Invalidate agents |
| 13 | `task:queued` | `TaskQueuedPayload` | Set pendingTask + invalidate aggregate |
| 14 | `task:dispatch` | `TaskDispatchPayload` | Set pendingTask + invalidate aggregate |
| 15 | `task:running` | `TaskRunningPayload` | Set pendingTask + invalidate aggregate |
| 16 | `task:waiting_local_directory` | `TaskWaitingLocalDirectoryPayload` | Set pendingTask + invalidate aggregate |
| 17 | `task:completed` | `TaskCompletedPayload` | Invalidate aggregate only |
| 18 | `task:failed` | `TaskFailedPayload` | Clear pending + invalidate messages + aggregate |
| 19 | `task:cancelled` | `TaskCancelledPayload` | Clear pending + invalidate messages + aggregate |
| 20 | `task:progress` | `unknown` | *(no handler)* |
| 21 | `task:message` | `TaskMessagePayload` | Set taskMessages |
| 22 | `inbox:new` | `InboxNewPayload` | Invalidate inbox + summary + notification |
| 23 | `inbox:read` | `InboxReadPayload` | Invalidate inbox + summary |
| 24 | `inbox:archived` | `InboxArchivedPayload` | Invalidate inbox + summary |
| 25 | `inbox:unarchived` | `InboxUnarchivedPayload` | Invalidate inbox + summary |
| 26 | `inbox:batch-read` | `InboxBatchReadPayload` | Invalidate inbox + summary |
| 27 | `inbox:batch-archived` | `InboxBatchArchivedPayload` | Invalidate inbox + summary |
| 28 | `workspace:updated` | `WorkspaceUpdatedPayload` | Patch workspace list |
| 29 | `workspace:deleted` | `WorkspaceDeletedPayload` | Self-guarded: cleanup + relocate |
| 30 | `member:added` | `MemberAddedPayload` | Invalidate members + invitations |
| 31 | `member:updated` | `MemberUpdatedPayload` | Invalidate members |
| 32 | `member:removed` | `MemberRemovedPayload` | Conditional: if me → cleanup + relocate |
| 33 | `daemon:heartbeat` | `unknown` | *(skipped)* |
| 34 | `daemon:register` | `unknown` | Invalidate runtimes + squad status |
| 35 | `skill:created` | `unknown` | Invalidate skills |
| 36 | `skill:updated` | `unknown` | Invalidate skills + agents |
| 37 | `skill:deleted` | `unknown` | Invalidate skills + agents |
| 38 | `subscriber:added` | `SubscriberAddedPayload` | Invalidate subscribers |
| 39 | `subscriber:removed` | `SubscriberRemovedPayload` | Invalidate subscribers |
| 40 | `activity:created` | `ActivityCreatedPayload` | Invalidate timeline (none) |
| 41 | `reaction:added` | `ReactionAddedPayload` | Invalidate timeline (none) |
| 42 | `reaction:removed` | `ReactionRemovedPayload` | Invalidate timeline (none) |
| 43 | `issue_reaction:added` | `IssueReactionAddedPayload` | Invalidate issue reactions |
| 44 | `issue_reaction:removed` | `IssueReactionRemovedPayload` | Invalidate issue reactions |
| 45 | `chat:message` | `ChatMessageEventPayload` | Invalidate messages + pendingTask |
| 46 | `chat:done` | `ChatDonePayload` | Set messages + clear pending + invalidate |
| 47 | `chat:cancel_finalized` | `ChatCancelFinalizedPayload` | Conditional: stopped/restored branches |
| 48 | `chat:session_read` | `ChatSessionReadPayload` | Invalidate sessions |
| 49 | `chat:session_deleted` | `ChatSessionDeletedPayload` | Filter sessions + remove queries + Zustand guard |
| 50 | `chat:session_updated` | `ChatSessionUpdatedPayload` | Patch session inline |
| 51 | `project:created` | `ProjectCreatedPayload` | Invalidate projects |
| 52 | `project:updated` | `ProjectUpdatedPayload` | Invalidate projects + issues |
| 53 | `project:deleted` | `ProjectDeletedPayload` | Invalidate projects + issues |
| 54 | `squad:created` | `unknown` | Invalidate squads |
| 55 | `squad:updated` | `unknown` | Invalidate squads |
| 56 | `squad:deleted` | `unknown` | Invalidate squads + issues |
| 57 | `label:created` | `unknown` | Invalidate labels (all scopes) + issues + agents + skills |
| 58 | `label:updated` | `unknown` | Invalidate labels (all scopes) + issues + agents + skills |
| 59 | `label:deleted` | `unknown` | Invalidate labels (all scopes) + issues + agents + skills |
| 60 | `issue_labels:changed` | `IssueLabelsChangedPayload` | Patch labels + invalidate derivatives |
| 61 | `issue_metadata:changed` | `IssueMetadataChangedPayload` | Patch metadata + invalidate sorted |
| 62 | `issue_properties:changed` | `IssuePropertiesChangedPayload` | Patch properties + invalidate derivatives |
| 63 | `property:created` | `PropertyChangedPayload` | Invalidate properties + table |
| 64 | `property:updated` | `PropertyChangedPayload` | Invalidate properties + table |
| 65 | `pin:created` | `unknown` | Invalidate pins |
| 66 | `pin:deleted` | `unknown` | Invalidate pins |
| 67 | `pin:reordered` | `unknown` | Invalidate pins |
| 68 | `invitation:created` | `InvitationCreatedPayload` | Invalidate myInvitations + toast |
| 69 | `invitation:accepted` | `InvitationAcceptedPayload` | Invalidate invitations + members |
| 70 | `invitation:declined` | `InvitationDeclinedPayload` | Invalidate invitations |
| 71 | `invitation:revoked` | `InvitationRevokedPayload` | Invalidate myInvitations |
| 72 | `github_installation:created` | `unknown` | Invalidate GitHub installations |
| 73 | `github_installation:deleted` | `unknown` | Invalidate GitHub installations |
| 74 | `pull_request:linked` | `unknown` | Invalidate PR list |
| 75 | `pull_request:updated` | `unknown` | Invalidate PR list |
| 76 | `pull_request:unlinked` | `unknown` | Invalidate PR list |
| 77 | `autopilot:*` | Various | *(handled via prefix refresh)* |
| 78 | `runtime:*` | Various | *(handled via daemon events)* |

---

## 9. Feeds Into

- **IRI-7**: WS capture harness — this event catalog provides the contract for golden fixtures
- **Contract tests**: Each event's payload shape + cache effect should be conformance-tested
- **Client implementations**: Mobile, web, and third-party clients use this as the source of truth
