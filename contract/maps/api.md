# Multica REST API Contract Map

> Generated from survey of:
> - `server/cmd/server/router.go` (~330 routes)
> - `packages/core/api/client.ts` (~2900 lines, endpoint catalog)
> - `packages/core/api/schemas.ts` (~1660 lines, zod schemas)

## Legend

- **Auth**: Authentication requirement
  - `public` - No authentication required
  - `session` - Requires valid user session (JWT cookie or PAT)
  - `daemon` - Requires daemon token (mdt_)
  - `webhook` - Token-in-path auth
- **Workspace**: Workspace scoping
  - `none` - No workspace context
  - `optional` - Workspace context optional
  - `required` - Requires workspace membership
  - `admin` - Requires workspace admin/owner role
- **Schema**: Zod schema coverage in `schemas.ts`
  - ✅ - Full schema validation
  - ⚠️ - Partial/response only
  - ❌ - No schema validation (raw types)

---

## 1. Health & Public

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/health` | GET | public | none | ❌ | Liveness probe |
| `/readyz` | GET | public | none | ❌ | Readiness probe |
| `/healthz` | GET | public | none | ❌ | Readiness alias |
| `/health/realtime` | GET | public* | none | ❌ | Realtime subsystem metrics |
| `/api/config` | GET | public | none | ✅ | Server config (signup, CDN, feature flags) |

*Note: `/health/realtime` restricted by token or loopback only.

---

## 2. Authentication

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/auth/send-code` | POST | public | none | ❌ | Email code request (rate limited) |
| `/auth/verify-code` | POST | public | none | ❌ | Email code verification |
| `/auth/google` | POST | public | none | ❌ | Google OAuth login |
| `/auth/logout` | POST | session | none | ❌ | Logout |
| `/api/cli-token` | POST | session | none | ❌ | Issue CLI token |

---

## 3. User Profile (User-scoped)

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/me` | GET | session | none | ✅ | Get current user |
| `/api/me` | PATCH | session | none | ✅ | Update profile |
| `/api/me/onboarding` | PATCH | session | none | ✅ | Update onboarding state |
| `/api/me/onboarding/complete` | POST | session | none | ✅ | Complete onboarding |
| `/api/me/onboarding/cloud-waitlist` | POST | session | none | ✅ | Join cloud waitlist |
| `/api/me/onboarding/runtime-bootstrap` | POST | session | none | ❌ | [DEPRECATED] Bootstrap with runtime |
| `/api/me/onboarding/no-runtime-bootstrap` | POST | session | none | ❌ | [DEPRECATED] Bootstrap without runtime |
| `/api/client-usage` | POST | session | none | ❌ | Client usage telemetry |

**Schema Coverage**: `UserSchema` validates `/api/me` responses.

---

## 4. Workspaces

### 4.1 Basic Operations

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/workspaces` | GET | session | none | ❌ | List user workspaces |
| `/api/workspaces` | POST | session | none | ❌ | Create workspace |
| `/api/workspaces/{id}` | GET | session | required | ❌ | Get workspace |
| `/api/workspaces/{id}` | PUT | session | admin | ❌ | Update workspace |
| `/api/workspaces/{id}` | PATCH | session | admin | ❌ | Update workspace (partial) |
| `/api/workspaces/{id}` | DELETE | session | owner | ❌ | Delete workspace |

### 4.2 Membership

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/workspaces/{id}/members` | GET | session | required | ❌ | List members |
| `/api/workspaces/{id}/members` | POST | session | admin | ❌ | Create invitation |
| `/api/workspaces/{id}/members/{memberId}` | PATCH | session | admin | ❌ | Update member role |
| `/api/workspaces/{id}/members/{memberId}` | DELETE | session | admin | ❌ | Remove member |
| `/api/workspaces/{id}/leave` | POST | session | required | ❌ | Leave workspace |
| `/api/workspaces/{id}/invitations` | GET | session | required | ❌ | List invitations |
| `/api/workspaces/{id}/invitations/{invitationId}` | DELETE | session | admin | ❌ | Revoke invitation |

### 4.3 Invitations (User-scoped)

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/invitations` | GET | session | none | ❌ | List my invitations |
| `/api/invitations/{id}` | GET | session | none | ❌ | Get invitation |
| `/api/invitations/{id}/accept` | POST | session | none | ❌ | Accept invitation |
| `/api/invitations/{id}/decline` | POST | session | none | ❌ | Decline invitation |

### 4.4 Runtime Profiles (Admin-only mutations)

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/workspaces/{id}/runtime-profiles` | GET | session | required | ❌ | List profiles |
| `/api/workspaces/{id}/runtime-profiles/{profileId}` | GET | session | required | ❌ | Get profile |
| `/api/workspaces/{id}/runtime-profiles` | POST | session | admin | ❌ | Create profile |
| `/api/workspaces/{id}/runtime-profiles/{profileId}` | PATCH | session | admin | ❌ | Update profile |
| `/api/workspaces/{id}/runtime-profiles/{profileId}` | PUT | session | admin | ❌ | Update profile (full) |
| `/api/workspaces/{id}/runtime-profiles/{profileId}` | DELETE | session | admin | ❌ | Delete profile |

---

## 5. Issues

### 5.1 CRUD Operations

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues` | GET | session | required | ✅ | List issues (query params) |
| `/api/issues/query` | POST | session | required | ✅ | List issues (POST for large IDs) |
| `/api/issues` | POST | session | required | ✅ | Create issue |
| `/api/issues/{id}` | GET | session | required | ❌ | Get issue |
| `/api/issues/{id}` | PUT | session | required | ❌ | Update issue |
| `/api/issues/{id}` | DELETE | session | required | ❌ | Delete issue |
| `/api/issues/{id}/move` | POST | session | required | ❌ | Move issue (parent/project) |

