package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func fetchWorkspaceTimeline(t *testing.T) ([]WorkspaceTimelineEntry, int) {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("GET", "/api/workspace-timeline?workspace_id="+testWorkspaceID, nil)
	testHandler.ListWorkspaceTimeline(w, req)
	var entries []WorkspaceTimelineEntry
	if w.Code == http.StatusOK {
		if err := json.NewDecoder(w.Body).Decode(&entries); err != nil {
			t.Fatalf("decode timeline: %v (body=%s)", err, w.Body.String())
		}
	}
	return entries, w.Code
}

// createWorkspaceTimelineIssue creates an issue and cleans up its dependent
// rows (activity_log + agent_task_queue) alongside the issue itself, so the
// shared test workspace does not accumulate timeline fixtures.
func createWorkspaceTimelineIssue(t *testing.T, title string) string {
	t.Helper()
	w := httptest.NewRecorder()
	req := newRequest("POST", "/api/issues?workspace_id="+testWorkspaceID, map[string]any{
		"title":  title,
		"status": "todo",
	})
	testHandler.CreateIssue(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("CreateIssue: expected 201, got %d: %s", w.Code, w.Body.String())
	}
	var issue IssueResponse
	json.NewDecoder(w.Body).Decode(&issue)
	t.Cleanup(func() {
		ctx := context.Background()
		testPool.Exec(ctx, `DELETE FROM activity_log WHERE issue_id = $1`, issue.ID)
		testPool.Exec(ctx, `DELETE FROM agent_task_queue WHERE issue_id = $1`, issue.ID)
		testPool.Exec(ctx, `DELETE FROM issue WHERE id = $1`, issue.ID)
	})
	return issue.ID
}

// TestListWorkspaceTimeline_MergesActivitiesAndTasks verifies the endpoint
// returns a newest-first feed that merges activity_log rows and agent task
// runs, each enriched with issue context (identifier built from the workspace
// prefix). The activity is seeded older than the task so we can assert order.
func TestListWorkspaceTimeline_MergesActivitiesAndTasks(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	ctx := context.Background()
	issueID := createWorkspaceTimelineIssue(t, "Workspace timeline merge test")

	// Older activity row.
	older := time.Now().UTC().Add(-2 * time.Minute)
	var activityID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO activity_log (workspace_id, issue_id, actor_type, actor_id, action, details, created_at)
		VALUES ($1, $2, 'member', $3, 'status_changed', '{"from":"todo","to":"in_progress"}'::jsonb, $4)
		RETURNING id
	`, testWorkspaceID, issueID, testUserID, older).Scan(&activityID); err != nil {
		t.Fatalf("seed activity: %v", err)
	}

	// Newer task run.
	agentID := createHandlerTestAgent(t, "Workspace Timeline Test Agent", nil)
	newer := time.Now().UTC()
	var taskID string
	if err := testPool.QueryRow(ctx, `
		INSERT INTO agent_task_queue (agent_id, issue_id, status, priority, context, runtime_id, created_at)
		VALUES ($1, $2, 'completed', 1, '{}'::jsonb, $3, $4)
		RETURNING id
	`, agentID, issueID, handlerTestRuntimeID(t), newer).Scan(&taskID); err != nil {
		t.Fatalf("seed task: %v", err)
	}

	entries, status := fetchWorkspaceTimeline(t)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}

	// Locate the two seeded entries (the shared workspace may carry other rows).
	var gotActivity, gotTask *WorkspaceTimelineEntry
	for i := range entries {
		if entries[i].Kind == "activity" && entries[i].ID == activityID {
			gotActivity = &entries[i]
		}
		if entries[i].Kind == "task" && entries[i].ID == "task:"+taskID {
			gotTask = &entries[i]
		}
	}
	if gotActivity == nil {
		t.Fatalf("seeded activity %s missing from timeline", activityID)
	}
	if gotTask == nil {
		t.Fatalf("seeded task %s missing from timeline", taskID)
	}

	// Activity enrichment: issue context (identifier from workspace prefix)
	// and actor.
	if gotActivity.IssueID != issueID {
		t.Errorf("activity issue_id = %s, want %s", gotActivity.IssueID, issueID)
	}
	if gotActivity.IssueIdentifier == "" {
		t.Errorf("activity issue_identifier empty; want <prefix>-<number>")
	}
	if gotActivity.ActorType != "member" || gotActivity.ActorID != testUserID {
		t.Errorf("activity actor = %s/%s, want member/%s", gotActivity.ActorType, gotActivity.ActorID, testUserID)
	}
	if gotActivity.Action == nil || *gotActivity.Action != "status_changed" {
		t.Errorf("activity action = %v, want status_changed", gotActivity.Action)
	}

	// Task enrichment: agent actor + status + issue context.
	if gotTask.ActorType != "agent" || gotTask.ActorID != agentID {
		t.Errorf("task actor = %s/%s, want agent/%s", gotTask.ActorType, gotTask.ActorID, agentID)
	}
	if gotTask.Status != "completed" {
		t.Errorf("task status = %s, want completed", gotTask.Status)
	}
	if gotTask.AgentName != "Workspace Timeline Test Agent" {
		t.Errorf("task agent_name = %q, want seeded name", gotTask.AgentName)
	}
	if gotTask.IssueIdentifier == "" {
		t.Errorf("task issue_identifier empty; want <prefix>-<number>")
	}

	// Newest-first: the seeded task (newer) must precede the seeded activity
	// (older) in the merged feed.
	for i := range entries {
		if entries[i].ID == gotTask.ID {
			break
		}
		if entries[i].ID == gotActivity.ID {
			t.Fatalf("activity appears before task; feed must be newest-first")
		}
	}
}

// TestListWorkspaceTimeline_AlwaysArray confirms the endpoint never returns a
// JSON null — an empty result is an empty array (sqlc emit_empty_slices). The
// workspace is shared, so we assert shape, not count.
func TestListWorkspaceTimeline_AlwaysArray(t *testing.T) {
	if testHandler == nil {
		t.Skip("database not available")
	}
	entries, status := fetchWorkspaceTimeline(t)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want 200", status)
	}
	if entries == nil {
		t.Fatalf("entries = nil, want non-nil array")
	}
}
