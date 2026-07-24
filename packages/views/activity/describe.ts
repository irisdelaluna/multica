import type { WorkspaceTimelineEntry } from "@multica/core/types";
import { isTaskMessageTaskId } from "@multica/core/chat/queries";

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

// The server stamps a task entry's id as "task:<uuid>" (see
// server/internal/handler/activity.go → workspaceTaskToEntry). The transcript
// surface fetches /api/tasks/:id/messages with the bare agent-task UUID, so we
// strip the kind prefix. Returns null for activity entries or anything that
// isn't a bare UUID — callers use that to decide whether to mount the
// transcript button. Lives here (not in the page) because it encodes a
// cross-boundary contract with the Go handler and belongs with the other
// unit-tested server-format decoders above.
const TASK_ENTRY_ID_PREFIX = "task:";

export function bareTaskId(entry: WorkspaceTimelineEntry): string | null {
  if (entry.kind !== "task") return null;
  const raw = entry.id.startsWith(TASK_ENTRY_ID_PREFIX)
    ? entry.id.slice(TASK_ENTRY_ID_PREFIX.length)
    : entry.id;
  return isTaskMessageTaskId(raw) ? raw : null;
}

// "In flight" = work the fleet has not finished — the broad reading of "what
// is running right now". A task queued behind another is still in flight from
// an operator's point of view, so queued/dispatched/waiting_local_directory
// join running. Deferred tasks are excluded: they are scheduled to fire later
// (fire_at), not actively awaiting execution, so surfacing them answers "what
// might run" rather than "what is running". Terminal states (completed /
// failed / cancelled) are obviously out. Non-task entries are never in flight.
const IN_FLIGHT_STATUSES = new Set([
  "running",
  "queued",
  "dispatched",
  "waiting_local_directory",
]);

export function isInFlight(entry: WorkspaceTimelineEntry): boolean {
  return entry.kind === "task" && !!entry.status && IN_FLIGHT_STATUSES.has(entry.status);
}

/** A running task is the one entry whose state is still changing, so "how long
 *  has it been running" is the metric that matters. created_at reflects enqueue
 *  time (which includes time parked in the queue); started_at is the moment the
 *  daemon began executing. Returns null when the task never started. */
export function runningSince(entry: WorkspaceTimelineEntry): number | null {
  if (entry.status !== "running" || !entry.started_at) return null;
  const ms = new Date(entry.started_at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Compact wall-clock duration for a live running timer ("12s", "2m 04s",
 * "1h 30m"). Mirrors the agent activity tab's formatDurationMs so a running
 * row reads on the same rhythm as the completed-row durations elsewhere.
 * Seconds are padded inside the minute form so a column of timers stays
 * visually aligned as it ticks.
 */
export function formatRunningDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  // Floor once, before decomposition, so one rounding policy carries across
  // every unit. Rounding the seconds inside each bucket independently can
  // emit an impossible "60s" field at a unit boundary — e.g. 59.6s → "60s",
  // or 1m59.6s → "1m 60s". Because the one-second tick is not aligned to a
  // task's fractional start time, that boundary is reached during ordinary
  // ticking, so the carry has to happen at decomposition, not after.
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    // A just-started task (< 1s) still reads "1s" rather than flashing "0s".
    return `${Math.max(1, totalSeconds)}s`;
  }
  if (totalSeconds < 60 * 60) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}m ${String(s).padStart(2, "0")}s`;
  }
  const h = Math.floor(totalSeconds / (60 * 60));
  const m = Math.floor((totalSeconds % (60 * 60)) / 60);
  return `${h}h ${m}m`;
}