### 5.2 Batch Operations

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/batch-update` | POST | session | required | ❌ | Batch update issues |
| `/api/issues/batch-delete` | POST | session | required | ❌ | Batch delete issues |

### 5.3 Search & Listing

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/search` | GET | session | required | ✅ | Full-text search |
| `/api/issues/grouped` | GET | session | required | ✅ | Grouped by assignee |
| `/api/issues/children` | GET | session | required | ✅ | Batch get children |
| `/api/issues/{id}/children` | GET | session | required | ✅ | Get child issues |
| `/api/issues/child-progress` | GET | session | required | ❌ | Get completion progress |

### 5.4 Table Endpoints (Advanced Querying)

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/table/groups` | POST | session | required | ✅ | Table group descriptors |
| `/api/issues/table/rows` | POST | session | required | ✅ | Table row data |
| `/api/issues/table/facets` | POST | session | required | ✅ | Facet aggregations |

### 5.5 Comments

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/{id}/comments` | GET | session | required | ✅ | List comments |
| `/api/issues/{id}/comments` | POST | session | required | ⚠️ | Create comment |
| `/api/issues/{id}/comments/trigger-preview` | POST | session | required | ✅ | Preview @mentions |
| `/api/comments/{id}` | PUT | session | required | ❌ | Update comment |
| `/api/comments/{id}` | DELETE | session | required | ❌ | Delete comment |
| `/api/comments/{id}/resolve` | POST | session | required | ❌ | Resolve thread |
| `/api/comments/{id}/resolve` | DELETE | session | required | ❌ | Unresolve thread |
| `/api/comments/{id}/reactions` | POST | session | required | ❌ | Add reaction |
| `/api/comments/{id}/reactions` | DELETE | session | required | ❌ | Remove reaction |

### 5.6 Subscriptions

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/{id}/subscribers` | GET | session | required | ⚠️ | List subscribers |
| `/api/issues/{id}/subscribe` | POST | session | required | ❌ | Subscribe |
| `/api/issues/{id}/unsubscribe` | POST | session | required | ❌ | Unsubscribe |

### 5.7 Timeline

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/{id}/timeline` | GET | session | required | ✅ | Get timeline entries |

### 5.8 Tasks & Reactions

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/{id}/active-task` | GET | session | required | ❌ | Get active task |
| `/api/issues/{id}/task-runs` | GET | session | required | ⚠️ | List task runs |
| `/api/issues/{id}/usage` | GET | session | required | ❌ | Get token usage |
| `/api/issues/{id}/reactions` | POST | session | required | ❌ | Add issue reaction |
| `/api/issues/{id}/reactions` | DELETE | session | required | ❌ | Remove issue reaction |
| `/api/issues/{id}/rerun` | POST | session | required | ❌ | Rerun issue |

### 5.9 Trigger Preview

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/preview-trigger` | POST | session | required | ✅ | Dry-run trigger evaluation |

### 5.10 Labels on Issues

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/{id}/labels` | GET | session | required | ✅ | List labels |
| `/api/issues/{id}/labels` | POST | session | required | ✅ | Attach label |
| `/api/issues/{id}/labels/{labelId}` | DELETE | session | required | ✅ | Detach label |

### 5.11 Metadata

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/{id}/metadata` | GET | session | required | ❌ | List metadata |
| `/api/issues/{id}/metadata/{key}` | PUT | session | required | ❌ | Set metadata key |
| `/api/issues/{id}/metadata/{key}` | DELETE | session | required | ❌ | Delete metadata key |

### 5.12 Properties

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/{id}/properties/{propertyId}` | PUT | session | required | ✅ | Set property |
| `/api/issues/{id}/properties/{propertyId}` | DELETE | session | required | ✅ | Unset property |

### 5.13 Pull Requests

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/{id}/pull-requests` | GET | session | required | ❌ | List linked PRs |

### 5.14 Task Cancellation

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/{id}/tasks/{taskId}/cancel` | POST | session | required | ❌ | Cancel task |
| `/api/tasks/{taskId}/cancel` | POST | session | required | ✅ | Cancel task by ID |

### 5.15 Quick Create

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/issues/quick-create` | POST | session | required | ❌ | Quick-create from prompt |

**Schema Coverage**:
- `IssueSchema` - Issue object validation
- `ListIssuesResponseSchema` - List responses
- `CreateIssueResponseSchema` - Create response (tightened)
- `SearchIssuesResponseSchema` - Search results
- `GroupedIssuesResponseSchema` - Grouped lists
- `IssueTable*ResponseSchema` - Table endpoints
- `TimelineEntriesSchema` - Timeline
- `CommentsListSchema` - Comments
- `CommentTriggerPreviewSchema` - @mention previews
- `IssueTriggerPreviewSchema` - Trigger dry-run

---

## 6. Agents

### 6.1 CRUD

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/agents` | GET | session | required | ❌ | List agents |
| `/api/agents` | POST | session | required | ❌ | Create agent |
| `/api/agents/{id}` | GET | session | required | ❌ | Get agent |
| `/api/agents/{id}` | PUT | session | required | ❌ | Update agent |
| `/api/agents/{id}/archive` | POST | session | required | ❌ | Archive agent |
| `/api/agents/{id}/restore` | POST | session | required | ❌ | Restore agent |
| `/api/agents/{id}/cancel-tasks` | POST | session | required | ❌ | Cancel all tasks |

### 6.2 Templates

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/agent-templates` | GET | session | required | ✅ | List templates |
| `/api/agent-templates/{slug}` | GET | session | required | ✅ | Get template detail |
| `/api/agents/from-template` | POST | session | required | ✅ | Create from template |

