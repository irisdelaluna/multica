-- name: ListActivitiesForIssue :many
-- All activities for an issue in chronological order, capped at $2 (DB safety
-- net to bound the response).
SELECT * FROM activity_log
WHERE issue_id = $1
ORDER BY created_at ASC, id ASC
LIMIT $2;

-- name: ListWorkspaceActivities :many
-- Workspace-wide recent activity for the live event timeline (backfill). The
-- LEFT JOIN to issue attaches project/identifier context so the timeline can
-- filter by project and render issue links without a client-side lookup pass.
-- Newest first, capped at $2.
SELECT
  a.id, a.workspace_id, a.issue_id, a.actor_type, a.actor_id, a.action, a.details, a.created_at,
  i.number AS issue_number, i.title AS issue_title, i.project_id
FROM activity_log a
LEFT JOIN issue i ON i.id = a.issue_id
WHERE a.workspace_id = $1
ORDER BY a.created_at DESC, a.id DESC
LIMIT $2;

-- name: GetActivity :one
SELECT * FROM activity_log
WHERE id = $1;

-- name: CreateActivity :one
INSERT INTO activity_log (
    workspace_id, issue_id, actor_type, actor_id, action, details
) VALUES ($1, $2, $3, $4, $5, $6)
RETURNING *;

-- name: HasSquadLeaderNoActionEvaluationForTask :one
SELECT EXISTS (
  SELECT 1
  FROM activity_log
  WHERE issue_id = @issue_id
    AND actor_type = 'agent'
    AND actor_id = @agent_id
    AND action = 'squad_leader_evaluated'
    AND details->>'outcome' = 'no_action'
    AND details->>'task_id' = @task_id::text
) AS exists;

-- name: CountAssigneeChangesByActor :many
-- Count how many times a user assigned each target via assignee_changed activities.
SELECT
  details->>'to_type' as assignee_type,
  details->>'to_id' as assignee_id,
  COUNT(*)::bigint as frequency
FROM activity_log
WHERE workspace_id = $1
  AND actor_id = $2
  AND actor_type = 'member'
  AND action = 'assignee_changed'
  AND details->>'to_type' IS NOT NULL
  AND details->>'to_id' IS NOT NULL
GROUP BY details->>'to_type', details->>'to_id';
