import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";

// React Query keys for the workspace-wide live event timeline. Workspace-scoped
// (wsId at index 1) following the ["workspaces", wsId, <domain>] convention used
// by the neighboring agent/runtimes/dashboard key families. The view subscribes
// to the WS workspace event stream and invalidates `list(wsId)` to stay live.
export const activityFeedKeys = {
  all: (wsId: string) => ["workspaces", wsId, "activity-feed"] as const,
  list: (wsId: string) => [...activityFeedKeys.all(wsId), "list"] as const,
};

// Workspace-wide live event timeline backfill. WS events (activity:created,
// task:*, issue:*, comment:*) invalidate this query from the view; the short
// staleTime is a tab-focus / mount safety net only.
export function activityFeedOptions(wsId: string) {
  return queryOptions({
    queryKey: activityFeedKeys.list(wsId),
    queryFn: () => api.listWorkspaceTimeline(),
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });
}