### 6.3 Builder Sessions

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/agent-builder/sessions` | POST | session | required | ✅ | Create builder session |
| `/api/agent-builder/sessions/{id}/runtime` | PATCH | session | required | ✅ | Switch runtime |

### 6.4 Skills

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/agents/{id}/skills` | GET | session | required | ❌ | List agent skills |
| `/api/agents/{id}/skills` | PUT | session | required | ❌ | Set agent skills |
| `/api/agents/{id}/skills/add` | POST | session | required | ❌ | Add skills |
| `/api/agents/{id}/skills/{skillId}` | DELETE | session | required | ❌ | Remove skill |
| `/api/agents/{id}/skills/{skillId}/enabled` | PUT | session | required | ❌ | Toggle skill |
| `/api/agents/{id}/runtime-skills/enabled` | PUT | session | required | ❌ | Toggle runtime skill |

### 6.5 Tasks

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/agents/{id}/tasks` | GET | session | required | ⚠️ | List agent tasks |

### 6.6 Environment Variables

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/agents/{id}/env` | GET | session | required | ❌ | Get env vars |
| `/api/agents/{id}/env` | PUT | session | required | ❌ | Update env vars |

### 6.7 Labels

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/agents/{id}/labels` | GET | session | required | ✅ | List labels |
| `/api/agents/{id}/labels` | POST | session | required | ✅ | Attach label |
| `/api/agents/{id}/labels/{labelId}` | DELETE | session | required | ✅ | Detach label |

**Schema Coverage**:
- `AgentTemplateSchema` / `AgentTemplateSummarySchema` - Templates
- `CreateAgentFromTemplateResponseSchema` - From-template response
- `AgentBuilderSessionSchema` - Builder sessions
- `AgentTaskListSchema` - Task lists

### 6.8 Ask an Expert

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/ask` | POST | session | required | ❌ | Consult an agent as an expert; returns its answer synchronously |

Synchronous single inference call wearing an agent's identity (IRI-76). It is
deliberately outside the task/queue family: no `agent_task_queue` row, no
worktree, no transcript, and nothing persisted — the response body *is* the
whole result. Request `{expert (agent UUID), question, context?}`; response
`{expert_id, expert_name, answer, model, elapsed_ms}`.

Latency is the contract, so failures are fast and typed rather than retried:
`503` when no LLM layer is configured, `504` when the expert exceeds the
server's 15s deadline, `502` on an upstream failure or empty completion. The
model comes from `MULTICA_LLM_ASK_MODEL` (falling back to
`MULTICA_LLM_DEFAULT_MODEL`) and is fixed server-side — the client cannot
choose it. Membership in the expert's workspace is the only authorization gate;
the agent invocation-permission gate does not apply because no run is started.
No web/zod consumer: the caller is `multica ask <expert> <question>`, which
resolves the expert name to a UUID client-side.

---

## 7. Skills

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/skills` | GET | session | required | ✅ | List workspace and read-only built-in skills |
| `/api/skills/search` | GET | session | required | ❌ | Search skills |
| `/api/skills` | POST | session | required | ❌ | Create skill |
| `/api/skills/{id}` | GET | session | required | ✅ | Get workspace or built-in skill |
| `/api/skills/{id}` | PUT | session | required | ❌ | Update skill |
| `/api/skills/{id}` | DELETE | session | required | ❌ | Delete skill |
| `/api/skills/import` | POST | session | required | ❌ | Import from URL |
| `/api/skills/{id}/labels` | GET | session | required | ✅ | List labels |
| `/api/skills/{id}/labels` | POST | session | required | ✅ | Attach label |
| `/api/skills/{id}/labels/{labelId}` | DELETE | session | required | ✅ | Detach label |
| `/api/skills/{id}/files` | GET | session | required | ❌ | List files |
| `/api/skills/{id}/files` | PUT | session | required | ❌ | Upsert file |
| `/api/skills/{id}/files/{fileId}` | DELETE | session | required | ❌ | Delete file |

---

## 8. Projects

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/projects` | GET | session | required | ❌ | List projects |
| `/api/projects/search` | GET | session | required | ✅ | Search projects |
| `/api/projects` | POST | session | required | ❌ | Create project |
| `/api/projects/{id}` | GET | session | required | ❌ | Get project |
| `/api/projects/{id}` | PUT | session | required | ❌ | Update project |
| `/api/projects/{id}` | DELETE | session | required | ❌ | Delete project |
| `/api/projects/{id}/resources` | GET | session | required | ❌ | List resources |
| `/api/projects/{id}/resources` | POST | session | required | ❌ | Create resource |
| `/api/projects/{id}/resources/{resourceId}` | PUT | session | required | ❌ | Update resource |
| `/api/projects/{id}/resources/{resourceId}` | DELETE | session | required | ❌ | Delete resource |

**Schema Coverage**:
- `SearchProjectsResponseSchema` - Search results

---

## 9. Labels

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/labels` | GET | session | required | ✅ | List labels |
| `/api/labels` | POST | session | required | ✅ | Create label |
| `/api/labels/{id}` | GET | session | required | ✅ | Get label |
| `/api/labels/{id}` | PUT | session | required | ✅ | Update label |
| `/api/labels/{id}` | DELETE | session | required | ❌ | Delete label |

**Schema Coverage**:
- `LabelSchema` - Label objects
- `ListLabelsResponseSchema` - List responses
- `ResourceLabelsResponseSchema` - Resource label lists

---

## 10. Custom Properties

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/properties` | GET | session | required | ✅ | List definitions |
| `/api/properties` | POST | session | required | ✅ | Create definition |
| `/api/properties/{id}` | GET | session | required | ✅ | Get definition |
| `/api/properties/{id}` | PATCH | session | required | ✅ | Update definition |

