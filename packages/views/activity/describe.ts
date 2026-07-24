import type { WorkspaceTimelineEntry } from "@multica/core/types";

// The workspace timeline renders a human-readable line per entry. These pure
// helpers turn the server-owned action vocabulary (written by
// server/cmd/server/activity_listeners.go) and the task status enum into
// readable fragments, so the row component stays presentational and the
// wording stays unit-testable. Every unknown action falls back to a
// humanized form so a new server event never renders as a raw snake_case
// token.

/** Convert a snake_case action token into a readable trailing phrase. */
export function humanizeAction(action: string): string {
  const words = action.replace(/_/g, " ").trim().split(/\s+/);
  if (words.length === 0) return action;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Past-tense verb for an activity action, e.g. "status_changed" → "changed status". */
export function activityVerb(action: string): string {
  switch (action) {
    case "issue_created":
      return "created";
    case "status_changed":
      return "changed the status of";
    case "assignee_changed":
      return "reassigned";
    case "priority_changed":
      return "changed the priority of";
    case "title_changed":
      return "renamed";
    case "description_changed":
    case "description_updated":
      return "edited the description of";
    case "due_date_changed":
      return "changed the due date of";
    case "start_date_changed":
      return "changed the start date of";
    case "project_changed":
      return "moved";
    case "task_completed":
      return "completed a run on";
    case "task_failed":
      return "had a failed run on";
    case "squad_leader_evaluated":
      return "evaluated (squad leader)";
    case "agent_env_revealed":
      return "revealed env secrets for";
    case "agent_env_updated":
      return "updated env secrets for";
    case "labeled":
      return "labeled";
    case "message_changed":
      return "edited a message on";
    default:
      return humanizeAction(action);
  }
}

/** A short detail fragment for an activity, e.g. status "todo → in_progress". */
export function activityDetail(entry: WorkspaceTimelineEntry): string {
  const d = entry.details ?? {};
  switch (entry.action) {
    case "status_changed": {
      const from = str(d, "from");
      const to = str(d, "to");
      return from || to ? `${from ?? "?"} → ${to ?? "?"}` : "";
    }
    case "assignee_changed": {
      const toType = str(d, "to_type");
      const toName = str(d, "to_name") ?? str(d, "to_label");
      return toName ? `→ ${toName}` : toType ? `→ ${toType}` : "";
    }
    case "priority_changed": {
      const to = str(d, "to") ?? str(d, "new");
      return to ? `→ ${to}` : "";
    }
    case "project_changed": {
      const to = str(d, "to_name") ?? str(d, "to");
      return to ? `→ ${to}` : "";
    }
    default:
      return "";
  }
}

/** Past-tense label for a task-run status. */
export function taskStatusLabel(status: string | undefined): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "deferred":
      return "Deferred";
    case "dispatched":
      return "Dispatched";
    case "running":
      return "Running";
    case "waiting_local_directory":
      return "Waiting";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return status ? humanizeAction(status) : "Task";
  }
}

/** Badge tone for a task status, for color coding in the row. */
export type TaskStatusTone = "default" | "secondary" | "success" | "warning" | "destructive";

export function taskStatusTone(status: string | undefined): TaskStatusTone {
  switch (status) {
    case "completed":
      return "success";
    case "running":
    case "dispatched":
      return "default";
    case "queued":
    case "deferred":
    case "waiting_local_directory":
      return "secondary";
    case "failed":
      return "destructive";
    case "cancelled":
      return "warning";
    default:
      return "secondary";
  }
}

function str(d: Record<string, unknown>, key: string): string | undefined {
  const v = d[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
