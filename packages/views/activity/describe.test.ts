import { describe, expect, it } from "vitest";
import type { WorkspaceTimelineEntry } from "@multica/core/types";
import {
  activityDetail,
  activityVerb,
  bareTaskId,
  formatRunningDurationMs,
  humanizeAction,
  isInFlight,
  runningSince,
  taskStatusLabel,
  taskStatusTone,
} from "./describe";

describe("describe activity verbs", () => {
  it("maps known actions to readable verbs", () => {
    expect(activityVerb("status_changed")).toBe("changed the status of");
    expect(activityVerb("assignee_changed")).toBe("reassigned");
    expect(activityVerb("task_failed")).toBe("had a failed run on");
    expect(activityVerb("issue_created")).toBe("created");
  });

  it("humanizes unknown actions instead of leaking snake_case", () => {
    expect(activityVerb("some_new_event")).toBe("Some New Event");
    expect(humanizeAction("foo_bar_baz")).toBe("Foo Bar Baz");
  });
});

describe("describe activity detail", () => {
  it("renders status transitions as from → to", () => {
    const entry: WorkspaceTimelineEntry = {
      kind: "activity",
      id: "a1",
      created_at: "2026-01-01T00:00:00Z",
      actor_type: "member",
      actor_id: "u1",
      action: "status_changed",
      details: { from: "todo", to: "in_progress" },
    };
    expect(activityDetail(entry)).toBe("todo → in_progress");
  });

  it("shows the target name on assignee change", () => {
    const entry: WorkspaceTimelineEntry = {
      kind: "activity",
      id: "a2",
      created_at: "2026-01-01T00:00:00Z",
      actor_type: "member",
      actor_id: "u1",
      action: "assignee_changed",
      details: { to_type: "agent", to_name: "Red Builder" },
    };
    expect(activityDetail(entry)).toBe("→ Red Builder");
  });

  it("returns nothing when there is no useful detail", () => {
    const entry: WorkspaceTimelineEntry = {
      kind: "activity",
      id: "a3",
      created_at: "2026-01-01T00:00:00Z",
      actor_type: "member",
      actor_id: "u1",
      action: "issue_created",
      details: {},
    };
    expect(activityDetail(entry)).toBe("");
  });
});

describe("describe task status", () => {
  it("labels every known lifecycle state", () => {
    expect(taskStatusLabel("queued")).toBe("Queued");
    expect(taskStatusLabel("deferred")).toBe("Deferred");
    expect(taskStatusLabel("running")).toBe("Running");
    expect(taskStatusLabel("completed")).toBe("Completed");
    expect(taskStatusLabel("failed")).toBe("Failed");
    expect(taskStatusLabel("cancelled")).toBe("Cancelled");
    expect(taskStatusLabel("waiting_local_directory")).toBe("Waiting");
  });

  it("tones terminal vs active vs failed states differently", () => {
    expect(taskStatusTone("completed")).toBe("success");
    expect(taskStatusTone("failed")).toBe("destructive");
    expect(taskStatusTone("running")).toBe("default");
    expect(taskStatusTone("queued")).toBe("secondary");
  });
});

describe("bareTaskId", () => {
  // The Go handler stamps task-entry ids as "task:<uuid>" (activity entries use
  // a bare activity-log id). The transcript button needs the bare agent-task
  // UUID to fetch /api/tasks/:id/messages, so a regression in this decoding
  // would silently break every task row's transcript affordance.

  const UUID = "11111111-2222-3333-4444-555555555555";

  function taskEntry(id: string): WorkspaceTimelineEntry {
    return {
      kind: "task",
      id,
      created_at: "2026-01-01T00:00:00Z",
      actor_type: "agent",
      actor_id: "agent-1",
      status: "completed",
    };
  }

  it("strips the task: prefix and returns the bare UUID", () => {
    expect(bareTaskId(taskEntry(`task:${UUID}`))).toBe(UUID);
  });

  it("accepts a bare UUID when the prefix is absent", () => {
    expect(bareTaskId(taskEntry(UUID))).toBe(UUID);
  });

  it("returns null for non-task entries (activity log id is not a task id)", () => {
    const activity: WorkspaceTimelineEntry = {
      kind: "activity",
      id: UUID,
      created_at: "2026-01-01T00:00:00Z",
      actor_type: "member",
      actor_id: "u1",
      action: "issue_created",
    };
    expect(bareTaskId(activity)).toBeNull();
  });

  it("returns null when the remaining id is not a valid UUID", () => {
    expect(bareTaskId(taskEntry("task:not-a-uuid"))).toBeNull();
    expect(bareTaskId(taskEntry("task:"))).toBeNull();
  });
});