**Schema Coverage**:
- `IssuePropertySchema` - Property definitions
- `ListPropertiesResponseSchema` - List responses
- `IssuePropertiesResponseSchema` - Values response
- `IssuePropertyValuesSchema` - Value bag preprocessing

---

## 11. Runtime Profiles (Workspace-scoped)

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/workspaces/{id}/runtime-profiles` | GET | session | required | ❌ | List profiles |
| `/api/workspaces/{id}/runtime-profiles/{profileId}` | GET | session | required | ❌ | Get profile |
| `/api/workspaces/{id}/runtime-profiles` | POST | session | admin | ❌ | Create profile |
| `/api/workspaces/{id}/runtime-profiles/{profileId}` | PATCH | session | admin | ❌ | Update profile |
| `/api/workspaces/{id}/runtime-profiles/{profileId}` | PUT | session | admin | ❌ | Update profile |
| `/api/workspaces/{id}/runtime-profiles/{profileId}` | DELETE | session | admin | ❌ | Delete profile |

---

## 12. Runtimes

### 12.1 Basic Operations

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/runtimes` | GET | session | required | ❌ | List runtimes |
| `/api/runtimes/{id}` | PATCH | session | required | ❌ | Update runtime |
| `/api/runtimes/{id}` | DELETE | session | required | ❌ | Delete runtime |
| `/api/runtimes/{id}/archive-agents-and-delete` | POST | session | required | ❌ | Cascade delete |

### 12.2 Usage & Activity

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/runtimes/{id}/usage` | GET | session | required | ✅ | Usage by day |
| `/api/runtimes/{id}/usage/by-agent` | GET | session | required | ✅ | Usage by agent |
| `/api/runtimes/{id}/usage/by-hour` | GET | session | required | ✅ | Usage by hour |
| `/api/runtimes/{id}/activity` | GET | session | required | ✅ | Hourly activity |

### 12.3 Updates & Models

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/runtimes/{id}/update` | POST | session | required | ❌ | Initiate update |
| `/api/runtimes/{id}/update/{updateId}` | GET | session | required | ❌ | Get update status |
| `/api/runtimes/{id}/models` | POST | session | required | ❌ | Initiate model list |
| `/api/runtimes/{id}/models/{requestId}` | GET | session | required | ❌ | Get model list result |

### 12.4 Local Skills

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/runtimes/{id}/local-skills` | POST | session | required | ❌ | Initiate list |
| `/api/runtimes/{id}/local-skills/{requestId}` | GET | session | required | ❌ | Get list result |
| `/api/runtimes/{id}/local-skills/import` | POST | session | required | ❌ | Initiate import |
| `/api/runtimes/{id}/local-skills/import/{requestId}` | GET | session | required | ❌ | Get import result |

**Schema Coverage**:
- `RuntimeUsageListSchema` - Usage data
- `RuntimeHourlyActivityListSchema` - Activity heatmap
- `RuntimeUsageByAgentListSchema` - Agent breakdown
- `RuntimeUsageByHourListSchema` - Hourly breakdown

---

## 13. Cloud Runtime Fleet (SaaS only)

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/cloud-runtime` | GET | session | required | ❌ | Get service status |
| `/api/cloud-runtime/healthz` | GET | session | required | ❌ | Health check |
| `/api/cloud-runtime/readyz` | GET | session | required | ❌ | Ready check |
| `/api/cloud-runtime/nodes` | GET | session | required | ✅ | List nodes |
| `/api/cloud-runtime/nodes` | POST | session | required | ✅ | Create node |
| `/api/cloud-runtime/nodes` | DELETE | session | required | ❌ | Delete node |
| `/api/cloud-runtime/nodes/start` | POST | session | required | ❌ | Start node |
| `/api/cloud-runtime/nodes/stop` | POST | session | required | ❌ | Stop node |
| `/api/cloud-runtime/nodes/reboot` | POST | session | required | ❌ | Reboot node |
| `/api/cloud-runtime/nodes/status` | POST | session | required | ❌ | Get status |
| `/api/cloud-runtime/nodes/exec` | POST | session | required | ❌ | Execute command |

**Schema Coverage**:
- `CloudRuntimeNodeSchema` - Node objects
- `CloudRuntimeNodeListSchema` - Node lists

---

## 14. Cloud Billing (User-scoped, Human-only)

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/cloud-billing/balance` | GET | session | none | ✅ | Get balance |
| `/api/cloud-billing/transactions` | GET | session | none | ✅ | List transactions |
| `/api/cloud-billing/batches` | GET | session | none | ✅ | List credit batches |
| `/api/cloud-billing/topups` | GET | session | none | ✅ | List topups |
| `/api/cloud-billing/price-tiers` | GET | session | none | ✅ | List pricing tiers |
| `/api/cloud-billing/checkout-sessions` | POST | session | none | ✅ | Create checkout |
| `/api/cloud-billing/checkout-sessions/{id}` | GET | session | none | ✅ | Get checkout status |
| `/api/cloud-billing/portal-sessions` | POST | session | none | ✅ | Create portal session |

**Auth Note**: All billing routes use `RequireHumanActor` middleware - task tokens (mat_) are blocked.

**Schema Coverage**:
- `BillingBalanceSchema` - Balance response
- `BillingTransactionsPageSchema` - Transaction pages
- `BillingBatchesPageSchema` - Batch pages
- `BillingTopupsPageSchema` - Topup pages
- `BillingPriceTierListSchema` - Pricing tiers
- `CreateBillingCheckoutSessionResponseSchema` - Checkout creation
- `BillingCheckoutSessionStatusSchema` - Checkout status
- `CreateBillingPortalSessionResponseSchema` - Portal session

---

## 15. Dashboard (Workspace-scoped)

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/dashboard/usage/daily` | GET | session | required | ✅ | Daily usage rollup |
| `/api/dashboard/usage/by-agent` | GET | session | required | ✅ | Usage by agent |
| `/api/dashboard/agent-runtime` | GET | session | required | ✅ | Agent runtime totals |
| `/api/dashboard/runtime/daily` | GET | session | required | ✅ | Daily runtime rollup |

