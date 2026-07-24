package handler

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
	db "github.com/multica-ai/multica/server/pkg/db/generated"
)

// TimelineEntry represents a single entry in the issue timeline, which can be
// either an activity log record or a comment.
type TimelineEntry struct {
	Type string `json:"type"` // "activity" or "comment"
	ID   string `json:"id"`

	ActorType string `json:"actor_type"`
	ActorID   string `json:"actor_id"`
	CreatedAt string `json:"created_at"`

	// Activity-only fields
	Action  *string         `json:"action,omitempty"`
	Details json.RawMessage `json:"details,omitempty"`

	// Comment-only fields
	Content        *string              `json:"content,omitempty"`
	ParentID       *string              `json:"parent_id,omitempty"`
	UpdatedAt      *string              `json:"updated_at,omitempty"`
	CommentType    *string              `json:"comment_type,omitempty"`
	Reactions      []ReactionResponse   `json:"reactions,omitempty"`
	Attachments    []AttachmentResponse `json:"attachments,omitempty"`
	ResolvedAt     *string              `json:"resolved_at,omitempty"`
	ResolvedByType *string              `json:"resolved_by_type,omitempty"`
	ResolvedByID   *string              `json:"resolved_by_id,omitempty"`
	SourceTaskID   *string              `json:"source_task_id,omitempty"`
}

// timelineHardCap bounds the per-issue timeline payload. Sized as a defensive
// safety net, not a UX page window: see commentHardCap in comment.go for the
// data-shape rationale (#1929).
const timelineHardCap = 2000

// timelinePaginatedResponse mirrors the wrapper shape produced by the prior
// cursor-paginated ListTimeline (#2128). It is preserved as a backward-compat
// surface for installed Desktop builds and stale Web bundles between #2128 and
// #1929 that send `?limit=`/`?before=`/`?after=`/`?around=` and parse the
// response with the old TimelinePageSchema (entries + cursors). Cursors are
// always nil and `has_more_*` are always false: the new server returns the
// whole timeline in one shot.
type timelinePaginatedResponse struct {
	Entries       []TimelineEntry `json:"entries"`
	NextCursor    *string         `json:"next_cursor"`
	PrevCursor    *string         `json:"prev_cursor"`
	HasMoreBefore bool            `json:"has_more_before"`
	HasMoreAfter  bool            `json:"has_more_after"`
	TargetIndex   *int            `json:"target_index,omitempty"`
}

// ListTimeline returns the full issue timeline (comments + activities merged).
// Two response shapes coexist for boundary compatibility (#1929):
//
//   - No pagination params → flat ASC `TimelineEntry[]`. Matches the legacy
//     desktop contract (Multica.app ≤ v0.2.25) and the new client.
//   - Any of `limit` / `before` / `after` / `around` present → wrapped object
//     with DESC entries + null cursors + has_more_*=false. Matches what a
//     stale v0.2.26+ build expects when it parses the response with
//     TimelinePageSchema; cursor-walking is now a no-op so the client just
//     sees a single full page.
//
// Both shapes carry the same set of entries — paging and ordering differ.
// Time-based pagination was removed because it split reply threads at page
// boundaries, and at observed data sizes (p99 ~30 comments per issue) the
// cursor machinery was pure overhead.
func (h *Handler) ListTimeline(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	issue, ok := h.loadIssueForUser(w, r, id)
	if !ok {
		return
	}
	ctx := r.Context()

	comments, err := h.Queries.ListCommentsForIssue(ctx, db.ListCommentsForIssueParams{
		IssueID:     issue.ID,
		WorkspaceID: issue.WorkspaceID,
		Limit:       timelineHardCap,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list comments")
		return
	}
	activities, err := h.Queries.ListActivitiesForIssue(ctx, db.ListActivitiesForIssueParams{
		IssueID: issue.ID,
		Limit:   timelineHardCap,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list activities")
		return
	}

	q := r.URL.Query()
	wantWrapped := q.Get("limit") != "" || q.Get("before") != "" ||
		q.Get("after") != "" || q.Get("around") != ""

	if wantWrapped {
		entries := h.mergeTimeline(r, comments, activities, false)
		if entries == nil {
			entries = []TimelineEntry{}
		}
		resp := timelinePaginatedResponse{Entries: entries}
		// `around=<id>`: locate the anchor in the DESC slice so the legacy
		// client can scroll-to-highlight without a follow-up request.
		if anchor := q.Get("around"); anchor != "" {
			for i, e := range entries {
				if e.ID == anchor {
					idx := i
					resp.TargetIndex = &idx
					break
				}
			}
		}
		writeJSON(w, http.StatusOK, resp)
		return
	}

	entries := h.mergeTimeline(r, comments, activities, true)
	if entries == nil {
		entries = []TimelineEntry{}
	}
	writeJSON(w, http.StatusOK, entries)
}

// mergeTimeline merges comments and activities and returns them sorted by
// (created_at, id). When ascending=true, oldest first (the new flat-array
// contract); otherwise newest first (the wrapped legacy contract).
func (h *Handler) mergeTimeline(r *http.Request, comments []db.Comment, activities []db.ActivityLog, ascending bool) []TimelineEntry {
	out := make([]TimelineEntry, 0, len(comments)+len(activities))
	out = append(out, h.commentsToEntries(r, comments)...)
	for _, a := range activities {
		out = append(out, activityToEntry(a))
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			if ascending {
				return out[i].CreatedAt < out[j].CreatedAt
			}
			return out[i].CreatedAt > out[j].CreatedAt
		}
		if ascending {
			return out[i].ID < out[j].ID
		}
		return out[i].ID > out[j].ID
	})
	return out
}

