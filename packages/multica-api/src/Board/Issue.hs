{-# LANGUAGE OverloadedStrings #-}

-- | Issues.
--
-- __The envelope half of the split.__ @GET \/api\/issues@ returns
-- @{issues, total}@ (@server/internal/handler/issue.go:1269-1271@), where
-- @GET \/api\/workspaces@ returns a bare array. 'IssuePage' is a decoder for
-- exactly that one envelope; it is not an instance of a generic
-- @Envelope a@, because the surface's envelopes disagree about both the key
-- and whether a count is carried at all (@\/api\/runtime-profiles@ →
-- @{runtime_profiles}@ with no @total@, @runtime_profile.go:225@). Two
-- decoders, no generalisation. See "Board.Workspace" for the other half.
module Board.Issue
  ( -- * Issue
    Issue (..)
  , IssueId
  , Project

    -- * Open enums
  , IssueStatus
  , KnownStatus (..)
  , statusText
  , IssuePriority
  , KnownPriority (..)
  , priorityText

    -- * Labels
  , IssueLabel (..)

    -- * Endpoints
  , IssuePage (..)
  , listIssues
  , getIssue
  ) where

import Data.Aeson (FromJSON (..), Object, withObject, (.:))
import Data.Text (Text)
import Ubiquity.Identifier (Id, idText)
import Ubiquity.Scope (WorkspaceScope, scopeQuery)
import Ubiquity.Time (CalendarDate, Timestamp)
import Ubiquity.Transport (ApiError, Transport, getJson)
import Ubiquity.Wire
  ( OpenEnum
  , alwaysNull
  , emptyIsUnset
  , openEnum
  , openEnumText
  )

import Board.Actor (IssueAssignee, IssueCreator, parseIssueAssignee, parseIssueCreator)
import Board.Workspace (Workspace, WorkspaceId)

type IssueId = Id Issue

-- | Uninhabited phantom tag; projects are outside this slice.
data Project

-- | The seven statuses the DB CHECK admits (@001_init.up.sql:58@). Wrapped in
-- 'OpenEnum' on the wire — see "Board.Actor" for why status is open and
-- assignee kind is not.
data KnownStatus
  = Backlog
  | Todo
  | InProgress
  | InReview
  | Done
  | Blocked
  | Cancelled
  deriving stock (Eq, Ord, Show, Enum, Bounded)

type IssueStatus = OpenEnum KnownStatus

recogniseStatus :: Text -> Maybe KnownStatus
recogniseStatus t = case t of
  "backlog" -> Just Backlog
  "todo" -> Just Todo
  "in_progress" -> Just InProgress
  "in_review" -> Just InReview
  "done" -> Just Done
  "blocked" -> Just Blocked
  "cancelled" -> Just Cancelled
  _ -> Nothing

renderStatus :: KnownStatus -> Text
renderStatus s = case s of
  Backlog -> "backlog"
  Todo -> "todo"
  InProgress -> "in_progress"
  InReview -> "in_review"
  Done -> "done"
  Blocked -> "blocked"
  Cancelled -> "cancelled"

statusText :: IssueStatus -> Text
statusText = openEnumText renderStatus

-- | @issue.priority@ is a __string__ enum (@001_init.up.sql:59-60@).
-- @task.priority@ is an @int32@ (@agent.go:287@). Same word, two resources,
-- two types — which is exactly why there is no @Priority@ in 'Ubiquity'.
data KnownPriority
  = Urgent
  | High
  | Medium
  | Low
  | NoPriority
  deriving stock (Eq, Ord, Show, Enum, Bounded)

type IssuePriority = OpenEnum KnownPriority

recognisePriority :: Text -> Maybe KnownPriority
recognisePriority t = case t of
  "urgent" -> Just Urgent
  "high" -> Just High
  "medium" -> Just Medium
  "low" -> Just Low
  "none" -> Just NoPriority
  _ -> Nothing

renderPriority :: KnownPriority -> Text
renderPriority p = case p of
  Urgent -> "urgent"
  High -> "high"
  Medium -> "medium"
  Low -> "low"
  NoPriority -> "none"

priorityText :: IssuePriority -> Text
priorityText = openEnumText renderPriority

-- | A label as it appears inlined on an issue.
data IssueLabel = IssueLabel
  { labelId :: Id IssueLabel
  , labelWorkspaceId :: WorkspaceId
  , labelName :: Text
  , labelDescription :: Maybe Text
  -- ^ @""@ when unset, not @null@ — a third null strategy, in the same
  -- response as the other two.
  , labelColor :: Text
  , labelResourceType :: Text
  , labelUsageCount :: Int
  }
  deriving stock (Eq, Show)

instance FromJSON IssueLabel where
  parseJSON = withObject "IssueLabel" $ \o ->
    IssueLabel
      <$> o .: "id"
      <*> o .: "workspace_id"
      <*> o .: "name"
      <*> emptyIsUnset o "description"
      <*> o .: "color"
      <*> o .: "resource_type"
      <*> o .: "usage_count"

-- | An issue.
--
-- Three numeric fields that are not identifiers: 'issueNumber' (composes with
-- the workspace prefix into 'issueIdentifier'), 'issuePosition' (board order,
-- and negative in practice), and 'issueStage' (nullable, and @null@ on the
-- large majority of live issues — its absence is ordinary, not exceptional).
data Issue = Issue
  { issueIdOf :: IssueId
  , issueWorkspaceId :: WorkspaceId
  , issueNumber :: Int
  , issueIdentifier :: Text
  , issueTitle :: Text
  , issueDescription :: Maybe Text
  , issueStatus :: IssueStatus
  , issuePriority :: IssuePriority
  , issueAssignee :: Maybe IssueAssignee
  -- ^ Genuinely optional: unassigned is a state the board has.
  , issueCreator :: IssueCreator
  -- ^ Never optional. No 'Maybe'.
  , issueParent :: Maybe IssueId
  , issueProject :: Maybe (Id Project)
  , issuePosition :: Int
  , issueStage :: Maybe Int
  , issueStartDate :: Maybe CalendarDate
  , issueDueDate :: Maybe CalendarDate
  , issueCreatedAt :: Timestamp
  , issueUpdatedAt :: Timestamp
  , issueMetadata :: Object
  , issueProperties :: Object
  , issueLabels :: [IssueLabel]
  }
  deriving stock (Eq, Show)

instance FromJSON Issue where
  parseJSON = withObject "Issue" $ \o ->
    Issue
      <$> o .: "id"
      <*> o .: "workspace_id"
      <*> o .: "number"
      <*> o .: "identifier"
      <*> o .: "title"
      <*> alwaysNull o "description"
      <*> (openEnum recogniseStatus <$> o .: "status")
      <*> (openEnum recognisePriority <$> o .: "priority")
      <*> parseIssueAssignee o
      <*> parseIssueCreator o
      <*> alwaysNull o "parent_issue_id"
      <*> alwaysNull o "project_id"
      <*> o .: "position"
      <*> alwaysNull o "stage"
      <*> alwaysNull o "start_date"
      <*> alwaysNull o "due_date"
      <*> o .: "created_at"
      <*> o .: "updated_at"
      <*> o .: "metadata"
      <*> o .: "properties"
      <*> o .: "labels"

-- | The @{issues, total}@ envelope, and nothing else.
--
-- 'pageTotal' is decoded but not acted on: pagination is out of this slice
-- (IRI-44). It is kept because dropping it would make the envelope
-- indistinguishable from a bare array in the type, and the difference between
-- those two is the thing this package exists to record.
data IssuePage = IssuePage
  { pageIssues :: [Issue]
  , pageTotal :: Int
  }
  deriving stock (Eq, Show)

instance FromJSON IssuePage where
  parseJSON = withObject "IssuePage" $ \o ->
    IssuePage <$> o .: "issues" <*> o .: "total"

-- | @GET \/api\/issues@, scoped by query parameter.
--
-- __The result is not trustworthy on its own.__ The query channel is the
-- lowest-priority of six, and under an @mat_@ credential it is discarded
-- outright: the server answers @200@ with the token-bound workspace's issues.
-- Callers must run @Ubiquity.Scope.witnessScope@ over 'pageIssues' before
-- believing the scope was honoured. That check is not folded in here on
-- purpose — this function mirrors the endpoint, and the endpoint really does
-- return unverified data.
listIssues :: Transport -> WorkspaceScope Workspace -> IO (Either ApiError IssuePage)
listIssues t scope = getJson t ["api", "issues"] (scopeQuery scope) []

-- | @GET \/api\/issues\/{id}@.
getIssue :: Transport -> IssueId -> IO (Either ApiError Issue)
getIssue t iid = getJson t ["api", "issues", idText iid] [] []