**Schema Coverage**:
- `DashboardUsageDailyListSchema` - Daily usage
- `DashboardUsageByAgentListSchema` - Agent breakdown
- `DashboardAgentRunTimeListSchema` - Runtime totals
- `DashboardRunTimeDailyListSchema` - Daily runtime

---

## 16. Workspace Presence

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/assignee-frequency` | GET | session | required | ❌ | Assignee frequency stats |
| `/api/working-agents` | GET | session | required | ❌ | Working agents list |
| `/api/agent-task-snapshot` | GET | session | required | ⚠️ | Active + latest terminal tasks |
| `/api/agent-activity-30d` | GET | session | required | ❌ | Daily activity buckets |
| `/api/agent-run-counts` | GET | session | required | ❌ | Run counts per agent |

**Schema Coverage**:
- `AgentTaskListSchema` - Task snapshot

---

## 17. Chat Sessions

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/chat/sessions` | GET | session | required | ❌ | List sessions |
| `/api/chat/sessions` | POST | session | required | ❌ | Create session |
| `/api/chat/sessions/{id}` | GET | session | required | ❌ | Get session |
| `/api/chat/sessions/{id}` | PATCH | session | required | ❌ | Update session |
| `/api/chat/sessions/{id}` | DELETE | session | required | ❌ | Delete session |
| `/api/chat/sessions/{id}/pin` | PATCH | session | required | ❌ | Pin/unpin |
| `/api/chat/sessions/{id}/archive` | PATCH | session | required | ❌ | Archive/unarchive |
| `/api/chat/sessions/{id}/messages` | GET | session | required | ❌ | List messages |
| `/api/chat/sessions/{id}/messages` | POST | session | required | ❌ | Send message |
| `/api/chat/sessions/{id}/messages/page` | GET | session | required | ❌ | Paginated messages |
| `/api/chat/sessions/{id}/read` | POST | session | required | ❌ | Mark read |
| `/api/chat/sessions/{id}/pending-task` | GET | session | required | ❌ | Get pending task |
| `/api/chat/sessions/{id}/draft-restores` | GET | session | required | ✅ | List draft restores |
| `/api/chat/sessions/{id}/draft-restores/{restoreId}` | DELETE | session | required | ❌ | Consume draft restore |
| `/api/chat/pending-tasks` | GET | session | required | ❌ | All pending tasks |
| `/api/chat/pending-tasks/has-any` | GET | session | required | ❌ | Check any pending |

### Pinned Agents (Quick Bar)

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/chat/pinned-agents` | GET | session | required | ❌ | List pinned |
| `/api/chat/pinned-agents` | POST | session | required | ❌ | Pin agent |
| `/api/chat/pinned-agents/{id}` | DELETE | session | required | ❌ | Unpin agent |

### Agent-facing Channel Reads

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/chat/history` | GET | session | required | ❌ | Channel history (task-scoped) |
| `/api/chat/thread` | GET | session | required | ❌ | Thread messages (task-scoped) |

**Schema Coverage**:
- `ChatDraftRestoresResponseSchema` - Draft restores

---

## 18. Inbox

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/inbox` | GET | session | required | ❌ | List inbox |
| `/api/inbox/archived` | GET | session | required | ✅ | List archived |
| `/api/inbox/unread-count` | GET | session | required | ❌ | Unread count |
| `/api/inbox/unread-summary` | GET | session | none | ✅ | Cross-workspace unread |
| `/api/inbox/{id}/read` | POST | session | required | ❌ | Mark read |
| `/api/inbox/{id}/archive` | POST | session | required | ❌ | Archive item |
| `/api/inbox/{id}/unarchive` | POST | session | required | ❌ | Unarchive item |
| `/api/inbox/mark-all-read` | POST | session | required | ❌ | Mark all read |
| `/api/inbox/archive-all` | POST | session | required | ❌ | Archive all |
| `/api/inbox/archive-all-read` | POST | session | required | ❌ | Archive read |
| `/api/inbox/archive-completed` | POST | session | required | ❌ | Archive completed |

**Schema Coverage**:
- `InboxItemListSchema` - Archived items
- `InboxUnreadSummarySchema` - Unread summary

---

## 19. Notification Preferences

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/notification-preferences` | GET | session | optional | ✅ | Get preferences |
| `/api/notification-preferences` | PATCH | session | optional | ✅ | Update preferences |
| `/api/notification-preferences` | PUT | session | optional | ❌ | Update preferences (full) |

**Schema Coverage**:
- `NotificationPreferenceResponseSchema` - Preferences

---

