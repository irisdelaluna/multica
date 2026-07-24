import { describe, expect, it } from "vitest";
import type { WorkspaceTimelineEntry } from "@multica/core/types";
import {
  activityDetail,
  activityVerb,
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