// commentsToEntries fetches reactions + attachments for the given comments in
// one batch each and returns enriched TimelineEntry slices preserving order.
func (h *Handler) commentsToEntries(r *http.Request, comments []db.Comment) []TimelineEntry {
	if len(comments) == 0 {
		return nil
	}
	ids := make([]pgtype.UUID, len(comments))
	for i, c := range comments {
		ids[i] = c.ID
	}
	reactions := h.groupReactions(r, ids)
	attachments := h.groupAttachments(r, ids)

	out := make([]TimelineEntry, len(comments))
	for i, c := range comments {
		content := c.Content
		commentType := c.Type
		updatedAt := timestampToString(c.UpdatedAt)
		cid := uuidToString(c.ID)
		out[i] = TimelineEntry{
			Type:           "comment",
			ID:             cid,
			ActorType:      c.AuthorType,
			ActorID:        uuidToString(c.AuthorID),
			Content:        &content,
			CommentType:    &commentType,
			ParentID:       uuidToPtr(c.ParentID),
			CreatedAt:      timestampToString(c.CreatedAt),
			UpdatedAt:      &updatedAt,
			Reactions:      reactions[cid],
			Attachments:    attachments[cid],
			ResolvedAt:     timestampToPtr(c.ResolvedAt),
			ResolvedByType: textToPtr(c.ResolvedByType),
			ResolvedByID:   uuidToPtr(c.ResolvedByID),
			SourceTaskID:   uuidToPtr(c.SourceTaskID),
		}
	}
	return out
}

func activityToEntry(a db.ActivityLog) TimelineEntry {
	action := a.Action
	actorType := ""
	if a.ActorType.Valid {
		actorType = a.ActorType.String
	}
	return TimelineEntry{
		Type:      "activity",
		ID:        uuidToString(a.ID),
		ActorType: actorType,
		ActorID:   uuidToString(a.ActorID),
		Action:    &action,
		Details:   a.Details,
		CreatedAt: timestampToString(a.CreatedAt),
	}
}

// AssigneeFrequencyEntry represents how often a user assigns to a specific target.
type AssigneeFrequencyEntry struct {
	AssigneeType string `json:"assignee_type"`
	AssigneeID   string `json:"assignee_id"`
	Frequency    int64  `json:"frequency"`
}

// GetAssigneeFrequency returns assignee usage frequency for the current user,
// combining data from assignee change activities and initial issue assignments.
func (h *Handler) GetAssigneeFrequency(w http.ResponseWriter, r *http.Request) {
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	workspaceID := h.resolveWorkspaceID(r)

	// Aggregate frequency from both data sources.
	freq := map[string]int64{} // key: "type:id"

	// Source 1: assignee_changed activities by this user.
	activityCounts, err := h.Queries.CountAssigneeChangesByActor(r.Context(), db.CountAssigneeChangesByActorParams{
		WorkspaceID: parseUUID(workspaceID),
		ActorID:     parseUUID(userID),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get assignee frequency")
		return
	}
	for _, row := range activityCounts {
		aType, _ := row.AssigneeType.(string)
		aID, _ := row.AssigneeID.(string)
		if aType != "" && aID != "" {
			freq[aType+":"+aID] += row.Frequency
		}
	}

	// Source 2: issues created by this user with an assignee.
	issueCounts, err := h.Queries.CountCreatedIssueAssignees(r.Context(), db.CountCreatedIssueAssigneesParams{
		WorkspaceID: parseUUID(workspaceID),
		CreatorID:   parseUUID(userID),
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to get assignee frequency")
		return
	}
	for _, row := range issueCounts {
		if !row.AssigneeType.Valid || !row.AssigneeID.Valid {
			continue
		}
		key := row.AssigneeType.String + ":" + uuidToString(row.AssigneeID)
		freq[key] += row.Frequency
	}

	// Build sorted response.
	result := make([]AssigneeFrequencyEntry, 0, len(freq))
	for key, count := range freq {
		// Split "type:id" — type is always "member" or "agent" (no colons).
		var aType, aID string
		for i := 0; i < len(key); i++ {
			if key[i] == ':' {
				aType = key[:i]
				aID = key[i+1:]
				break
			}
		}
		result = append(result, AssigneeFrequencyEntry{
			AssigneeType: aType,
			AssigneeID:   aID,
			Frequency:    count,
		})
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].Frequency > result[j].Frequency
	})

	writeJSON(w, http.StatusOK, result)
}

