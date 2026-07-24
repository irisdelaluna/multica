"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, AlertCircle, RefreshCw, Search, Cpu, Zap } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { AgentTask, WorkspaceTimelineEntry } from "@multica/core/types";
import { useWorkspaceId } from "@multica/core/hooks";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@multica/ui/components/ui/tooltip";
import {
  NativeSelect,
  NativeSelectOption,
} from "@multica/ui/components/ui/native-select";
import {
  CollectionPageHeader,
  CollectionPageState,
} from "../../layout/collection-page";
import { ActorAvatar } from "../../common/actor-avatar";
import { TranscriptButton } from "../../common/task-transcript";
import { IssueMentionCard } from "../../issues/components/issue-mention-card";
import { useT, useTimeAgo } from "../../i18n";
import {
  activityDetail,
  activityVerb,
  bareTaskId,
  formatRunningDurationMs,
  isInFlight,
  runningSince,
  taskStatusLabel,
  taskStatusTone,
} from "../describe";

type KindFilter = "all" | "activity" | "task" | "comment";

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
  // In-flight filter: isolates work the fleet hasn't finished (the broad
  // reading of "what is running right now" — running plus queued/dispatched/
  // waiting_local_directory). It layers on top of the kind/agent/project/
  // search predicates as a fourth predicate through the same `filtered` memo,
  // not a new control paradigm.
  const [inFlightOnly, setInFlightOnly] = useState(false);

  // Live updates: the server fans activity:created / task:* / issue:* /
  // comment:* out workspace-wide. A short debounce coalesces a burst so a
  // streaming task doesn't refetch on every token. The task handlers cover
  // the full workspace-facing lifecycle enumerated in
  // contract/maps/agent-pipeline.md (queued → dispatched →
  // waiting_local_directory → running → completed/failed/cancelled, plus the
  // coarse task:progress hint). task:message (per-token transcript) is
  // intentionally excluded — it has its own transcript surface, not a
  // lifecycle transition. daemon heartbeats are not timeline-worthy either.
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
  useWSEvent("comment:updated", onEvent);
  useWSEvent("task:queued", onEvent);
  useWSEvent("task:dispatch", onEvent);
  useWSEvent("task:running", onEvent);
  useWSEvent("task:waiting_local_directory", onEvent);
  useWSEvent("task:progress", onEvent);
  useWSEvent("task:completed", onEvent);
  useWSEvent("task:failed", onEvent);
  useWSEvent("task:cancelled", onEvent);
  useWSReconnect(onEvent);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (kind !== "all" && e.kind !== kind) return false;
      if (inFlightOnly && !isInFlight(e)) return false;
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
          e.content ?? "",
          getActorName(e.actor_type, e.actor_id),
        ]
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [entries, kind, inFlightOnly, agentId, projectId, query, getActorName]);

  const hasFilters =
    kind !== "all" || inFlightOnly || agentId !== "" || projectId !== "" || query !== "";

  // A running task's elapsed time is the one timestamp that changes on its
  // own, so tick once a second — but only while a running row is actually on
  // screen, so an idle feed never pays for a timer. `now` is passed down to
  // each row to drive the live "running for" duration.
  const hasRunningShown = filtered.some((e) => e.status === "running");
  const now = useNowTick(hasRunningShown);

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
          {(["all", "activity", "comment", "task"] as const).map((k) => (
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
                  : k === "comment"
                    ? t(($) => $.filter.comments)
                    : t(($) => $.filter.tasks)}
            </Button>
          ))}
        </div>

        <Button
          type="button"
          size="sm"
          variant={inFlightOnly ? "default" : "outline"}
          aria-pressed={inFlightOnly}
          onClick={() => setInFlightOnly((v) => !v)}
          className="h-7 px-2.5 text-xs"
        >
          <Zap aria-hidden="true" className="size-3.5" />
          {t(($) => $.filter.in_flight)}
        </Button>

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
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
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
                now={now}
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

