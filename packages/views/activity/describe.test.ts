import { describe, expect, it } from "vitest";
import type { WorkspaceTimelineEntry } from "@multica/core/types";
import {
  activityDetail,
  activityVerb,
  bareTaskId,
  humanizeAction,
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
