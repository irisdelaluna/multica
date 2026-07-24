"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, RefreshCw, Search, Cpu } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { WorkspaceTimelineEntry } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
import { useWorkspacePaths } from "@multica/core/paths";
import { activityFeedOptions, activityFeedKeys } from "@multica/core/activity-feed/queries";
import { agentListOptions } from "@multica/core/workspace/queries";
import { projectListOptions } from "@multica/core/projects/queries";
import { useActorName } from "@multica/core/workspace/hooks";
import { useWSEvent, useWSReconnect } from "@multica/core/realtime";
import { Button } from "@multica/ui/components/ui/button";
import { Input } from "@multica/ui/components/ui/input";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { Badge } from "@multica/ui/components/ui/badge";
import {
  NativeSelect,
  NativeSelectOption,
} from "@multica/ui/components/ui/native-select";
import {
  CollectionPageHeader,
  CollectionPageState,
} from "../../layout/collection-page";
import { ActorAvatar } from "../../common/actor-avatar";
import { AppLink } from "../../navigation";
import { useT, useTimeAgo } from "../../i18n";
import {
  activityDetail,
  activityVerb,
  taskStatusLabel,
  taskStatusTone,
} from "../describe";

type KindFilter = "all" | "activity" | "task";

const TONE_CLASS: Record<string, string> = {
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
  default: "text-foreground",
  secondary: "text-muted-foreground",
};

/**
 * Workspace-wide live event timeline. A unified, chronological, filterable
 * feed that merges workspace activity (issue events, status/assignee changes,
 * task completions, …) with daemon task lifecycle. It is a VIEW over existing
 * event data, not new state: React Query owns the cache and WS events keep it
 * live. The REST backfill + WS-invalidate seam is the swap point for the
 * future event firehose (v2 changes the feed, not the view).
 */
