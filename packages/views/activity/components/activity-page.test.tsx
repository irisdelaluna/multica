import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { WorkspaceTimelineEntry } from "@multica/core/types";

// TimelineRow is presentational: it composes a handful of neighbours
// (i18n, the issue-mention chip, the avatar, the transcript button). Mocking
// them isolates the decision under test — that an issue-bearing row renders
// the issue through the mention chip (title + identifier) instead of a bare
// code — without standing up React Query / WS / i18n providers.
vi.mock("../../i18n", () => ({
  useT: () => ({
    t: (_sel: unknown, vars?: { prefix?: string }) =>
      vars?.prefix ? `Issue ${vars.prefix}…` : "",
  }),
  useTimeAgo: () => () => "ago",
}));
vi.mock("../../issues/components/issue-mention-card", () => ({
  IssueMentionCard: ({
    issueId,
    fallbackLabel,
  }: {
    issueId: string;
    fallbackLabel?: string;
  }) => (
    <span
      data-testid="issue-mention"
      data-issue-id={issueId}
      data-fallback={fallbackLabel ?? ""}
    />
  ),
}));
vi.mock("../../common/actor-avatar", () => ({
  ActorAvatar: () => <span data-testid="actor-avatar" />,
}));
vi.mock("../../common/task-transcript", () => ({
  TranscriptButton: () => <span data-testid="transcript" />,
}));

const { TimelineRow } = await import("./activity-page");

function baseEntry(
  over: Partial<WorkspaceTimelineEntry>,
): WorkspaceTimelineEntry {
  return {
    kind: "activity",
    id: "e1",
    created_at: "2026-07-24T00:00:00Z",
    actor_type: "member",
    actor_id: "u1",
    ...over,
  } as WorkspaceTimelineEntry;
}

describe("TimelineRow issue reference", () => {
  it("renders the issue through the mention chip, carrying the identifier as the fallback label", () => {
    const entry = baseEntry({
      kind: "activity",
      action: "status_changed",
      issue_id: "issue-72",
      issue_identifier: "IRI-72",
      issue_title: "Timeline entries show issue codes instead of what the work is",
      details: { from: "todo", to: "in_progress" },
    });
    render(<TimelineRow entry={entry} actorName="Alice" timeAgo={() => "ago"} />);

    const chip = screen.getByTestId("issue-mention");
    expect(chip).toHaveAttribute("data-issue-id", "issue-72");
    // The identifier from the handler's LEFT JOIN is the zero-latency label.
    expect(chip).toHaveAttribute("data-fallback", "IRI-72");
  });

  it("renders the chip for a task row too, which previously showed only the bare identifier", () => {
    const entry = baseEntry({
      kind: "task",
      id: "task:11111111-2222-3333-4444-555555555555",
      status: "completed",
      agent_name: "Red Builder",
      issue_id: "issue-72",
      issue_identifier: "IRI-72",
      issue_title: "Timeline entries show issue codes instead of what the work is",
    });
    render(
      <TimelineRow entry={entry} actorName="Red Builder" timeAgo={() => "ago"} />,
    );

    expect(screen.getByTestId("issue-mention")).toHaveAttribute(
      "data-issue-id",
      "issue-72",
    );
  });

  it("falls back to a short-id label when the identifier is absent but an issue id is present", () => {
    const entry = baseEntry({
      kind: "activity",
      action: "issue_created",
      issue_id: "abcdefghijk",
      issue_identifier: "",
    });
    render(<TimelineRow entry={entry} actorName="Alice" timeAgo={() => "ago"} />);

    expect(screen.getByTestId("issue-mention")).toHaveAttribute(
      "data-fallback",
      "Issue abcdefgh…",
    );
  });

  it("renders no chip when the entry carries no issue", () => {
    const entry = baseEntry({ kind: "activity", action: "issue_created" });
    render(<TimelineRow entry={entry} actorName="Alice" timeAgo={() => "ago"} />);

    expect(screen.queryByTestId("issue-mention")).toBeNull();
  });
});