// workspaceTimelineCap bounds the workspace-wide timeline payload. Sized as a
// backfill window for the live event timeline (the view goes live over WS); it
// is not a per-issue UX window like timelineHardCap.
const workspaceTimelineCap = 500

// WorkspaceTimelineEntry is one row of the workspace-wide live event timeline.
// It unifies three existing event streams — activity_log (issue events, status /
// assignee changes, task completions, env reveals, squad evaluations, …),
// agent_task_queue (daemon task lifecycle), and comment (conversational
// activity) — into a single chronological feed.
//
// This is intentionally a self-contained response shape, separate from the
// issue-scoped TimelineEntry (which is `activity | comment` and tied to one
// issue's context). The workspace timeline owns its own entry type so the view
// can be re-pointed at the future event firehose without disturbing the issue
// timeline contract (IRI-36 / "v2 swaps its feed to the firehose without
// changing the view").
type WorkspaceTimelineEntry struct {
	Kind      string `json:"kind"` // "activity" | "task" | "comment"
	ID        string `json:"id"`
	CreatedAt string `json:"created_at"`

	// Common actor context. For activities this is the activity actor; for
	// tasks the "actor" is the agent that ran the task; for comments it is the
	// comment author.
	ActorType string `json:"actor_type"`
	ActorID   string `json:"actor_id"`

	// Issue context (present when the entry is tied to an issue). Identifier is
	// the human-readable "<prefix>-<number>" form, built from the workspace
	// issue prefix; empty for non-issue rows.
	IssueID         string `json:"issue_id,omitempty"`
	IssueIdentifier string `json:"issue_identifier,omitempty"`
	IssueTitle      string `json:"issue_title,omitempty"`
	ProjectID       string `json:"project_id,omitempty"`

	// Activity-only fields.
	Action  *string         `json:"action,omitempty"`
	Details json.RawMessage `json:"details,omitempty"`

	// Task-only fields.
	Status         string  `json:"status,omitempty"`
	AgentName      string  `json:"agent_name,omitempty"`
	AgentAvatarURL string  `json:"agent_avatar_url,omitempty"`
	Error          *string `json:"error,omitempty"`
	TriggerSummary *string `json:"trigger_summary,omitempty"`

	// Comment-only fields. The body is shipped in full so the view can show it
	// in a hover tooltip; the row itself truncates it client-side (the same
	// truncate-in-flex pattern task trigger_summary already uses), which is what
	// keeps the page from scrolling horizontally on long bodies.
	Content *string `json:"content,omitempty"`
}