export function ActivityPage() {
  const wsId = useWorkspaceId();
  const qc = useQueryClient();
  const paths = useWorkspacePaths();
  const { t } = useT("activity");
  const timeAgo = useTimeAgo();
  const { getActorName } = useActorName();

  const {
    data: entries = [],
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery(activityFeedOptions(wsId));
  const { data: agents = [] } = useQuery(agentListOptions(wsId));
  const { data: projects = [] } = useQuery(projectListOptions(wsId));

  const [kind, setKind] = useState<KindFilter>("all");
  const [agentId, setAgentId] = useState<string>("");
  const [projectId, setProjectId] = useState<string>("");
  const [query, setQuery] = useState<string>("");

  // Live updates: the server fans activity:created / task:* / issue:* /
  // comment:* out workspace-wide. A short debounce coalesces a burst so a
  // streaming task doesn't refetch on every token. task:message (per-token
  // streaming) and daemon heartbeats are intentionally excluded — they are
  // not timeline-worthy transitions.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const invalidateFeed = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      qc.invalidateQueries({ queryKey: activityFeedKeys.list(wsId) });
    }, 500);
  }, [qc, wsId]);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onEvent = useCallback(() => invalidateFeed(), [invalidateFeed]);
  useWSEvent("activity:created", onEvent);
  useWSEvent("issue:created", onEvent);
  useWSEvent("issue:updated", onEvent);
  useWSEvent("comment:created", onEvent);
  useWSEvent("task:queued", onEvent);
  useWSEvent("task:dispatch", onEvent);
  useWSEvent("task:running", onEvent);
  useWSEvent("task:completed", onEvent);
  useWSEvent("task:failed", onEvent);
  useWSEvent("task:cancelled", onEvent);
  useWSReconnect(onEvent);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (kind !== "all" && e.kind !== kind) return false;
      if (agentId && e.actor_id !== agentId) return false;
      if (projectId && e.project_id !== projectId) return false;
      if (q) {
        const haystack = [
          e.action ?? "",
          e.issue_identifier ?? "",
          e.issue_title ?? "",
          e.agent_name ?? "",
          e.trigger_summary ?? "",
          e.status ?? "",
          getActorName(e.actor_type, e.actor_id),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [entries, kind, agentId, projectId, query, getActorName]);

  const hasFilters = kind !== "all" || agentId !== "" || projectId !== "" || query !== "";

  return (
    <div className="flex h-full flex-col">
      <CollectionPageHeader
        icon={Activity}
        title={t(($) => $.title)}
        count={entries.length}
        description={t(($) => $.subtitle)}
        actions={
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand/60" />
                <span className="relative inline-flex size-2 rounded-full bg-brand" />
              </span>
              {t(($) => $.live)}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-8 px-0 md:w-auto md:px-2.5"
              onClick={() => refetch()}
              disabled={isFetching}
              aria-label="Refresh"
            >
              <RefreshCw
                aria-hidden="true"
                className={`size-3.5 ${isFetching ? "animate-spin" : ""}`}
              />
              <span className="hidden md:inline">{t(($) => $.refresh)}</span>
            </Button>
          </div>
        }
      />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 border-b px-5 py-2.5">
        <div className="flex items-center rounded-lg border p-0.5">
          {(["all", "activity", "task"] as const).map((k) => (
            <Button
              key={k}
              type="button"
              size="sm"
              variant={kind === k ? "default" : "ghost"}
              className="h-7 px-2.5 text-xs"
              onClick={() => setKind(k)}
            >
              {k === "all"
                ? t(($) => $.filter.all)
                : k === "activity"
                  ? t(($) => $.filter.activities)
                  : t(($) => $.filter.tasks)}
            </Button>
          ))}
        </div>

        <NativeSelect
          size="sm"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          aria-label={t(($) => $.filter.agent)}
        >
          <NativeSelectOption value="">{t(($) => $.filter.any_agent)}</NativeSelectOption>
          {agents.map((a) => (
            <NativeSelectOption key={a.id} value={a.id}>
              {a.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        <NativeSelect
          size="sm"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          aria-label={t(($) => $.filter.project)}
        >
          <NativeSelectOption value="">{t(($) => $.filter.any_project)}</NativeSelectOption>
          {projects.map((p) => (
            <NativeSelectOption key={p.id} value={p.id}>
              {p.title}
            </NativeSelectOption>
          ))}
        </NativeSelect>

        <div className="relative min-w-40 flex-1 sm:max-w-64">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t(($) => $.filter.search)}
            className="h-8 pl-8 text-sm"
          />
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <TimelineSkeleton />
        ) : isError ? (
          <CollectionPageState
            icon={AlertCircle}
            tone="destructive"
            title={t(($) => $.state.error_title)}
            actions={
              <Button type="button" variant="outline" size="sm" onClick={() => refetch()}>
                <RefreshCw aria-hidden="true" className="size-3.5" />
                {t(($) => $.state.retry)}
              </Button>
            }
          />
        ) : filtered.length === 0 ? (
          <CollectionPageState
            icon={Activity}
            title={
              hasFilters ? t(($) => $.state.no_results) : t(($) => $.state.empty_title)
            }
            description={hasFilters ? undefined : t(($) => $.state.empty_description)}
          />
        ) : (
          <ol className="divide-y">
            {filtered.map((entry) => (
              <TimelineRow
                key={`${entry.kind}:${entry.id}`}
                entry={entry}
                actorName={getActorName(entry.actor_type, entry.actor_id)}
                timeAgo={timeAgo}
                taskLabel={t(($) => $.kind_task)}
                issueHref={
                  entry.issue_id ? paths.issueDetail(entry.issue_id) : null
                }
              />
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function TimelineRow({
  entry,
  actorName,
  timeAgo,
  taskLabel,
  issueHref,
}: {
  entry: WorkspaceTimelineEntry;
  actorName: string;
  timeAgo: (dateStr: string) => string;
  taskLabel: string;
  issueHref: string | null;
}) {
  const isSystem = entry.actor_type === "system" || !entry.actor_id;
  const name = isSystem ? null : actorName || entry.agent_name || null;
  const detail = entry.kind === "activity" ? activityDetail(entry) : "";

  return (
    <li className="flex items-start gap-3 px-5 py-3 transition-colors hover:bg-muted/40">
      <div className="mt-0.5 shrink-0">
        {isSystem ? (
          <span className="inline-flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <Cpu aria-hidden="true" className="size-3.5" />
          </span>
        ) : (
          <ActorAvatar actorType={entry.actor_type} actorId={entry.actor_id} size="sm" />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="text-sm leading-6">
          {name ? (
            <span className="font-medium">{name}</span>
          ) : (
            <span className="text-muted-foreground">{entry.kind === "task" ? entry.agent_name ?? "Agent" : "Someone"}</span>
          )}{" "}
          {entry.kind === "activity" ? (
            <>
              <span className="text-muted-foreground">{activityVerb(entry.action ?? "")}</span>{" "}
              {issueHref && entry.issue_identifier ? (
                <AppLink
                  href={issueHref}
                  className="font-medium text-foreground underline decoration-muted-foreground/30 underline-offset-4 hover:text-foreground"
                >
                  {entry.issue_identifier}
                </AppLink>
              ) : null}
              {entry.issue_title ? (
                <span className="truncate text-muted-foreground">
                  {" "}
                  &middot; {entry.issue_title}
                </span>
              ) : null}
              {detail ? (
                <Badge variant="secondary" className="ml-2 font-normal">
                  {detail}
                </Badge>
              ) : null}
            </>
          ) : (
            <>
              <Badge
                variant="outline"
                className={`font-normal ${TONE_CLASS[taskStatusTone(entry.status)]}`}
              >
                {taskStatusLabel(entry.status)}
              </Badge>{" "}
              {issueHref && entry.issue_identifier ? (
                <AppLink
                  href={issueHref}
                  className="font-medium text-foreground underline decoration-muted-foreground/30 underline-offset-4 hover:text-foreground"
                >
                  {entry.issue_identifier}
                </AppLink>
              ) : null}
              {entry.issue_title ? (
                <span className="truncate text-muted-foreground">
                  {" "}
                  &middot; {entry.issue_title}
                </span>
              ) : null}
              {entry.trigger_summary ? (
                <span className="truncate text-muted-foreground">
                  {" "}
                  &mdash; {entry.trigger_summary}
                </span>
              ) : null}
              {entry.error ? (
                <span className="ml-1 truncate text-destructive">{entry.error}</span>
              ) : null}
            </>
          )}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        <time className="font-mono text-xs tabular-nums text-muted-foreground/70">
          {timeAgo(entry.created_at)}
        </time>
        {entry.kind === "task" ? (
          <Badge variant="outline" className="font-normal">
            {taskLabel}
          </Badge>
        ) : null}
      </div>
    </li>
  );
}

function TimelineSkeleton() {
  return (
    <ol className="divide-y">
      {Array.from({ length: 8 }).map((_, i) => (
        <li key={i} className="flex items-center gap-3 px-5 py-3">
          <Skeleton className="size-7 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-3 w-12" />
        </li>
      ))}
    </ol>
  );
}
