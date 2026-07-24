// WorkspaceTimelineEntry: one row of the workspace-wide live event timeline.
//
// Unifies three existing event streams into a single chronological feed:
//   - activity_log (issue events, status/assignee changes, task completions,
//     env reveals, squad evaluations, …) → kind "activity"
//   - agent_task_queue (daemon task lifecycle: queued → running → completed)
//     → kind "task"
//   - comment (conversational activity: a comment posted on an issue)
//     → kind "comment"
//
// This type is intentionally self-contained and separate from the issue-scoped
// TimelineEntry (which is `activity | comment` and tied to one issue's
// context). The workspace timeline owns its own entry type so the view can be
// re-pointed at the future event firehose without disturbing the issue-timeline
// contract (IRI-36: "v2 swaps its feed to the firehose without changing the
// view"). Mirrors the Go WorkspaceTimelineEntry in
// server/internal/handler/activity.go.
export type WorkspaceTimelineEntryKind = "activity" | "task" | "comment";

export interface WorkspaceTimelineEntry {
  kind: WorkspaceTimelineEntryKind;
  id: string;
  created_at: string;

  // Common actor context. For activities this is the activity actor; for
  // tasks the "actor" is the agent that ran the task; for comments it is the
  // comment author.
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

  // Comment-only fields. The body is shipped in full; the row truncates it
  // client-side (same truncate-in-flex pattern task trigger_summary uses).
  content?: string;
}