// ListWorkspaceTimeline returns the workspace-wide live event timeline: a
// merged, newest-first feed of recent activity_log entries, agent task runs,
// and comments. It is the backfill / reconnect-recovery source for the activity
// timeline view; the view stays live by invalidating this cache on the WS
// workspace event stream (activity:created, task:*, issue:*, comment:*),
// which the server already fans out workspace-wide.
//
// This is a VIEW over existing event data, not new state: nothing is written,
// and no client-side store mirrors the payload (React Query owns the cache).
func (h *Handler) ListWorkspaceTimeline(w http.ResponseWriter, r *http.Request) {
	workspaceID := h.resolveWorkspaceID(r)
	if workspaceID == "" {
		writeError(w, http.StatusBadRequest, "workspace_id is required")
		return
	}
	wsUUID := parseUUID(workspaceID)
	ctx := r.Context()

	limit := int32(workspaceTimelineCap)
	if q := r.URL.Query().Get("limit"); q != "" {
		if n, err := strconv.Atoi(q); err == nil && n > 0 && n < int(workspaceTimelineCap) {
			limit = int32(n)
		}
	}

	prefix := h.getIssuePrefix(ctx, wsUUID)

	activities, err := h.Queries.ListWorkspaceActivities(ctx, db.ListWorkspaceActivitiesParams{
		WorkspaceID: wsUUID,
		Limit:       limit,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list workspace activities")
		return
	}
	tasks, err := h.Queries.ListWorkspaceTasksForWorkspace(ctx, db.ListWorkspaceTasksForWorkspaceParams{
		WorkspaceID: wsUUID,
		Limit:       limit,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list workspace tasks")
		return
	}
	comments, err := h.Queries.ListWorkspaceComments(ctx, db.ListWorkspaceCommentsParams{
		WorkspaceID: wsUUID,
		Limit:       limit,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to list workspace comments")
		return
	}

	out := make([]WorkspaceTimelineEntry, 0, len(activities)+len(tasks)+len(comments))
	for _, a := range activities {
		out = append(out, workspaceActivityToEntry(a, prefix))
	}
	for _, t := range tasks {
		out = append(out, workspaceTaskToEntry(t, prefix))
	}
	for _, c := range comments {
		out = append(out, workspaceCommentToEntry(c, prefix))
	}
	// Newest first; secondary key keeps a deterministic order on identical
	// timestamps (ids are independent origins, so the tiebreak is cosmetic).
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedAt != out[j].CreatedAt {
			return out[i].CreatedAt > out[j].CreatedAt
		}
		return out[i].ID > out[j].ID
	})
	if int32(len(out)) > limit {
		out = out[:limit]
	}

	writeJSON(w, http.StatusOK, out)
}

func issueIdentifier(prefix string, number pgtype.Int4) string {
	if !number.Valid || prefix == "" {
		return ""
	}
	return prefix + "-" + strconv.Itoa(int(number.Int32))
}

func workspaceActivityToEntry(a db.ListWorkspaceActivitiesRow, prefix string) WorkspaceTimelineEntry {
	action := a.Action
	actorType := ""
	if a.ActorType.Valid {
		actorType = a.ActorType.String
	}
	e := WorkspaceTimelineEntry{
		Kind:      "activity",
		ID:        uuidToString(a.ID),
		CreatedAt: timestampToString(a.CreatedAt),
		ActorType: actorType,
		ActorID:   uuidToString(a.ActorID),
		Action:    &action,
		Details:   a.Details,
		IssueID:   uuidToString(a.IssueID),
		ProjectID: uuidToString(a.ProjectID),
	}
	if ident := issueIdentifier(prefix, a.IssueNumber); ident != "" {
		e.IssueIdentifier = ident
	}
	if a.IssueTitle.Valid {
		e.IssueTitle = a.IssueTitle.String
	}
	return e
}

func workspaceTaskToEntry(t db.ListWorkspaceTasksForWorkspaceRow, prefix string) WorkspaceTimelineEntry {
	e := WorkspaceTimelineEntry{
		Kind:           "task",
		ID:             "task:" + uuidToString(t.ID),
		CreatedAt:      timestampToString(t.CreatedAt),
		ActorType:      "agent",
		ActorID:        uuidToString(t.AgentID),
		Status:         t.Status,
		AgentName:      t.AgentName,
		Error:          textToPtr(t.Error),
		TriggerSummary: textToPtr(t.TriggerSummary),
		IssueID:        uuidToString(t.IssueID),
		ProjectID:      uuidToString(t.ProjectID),
	}
	if t.AgentAvatarUrl.Valid {
		e.AgentAvatarURL = t.AgentAvatarUrl.String
	}
	if ident := issueIdentifier(prefix, t.IssueNumber); ident != "" {
		e.IssueIdentifier = ident
	}
	if t.IssueTitle.Valid {
		e.IssueTitle = t.IssueTitle.String
	}
	return e
}

func workspaceCommentToEntry(c db.ListWorkspaceCommentsRow, prefix string) WorkspaceTimelineEntry {
	content := c.Content
	e := WorkspaceTimelineEntry{
		Kind:      "comment",
		ID:        uuidToString(c.ID),
		CreatedAt: timestampToString(c.CreatedAt),
		ActorType: c.AuthorType,
		ActorID:   uuidToString(c.AuthorID),
		Content:   &content,
		IssueID:   uuidToString(c.IssueID),
		ProjectID: uuidToString(c.ProjectID),
	}
	if ident := issueIdentifier(prefix, c.IssueNumber); ident != "" {
		e.IssueIdentifier = ident
	}
	if c.IssueTitle.Valid {
		e.IssueTitle = c.IssueTitle.String
	}
	return e
}