## 20. Pins

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/pins` | GET | session | required | ❌ | List pins |
| `/api/pins` | POST | session | required | ❌ | Create pin |
| `/api/pins/reorder` | PUT | session | required | ❌ | Reorder pins |
| `/api/pins/{itemType}/{itemId}` | DELETE | session | required | ❌ | Delete pin |

---

## 21. Squads

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/squads` | GET | session | required | ✅ | List squads |
| `/api/squads` | POST | session | required | ✅ | Create squad |
| `/api/squads/{id}` | GET | session | required | ✅ | Get squad |
| `/api/squads/{id}` | PUT | session | required | ✅ | Update squad |
| `/api/squads/{id}` | DELETE | session | required | ❌ | Delete squad |
| `/api/squads/{id}/members` | GET | session | required | ❌ | List members |
| `/api/squads/{id}/members` | POST | session | required | ❌ | Add member |
| `/api/squads/{id}/members` | DELETE | session | required | ❌ | Remove member |
| `/api/squads/{id}/members/role` | PATCH | session | required | ❌ | Update member role |
| `/api/squads/{id}/members/status` | GET | session | required | ✅ | Member status snapshot |
| `/api/issues/{id}/squad-evaluated` | POST | session | required | ❌ | Record leader evaluation |

**Schema Coverage**:
- `SquadSchema` / `SquadListSchema` - Squad objects
- `SquadMemberStatusListResponseSchema` - Status responses

---

## 22. Autopilots

### 22.1 CRUD

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/autopilots` | GET | session | required | ✅ | List autopilots |
| `/api/autopilots` | POST | session | required | ❌ | Create autopilot |
| `/api/autopilots/{id}` | GET | session | required | ❌ | Get autopilot |
| `/api/autopilots/{id}` | PATCH | session | required | ❌ | Update autopilot |
| `/api/autopilots/{id}` | DELETE | session | required | ❌ | Delete autopilot |

### 22.2 Triggers

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/autopilots/{id}/triggers` | POST | session | required | ❌ | Create trigger |
| `/api/autopilots/{id}/triggers/{triggerId}` | PATCH | session | required | ❌ | Update trigger |
| `/api/autopilots/{id}/triggers/{triggerId}` | DELETE | session | required | ❌ | Delete trigger |
| `/api/autopilots/{id}/triggers/{triggerId}/rotate-webhook-token` | POST | session | required | ❌ | Rotate webhook token |
| `/api/autopilots/{id}/triggers/{triggerId}/signing-secret` | PUT | session | required | ❌ | Set signing secret |

### 22.3 Execution

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/autopilots/{id}/trigger` | POST | session | required | ✅ | Manual trigger |
| `/api/autopilots/{id}/runs` | GET | session | required | ❌ | List runs |
| `/api/autopilots/{id}/runs/{runId}` | GET | session | required | ⚠️ | Get run detail |
| `/api/autopilots/{id}/cron-preview` | GET | session | required | ✅ | Preview cron schedule |

### 22.4 Deliveries

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/autopilots/{id}/deliveries` | GET | session | required | ❌ | List deliveries |
| `/api/autopilots/{id}/deliveries/{deliveryId}` | GET | session | required | ⚠️ | Get delivery |
| `/api/autopilots/{id}/deliveries/{deliveryId}/replay` | POST | session | required | ❌ | Replay delivery |

### 22.5 Collaborators

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/autopilots/{id}/collaborators` | POST | session | required | ❌ | Grant access |
| `/api/autopilots/{id}/collaborators/{userId}` | DELETE | session | required | ❌ | Revoke access |

**Schema Coverage**:
- `ListAutopilotsResponseSchema` - List responses
- `AutopilotRunSchema` - Run objects
- `CronPreviewResponseSchema` - Cron previews
- `ListWebhookDeliveriesResponseSchema` - Delivery lists
- `WebhookDeliveryResponseSchema` - Delivery detail

---

## 23. Attachments

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/upload-file` | POST | session | none* | ✅ | Upload file |
| `/api/attachments/{id}` | GET | session | required | ✅ | Get metadata |
| `/api/attachments/{id}/content` | GET | session | required | ❌ | Get text content |
| `/api/attachments/{id}/download` | GET | session | none** | ❌ | Download file |
| `/api/attachments/{id}` | DELETE | session | required | ❌ | Delete attachment |
| `/api/issues/{id}/attachments` | GET | session | required | ❌ | List issue attachments |

\* Workspace resolved from headers
\*\* Self-resolves workspace from attachment row (for native img/video src)

**Schema Coverage**:
- `AttachmentResponseSchema` - Attachment metadata

---

## 24. GitHub Integration

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/workspaces/{id}/github/installations` | GET | session | required | ❌ | List installations |
| `/api/workspaces/{id}/github/connect` | GET | session | admin | ❌ | Connect GitHub App |
| `/api/workspaces/{id}/github/installations/{installationId}` | DELETE | session | admin | ❌ | Disconnect installation |

**Webhook**:
| `/api/webhooks/github` | POST | webhook | none | ❌ | GitHub webhook ingress |
| `/api/github/setup` | GET | session | none | ❌ | Setup callback |

---

## 25. Lark Integration

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/workspaces/{id}/lark/installations` | GET | session | required | ❌ | List installations |
| `/api/workspaces/{id}/lark/installations/{installationId}` | DELETE | session | required | ❌ | Revoke installation |
| `/api/workspaces/{id}/lark/install/begin` | POST | session | required | ❌ | Begin device-flow install |
| `/api/workspaces/{id}/lark/install/{sessionId}/status` | GET | session | required | ❌ | Check install status |
| `/api/lark/binding/redeem` | POST | session | none | ❌ | Redeem binding token |

---

