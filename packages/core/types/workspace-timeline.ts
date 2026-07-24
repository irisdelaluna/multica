// WorkspaceTimelineEntry: one row of the workspace-wide live event timeline.
//
// Unifies two existing audit streams into a single chronological feed:
//   - activity_log (issue events, status/assignee changes, task completions,
//     env reveals, squad evaluations, …) → kind "activity"
//   - agent_task_queue (daemon task lifecycle: queued → running → completed)
//     → kind "task"
//
// This type is intentionally self-contained and separate from the issue-scoped
// TimelineEntry (which is `activity | comment` and tied to one issue's
// context). The workspace timeline owns its own entry type so the view can be
// re-pointed at the future event firehose without disturbing the issue-timeline
// contract (IRI-36: "v2 swaps its feed to the firehose without changing the
// view"). Mirrors the Go WorkspaceTimelineEntry in
// server/internal/handler/activity.go.
export type WorkspaceTimelineEntryKind = "activity" | "task";

export interface WorkspaceTimelineEntry {
  kind: WorkspaceTimelineEntryKind;
  id: string;
  created_at: string;

  // Common actor context. For activities this is the activity actor; for
  // tasks the "actor" is the agent that ran the task.
  actor_type: string;
  actor_id: string;

  // Issue context (present when the entry is tied to an issue). Identifier is
  // the human-readable "<prefix>-<number>" form; empty for non-issue rows.
  issue_id?: string;
  issue_identifier?: string;
  issue_title?: string;
  project_id?: string;

  // Activity-only fields.
  action?: string;
  details?: Record<string, unknown>;

  // Task-only fields.
  status?: string;
  agent_name?: string;
  agent_avatar_url?: string;
  error?: string | null;
  trigger_summary?: string | null;
}