// Build the minimal AgentTask the transcript dialog needs from a timeline
// entry. The dialog reads every optional field defensively (avatar/runtime
// lookups, live timer, work-dir copy all no-op when the field is absent), so
// only the id — which drives the messages fetch — and the fields we actually
// have are filled in. This reuses the same transcript path as the agent
// activity tab (no second transcript implementation).
function taskForTranscript(entry: WorkspaceTimelineEntry): AgentTask | null {
  const id = bareTaskId(entry);
  if (!id) return null;
  return {
    id,
    agent_id: entry.actor_id || "",
    runtime_id: "",
    issue_id: entry.issue_id ?? "",
    status: (entry.status as AgentTask["status"]) ?? "completed",
    priority: 0,
    dispatched_at: null,
    started_at: null,
    completed_at: null,
    result: null,
    error: entry.error ?? null,
    created_at: entry.created_at,
  };
}

interface SecondaryLine {
  text: string;
  tone: "muted" | "destructive";
  /** Optional small header rendered above the full value in the hover tooltip. */
  header?: string;
}

export function TimelineRow({
  entry,
  actorName,
  timeAgo,
  now,
}: {
  entry: WorkspaceTimelineEntry;
  actorName: string;
  timeAgo: (dateStr: string) => string;
  now: number;
}) {
  const { t } = useT("activity");
  const isSystem = entry.actor_type === "system" || !entry.actor_id;
  const name = isSystem ? null : actorName || entry.agent_name || null;
  const detail = entry.kind === "activity" ? activityDetail(entry) : "";
  const issueId = entry.issue_id ?? null;

  const task = entry.kind === "task" ? taskForTranscript(entry) : null;
  // Match the agent activity tab exactly: queued tasks have no messages yet,
  // so the transcript button is hidden to avoid opening a guaranteed-empty
  // dialog. Every other task status exposes the same transcript affordance.
  const showTranscript = task !== null && entry.status !== "queued";
  const isRunning = entry.status === "running";
  // Live elapsed-run timer. started_at (run time) is the right origin for
  // "how long has it been running"; created_at would include time parked in
  // the queue. Only running rows carry a started_at that advances, and the
  // page only ticks `now` while a running row is on screen.
  const since = runningSince(entry);
  const runningFor =
    isRunning && since != null ? formatRunningDurationMs(now - since) : null;

  // Secondary line: the one wide field most worth surfacing, kept on its own
  // truncated line with the full value available on hover. This is what keeps
  // the page from scrolling horizontally — the primary line holds only short
  // tokens, so nothing wide stays inline-unconstrained (the old inline
  // `truncate` spans applied white-space:nowrap without an effective width and
  // ran long content — a whole multi-paragraph trigger_summary, a raw error —
  // straight off the right edge).
  let secondary: SecondaryLine | null = null;
  if (entry.kind === "comment") {
    // Comment body is the most useful detail and can be long, so it rides on
    // the same truncated secondary line task trigger_summary uses — the row
    // stays one line and the full text is reachable on hover. This is what
    // keeps a multi-paragraph body from pushing the page sideways.
    const body = entry.content?.trim();
    if (body) secondary = { text: body, tone: "muted" };
  }
  if (entry.kind === "task") {
    const err = entry.error?.trim();
    const trigger = entry.trigger_summary?.trim();
    if (err) {
      secondary = { text: err, tone: "destructive", header: t(($) => $.error_label) };
    } else if (trigger) {
      secondary = { text: trigger, tone: "muted", header: t(($) => $.triggered_by) };
    }
  }
  // The issue title now lives in the mention chip on the primary line (below),
  // so it no longer doubles as the secondary line. That also closes the real
  // gap this page had: a task or comment row — whose secondary is the
  // error/trigger/body — previously showed only the bare identifier and never
  // the title.

  // Reuse the single source of truth for the issue-mention look
  // (IssueMentionCard → IssueChip: status icon + identifier + title) so a row
  // reads as the work it belongs to, not as a bare code, and stays visually
  // consistent with how comments and rich content reference an issue. The
  // entry already carries issue_identifier via the handler's LEFT JOIN; it is
  // the chip's zero-latency fallback label, and the chip enriches with the
  // title + current status from the cached issue query. IssueChip caps itself
  // at max-w-full and truncates the title, so the row cannot push sideways —
  // but ONLY if nothing wraps it in a flex container (that drops the cap); it
  // renders inline here, exactly as in rich content.
  const issueMention = issueId ? (
    <IssueMentionCard
      issueId={issueId}
      fallbackLabel={
        entry.issue_identifier ||
        t(($) => $.issue_short_fallback, { prefix: issueId.slice(0, 8) })
      }
    />
  ) : null;

  return (
    <li
      className={`group flex items-start gap-3 border-l-2 border-transparent px-5 py-3 transition-colors ${
        isRunning
          ? "border-brand/60 bg-brand/5 hover:bg-brand/10"
          : "hover:bg-muted/40"
      }`}
    >
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
        <p className="break-words text-sm leading-6">
          {name ? (
            <span className="font-medium">{name}</span>
          ) : (
            <span className="text-muted-foreground">
              {entry.kind === "task" ? entry.agent_name ?? "Agent" : "Someone"}
            </span>
          )}{" "}
          {entry.kind === "activity" ? (
            <>
              <span className="text-muted-foreground">{activityVerb(entry.action ?? "")}</span>{" "}
              {issueMention}
              {detail ? (
                <Badge variant="secondary" className="ml-2 font-normal">
                  {detail}
                </Badge>
              ) : null}
            </>
          ) : entry.kind === "comment" ? (
            <>
              <span className="text-muted-foreground">{t(($) => $.commented_on)}</span>{" "}
              {issueMention}
            </>
          ) : (
            <>
              <Badge
                variant="outline"
                className={`font-normal ${TONE_CLASS[taskStatusTone(entry.status)]}`}
              >
                {taskStatusLabel(entry.status)}
              </Badge>{" "}
              {issueMention}
            </>
          )}
        </p>

        {secondary ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <p
                  className={`mt-0.5 truncate text-xs ${
                    secondary.tone === "destructive"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }`}
                >
                  {secondary.text}
                </p>
              }
            />
            <TooltipContent className="max-w-lg">
              {secondary.header ? (
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
                  {secondary.header}
                </div>
              ) : null}
              <div className="mt-0.5 whitespace-pre-wrap break-words text-xs">
                {secondary.text}
              </div>
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <div className="flex shrink-0 items-start gap-2">
        {showTranscript && task ? (
          // Hover/focus-revealed action slot, mirroring the agent activity
          // tab's TaskRow so the transcript affordance is reached the same way
          // here and there. group-focus-within keeps it keyboard-reachable.
          <div className="flex items-center gap-0.5 pt-0.5 opacity-0 transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100">
            <TranscriptButton
              task={task}
              agentName={entry.agent_name ?? t(($) => $.kind_task)}
              isLive={isRunning}
              title={t(($) => $.transcript_tooltip)}
            />
          </div>
        ) : null}
        <div className="flex flex-col items-end gap-1">
          {runningFor ? (
            // Live "running for" — the one timestamp whose value is still
            // changing. Brand-tinted and marked with the same pulse the
            // header's Live indicator uses so a running row reads as live at
            // a glance, even mid-list. Sits above the enqueue time so the
            // eye lands on the active metric first.
            <span className="flex items-center gap-1.5 font-mono text-xs tabular-nums text-brand">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand/60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-brand" />
              </span>
              {t(($) => $.running_for, { duration: runningFor })}
            </span>
          ) : null}
          <time className="font-mono text-xs tabular-nums text-muted-foreground/70">
            {timeAgo(entry.created_at)}
          </time>
          {entry.kind === "task" ? (
            <Badge variant="outline" className="font-normal">
              {t(($) => $.kind_task)}
            </Badge>
          ) : null}
        </div>
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

// Ticking clock for the live running timer. Only ticks while `enabled` (a
// running row is on screen), so an idle feed holds a stable timestamp with no
// interval. Snaps to `now` the moment it enables so the first painted duration
// is correct rather than up to a second stale.
function useNowTick(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
  return now;
}