## 26. Slack Integration

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/workspaces/{id}/slack/installations` | GET | session | required | ❌ | List installations |
| `/api/workspaces/{id}/slack/installations/{installationId}` | DELETE | session | admin | ❌ | Revoke installation |
| `/api/workspaces/{id}/slack/install/byo` | POST | session | admin | ❌ | Register BYO install |
| `/api/slack/binding/redeem` | POST | session | none | ❌ | Redeem binding token |

**Webhook**:
| `/api/webhooks/slack` | POST | webhook | none | ❌ | Slack OAuth callback |

---

## 27. Composio Integration

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/integrations/composio/connect/init` | POST | session | none | ❌ | Initiate OAuth |
| `/api/integrations/composio/toolkits` | GET | session | none | ❌ | List toolkits |
| `/api/integrations/composio/connections` | GET | session | none | ❌ | List connections |
| `/api/integrations/composio/connections/{id}` | DELETE | session | none | ❌ | Delete connection |
| `/api/integrations/composio/callback` | GET | public | none | ❌ | OAuth callback |

---

## 28. Webhooks

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/webhooks/autopilots/{token}` | POST | webhook | none | ❌ | Autopilot trigger webhook |
| `/api/webhooks/stripe` | POST | webhook | none | ❌ | Stripe billing webhook |

---

## 29. Daemon API (Daemon Auth)

All routes under `/api/daemon` require daemon authentication (mdt_ token).

### 29.1 Registration & Lifecycle

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/daemon/register` | POST | daemon | none | ❌ | Register daemon |
| `/api/daemon/deregister` | POST | daemon | none | ❌ | Deregister daemon |
| `/api/daemon/heartbeat` | POST | daemon | none | ❌ | Heartbeat |
| `/api/daemon/ws` | GET | daemon | none | ❌ | WebSocket upgrade |

### 29.2 Workspaces

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/daemon/workspaces` | GET | daemon | none | ❌ | List accessible workspaces |
| `/api/daemon/workspaces/{id}/repos` | GET | daemon | none | ❌ | Get workspace repos |
| `/api/daemon/workspaces/{id}/runtime-profiles` | GET | daemon | none | ❌ | List runtime profiles |

### 29.3 Task Claiming & Management

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/daemon/runtimes/{id}/tasks/claim` | POST | daemon | none | ❌ | Claim task for runtime |
| `/api/daemon/tasks/claim` | POST | daemon | none | ❌ | Batch claim tasks |
| `/api/daemon/claim` | POST | daemon | none | ❌ | Alias for batch claim |
| `/api/daemon/runtimes/{id}/tasks/pending` | GET | daemon | none | ❌ | List pending tasks |
| `/api/daemon/runtimes/{id}/tasks/{taskId}/prepare-lease` | POST | daemon | none | ❌ | Extend prepare lease |
| `/api/daemon/runtimes/{id}/tasks/{taskId}/skill-bundles/resolve` | POST | daemon | none | ❌ | Resolve skill bundles |

### 29.4 Task Status & Progress

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/daemon/tasks/{taskId}/status` | GET | daemon | none | ❌ | Get task status |
| `/api/daemon/tasks/{taskId}/start` | POST | daemon | none | ❌ | Mark task started |
| `/api/daemon/tasks/{taskId}/wait-local-directory` | POST | daemon | none | ❌ | Mark waiting for directory |
| `/api/daemon/tasks/{taskId}/progress` | POST | daemon | none | ❌ | Report progress |
| `/api/daemon/tasks/{taskId}/complete` | POST | daemon | none | ❌ | Mark complete |
| `/api/daemon/tasks/{taskId}/fail` | POST | daemon | none | ❌ | Mark failed |
| `/api/daemon/tasks/{taskId}/usage` | POST | daemon | none | ❌ | Report token usage |
| `/api/daemon/tasks/{taskId}/messages` | POST | daemon | none | ❌ | Report messages |
| `/api/daemon/tasks/{taskId}/messages` | GET | daemon | none | ❌ | List messages |
| `/api/daemon/tasks/{taskId}/cancel-ack` | POST | daemon | none | ❌ | Ack cancellation |

### 29.5 Results

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/daemon/runtimes/{id}/update/{updateId}/result` | POST | daemon | none | ❌ | Report update result |
| `/api/daemon/runtimes/{id}/models/{requestId}/result` | POST | daemon | none | ❌ | Report model list result |
| `/api/daemon/runtimes/{id}/local-skills/{requestId}/result` | POST | daemon | none | ❌ | Report local skill list |
| `/api/daemon/runtimes/{id}/local-skills/import/{requestId}/result` | POST | daemon | none | ❌ | Report import result |

### 29.6 Session Management

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/daemon/tasks/{taskId}/session` | POST | daemon | none | ❌ | Pin task session |

### 29.7 GC Check

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/daemon/workspaces/{id}/issues/gc-check` | POST | daemon | none | ❌ | Batch issue GC check |
| `/api/daemon/issues/{issueId}/gc-check` | GET | daemon | none | ❌ | Issue GC check |
| `/api/daemon/chat-sessions/{id}/gc-check` | GET | daemon | none | ❌ | Session GC check |
| `/api/daemon/autopilot-runs/{id}/gc-check` | GET | daemon | none | ❌ | Run GC check |
| `/api/daemon/tasks/{taskId}/gc-check` | GET | daemon | none | ❌ | Task GC check |

### 29.8 Recovery

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/daemon/runtimes/{id}/recover-orphans` | POST | daemon | none | ❌ | Recover orphaned tasks |

---

## 30. Feedback

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/feedback` | POST | session | none | ✅ | Submit feedback |
| `/api/contact-sales` | POST | public | none | ❌ | Contact sales form |

**Schema Coverage**:
- `CreateFeedbackResponseSchema` - Feedback submission

---

## 31. Personal Access Tokens