describe("isInFlight", () => {
  // The broad reading of "what is running right now": work the fleet hasn't
  // finished. A task queued behind another is still in flight from an
  // operator's point of view, so the not-yet-running active states count.
  function task(status: string): WorkspaceTimelineEntry {
    return {
      kind: "task",
      id: "task:11111111-2222-3333-4444-555555555555",
      created_at: "2026-01-01T00:00:00Z",
      actor_type: "agent",
      actor_id: "agent-1",
      status,
    };
  }

  it("counts running, queued, dispatched and waiting_local_directory as in flight", () => {
    expect(isInFlight(task("running"))).toBe(true);
    expect(isInFlight(task("queued"))).toBe(true);
    expect(isInFlight(task("dispatched"))).toBe(true);
    expect(isInFlight(task("waiting_local_directory"))).toBe(true);
  });

  it("excludes terminal and deferred work", () => {
    // Deferred is scheduled to fire later (fire_at), not actively awaiting
    // execution, so it answers "what might run" not "what is running".
    expect(isInFlight(task("completed"))).toBe(false);
    expect(isInFlight(task("failed"))).toBe(false);
    expect(isInFlight(task("cancelled"))).toBe(false);
    expect(isInFlight(task("deferred"))).toBe(false);
  });

  it("never treats non-task entries as in flight", () => {
    const activity: WorkspaceTimelineEntry = {
      kind: "activity",
      id: "a1",
      created_at: "2026-01-01T00:00:00Z",
      actor_type: "member",
      actor_id: "u1",
      action: "issue_created",
    };
    expect(isInFlight(activity)).toBe(false);
  });
});

describe("runningSince", () => {
  const baseTask = {
    kind: "task",
    id: "task:11111111-2222-3333-4444-555555555555",
    created_at: "2026-01-01T00:00:00Z",
    actor_type: "agent",
    actor_id: "agent-1",
  } as const;

  it("returns started_at as epoch ms for a running task", () => {
    const entry: WorkspaceTimelineEntry = {
      ...baseTask,
      status: "running",
      started_at: "2026-01-01T00:05:00Z",
    };
    expect(runningSince(entry)).toBe(new Date("2026-01-01T00:05:00Z").getTime());
  });

  it("is null when the task is not running (even if started_at is set)", () => {
    const entry: WorkspaceTimelineEntry = {
      ...baseTask,
      status: "completed",
      started_at: "2026-01-01T00:05:00Z",
    };
    expect(runningSince(entry)).toBeNull();
  });

  it("is null for a running task that never received a started_at", () => {
    const entry: WorkspaceTimelineEntry = {
      ...baseTask,
      status: "running",
    };
    expect(runningSince(entry)).toBeNull();
  });
});

describe("formatRunningDurationMs", () => {
  it("formats sub-minute durations as floored seconds (never 60s)", () => {
    expect(formatRunningDurationMs(0)).toBe("0s");
    expect(formatRunningDurationMs(30_000)).toBe("30s");
    expect(formatRunningDurationMs(59_400)).toBe("59s");
    // A just-started task that hasn't reached one second still reads "1s"
    // rather than flashing "0s" while the timer spins up.
    expect(formatRunningDurationMs(400)).toBe("1s");
  });

  it("pads seconds inside the minute form so a column stays aligned", () => {
    expect(formatRunningDurationMs(60_000 + 4_000)).toBe("1m 04s");
    expect(formatRunningDurationMs(2 * 60_000 + 30_000)).toBe("2m 30s");
  });

  it("rolls into hours past 60 minutes", () => {
    expect(formatRunningDurationMs(90 * 60_000)).toBe("1h 30m");
  });

  // Regression: the one-second tick is not aligned to a task's fractional
  // start time, so a running timer routinely lands just under a unit
  // boundary (e.g. 59.6s). The previous implementation bucketed by the
  // unrounded duration and then rounded seconds inside that bucket, which
  // produced impossible "60s" / "60m" fields exactly there. Floored-at-
  // decomposition carries across units so this cannot happen on either
  // side of a minute or hour boundary.
  it("never emits a 60s field just under a minute boundary", () => {
    expect(formatRunningDurationMs(59_600)).toBe("59s");
    expect(formatRunningDurationMs(59_999)).toBe("59s");
    // The boundary itself rolls cleanly into the minute form.
    expect(formatRunningDurationMs(60_000)).toBe("1m 00s");
  });

  it("never emits a 60s field just under the next minute", () => {
    expect(formatRunningDurationMs(60_000 + 59_600)).toBe("1m 59s");
    expect(formatRunningDurationMs(2 * 60_000 - 1)).toBe("1m 59s");
  });

  it("never emits a 60m field just under an hour boundary", () => {
    expect(formatRunningDurationMs(59 * 60_000 + 59_600)).toBe("59m 59s");
    expect(formatRunningDurationMs(60 * 60_000 - 1)).toBe("59m 59s");
    expect(formatRunningDurationMs(60 * 60_000)).toBe("1h 0m");
  });
});