| Endpoint | Method | Auth | Workspace | Schema | Description |
|----------|--------|------|-----------|--------|-------------|
| `/api/tokens` | GET | session | none | ❌ | List tokens |
| `/api/tokens` | POST | session | none | ❌ | Create token |
| `/api/tokens/current/renew` | POST | session | none | ❌ | Renew current token |
| `/api/tokens/{id}` | DELETE | session | none | ❌ | Revoke token |

---

## Schema Coverage Summary

### Fully Covered Endpoints (✅)
- `/api/config` - AppConfigSchema
- `/api/me*` - UserSchema
- `/api/issues*` - IssueSchema, ListIssuesResponseSchema, etc.
- `/api/issues/table/*` - IssueTable*ResponseSchema
- `/api/issues/search` - SearchIssuesResponseSchema
- `/api/projects/search` - SearchProjectsResponseSchema
- `/api/issues/{id}/comments/trigger-preview` - CommentTriggerPreviewSchema
- `/api/issues/preview-trigger` - IssueTriggerPreviewSchema
- `/api/agent-templates*` - AgentTemplateSchema
- `/api/agent-builder/sessions*` - AgentBuilderSessionSchema
- `/api/labels*` - LabelSchema
- `/api/properties*` - IssuePropertySchema
- `/api/runtimes/{id}/usage*` - RuntimeUsage*Schema
- `/api/cloud-runtime/nodes*` - CloudRuntimeNodeSchema
- `/api/cloud-billing/*` - Billing*Schema
- `/api/dashboard/*` - Dashboard*Schema
- `/api/squads*` - SquadSchema
- `/api/autopilots*` - ListAutopilotsResponseSchema, AutopilotRunSchema, etc.
- `/api/inbox/archived` - InboxItemListSchema
- `/api/inbox/unread-summary` - InboxUnreadSummarySchema
- `/api/notification-preferences` - NotificationPreferenceResponseSchema
- `/api/attachments/{id}` - AttachmentResponseSchema
- `/api/chat/sessions/{id}/draft-restores` - ChatDraftRestoresResponseSchema
- `/api/feedback` - CreateFeedbackResponseSchema

### Partially Covered (⚠️)
- `/api/issues/{id}/comments` (create) - No request schema
- `/api/issues/{id}/subscribers` - SubscribersListSchema
- `/api/agents/{id}/tasks` - AgentTaskListSchema
- `/api/autopilots/{id}/runs/{runId}` - AutopilotRunSchema
- `/api/autopilots/{id}/deliveries/{deliveryId}` - WebhookDeliveryResponseSchema
- `/api/agent-task-snapshot` - AgentTaskListSchema

### No Schema Coverage (❌)
- All daemon API routes
- Webhook ingress routes
- Most POST/PUT/PATCH request bodies (typed but not zod-validated)
- Legacy endpoints marked [DEPRECATED]

---

## Endpoint Groups Summary

| Group | Count | Schema Coverage |
|-------|-------|-----------------|
| Health/Public | 5 | 1 ✅ (config) |
| Auth | 5 | 0 |
| User | 7 | 4 ✅ |
| Workspaces | 14 | 0 |
| Invitations | 5 | 0 |
| Issues | 45 | 15 ✅ |
| Agents | 21 | 6 ✅ |
| Skills | 12 | 5 ✅ |
| Projects | 10 | 1 ✅ |
| Labels | 5 | 4 ✅ |
| Properties | 4 | 4 ✅ |
| Runtimes | 14 | 5 ✅ |
| Cloud Runtime | 11 | 2 ✅ |
| Cloud Billing | 8 | 8 ✅ |
| Dashboard | 4 | 4 ✅ |
| Workspace Presence | 5 | 1 ✅ |
| Chat | 16 | 1 ✅ |
| Inbox | 11 | 2 ✅ |
| Notifications | 3 | 1 ✅ |
| Pins | 4 | 0 |
| Squads | 12 | 3 ✅ |
| Autopilots | 20 | 5 ✅ |
| Attachments | 6 | 1 ✅ |
| GitHub | 5 | 0 |
| Lark | 5 | 0 |
| Slack | 5 | 0 |
| Composio | 5 | 0 |
| Webhooks | 3 | 0 |
| Daemon API | 32 | 0 |
| Feedback | 2 | 1 ✅ |
| Tokens | 4 | 0 |
| **Total** | **~330** | **~85 ✅** |

---

## Notes

### Schema Philosophy
Per `schemas.ts` header:
- **Lenient parsing**: String enums use `z.string()` not `z.enum()`
- **Default arrays**: Missing arrays default to `[]`
- **Nullable union**: Optional fields unioned with `null`
- **Loose objects**: All object schemas end with `.loose()` to pass unknown fields
- **Fallback values**: Every schema has an EMPTY_* constant for graceful degradation

### Request Body Schemas
Most POST/PUT/PATCH request bodies are **NOT** zod-validated (using TypeScript interfaces only). Response bodies are validated. This is noted as "⚠️ Partial" or "❌ No schema" in the tables above.

### Auth Middleware Chain
1. `Auth` middleware validates session/PAT and stamps `X-User-ID`
2. `RequireWorkspaceMember` validates workspace membership
3. `RequireWorkspaceRole` validates specific roles (owner/admin)
4. `DaemonAuth` handles daemon token (mdt_) and PAT fallback
5. `RequireHumanActor` blocks task tokens for sensitive operations (billing)

### Workspace Header
Workspace context is resolved from `X-Workspace-Slug` or `X-Workspace-ID` header (set by client.ts via `getCurrentSlug()`), or from URL parameters for workspace-specific routes.
