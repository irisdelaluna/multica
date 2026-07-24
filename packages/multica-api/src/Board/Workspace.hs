{-# LANGUAGE OverloadedStrings #-}

-- | Workspaces.
--
-- __The bare-array half of the envelope split.__ @GET \/api\/workspaces@
-- returns a naked JSON array (@server/internal/handler/workspace.go:111-116@,
-- @resp := make([]WorkspaceResponse, len(workspaces)); writeJSON(w, 200, resp)@)
-- while @GET \/api\/issues@ returns @{issues, total}@. There is no rule that
-- decides which lists are wrapped (§I.1 lists nineteen resources split across
-- both conventions, with the envelope key itself inconsistent).
--
-- So there is deliberately __no @Envelope a@ type__ in 'Ubiquity' and no
-- shared list decoder. 'listWorkspaces' and "Board.Issue"'s 'listIssues' are
-- two separate decoders that happen to both return records. Generalising over
-- a single instance would be inventing a rule the surface does not have; when
-- there are enough instances to see the real shape, the @extend@ stage can
-- lift it, and by then the chart will say what the right generic is.
module Board.Workspace
  ( Workspace (..)
  , WorkspaceRepo (..)
  , WorkspaceId
  , listWorkspaces
  , getWorkspace
  ) where

import Data.Aeson (FromJSON (..), Object, withObject, (.:))
import Data.Text (Text)
import Ubiquity.Identifier (Id, idText)
import Ubiquity.Scope (WorkspaceSlug, workspaceSlug)
import Ubiquity.Time (Timestamp)
import Ubiquity.Transport (ApiError, Transport, getJson)
import Ubiquity.Wire (alwaysNull, emptyIsUnset)

type WorkspaceId = Id Workspace

-- | A workspace. The record type doubles as the phantom tag for
-- @'Id' Workspace@.
--
-- @GET \/api\/workspaces@ and @GET \/api\/workspaces\/{id}@ return the
-- __same__ shape — verified field-by-field against the live server — so one
-- type serves both. That is worth stating because it is not the general rule:
-- several resources on this surface have a list projection narrower than their
-- detail projection, and where that happens two types are owed.
data Workspace = Workspace
  { workspaceIdOf :: WorkspaceId
  , workspaceName :: Text
  , workspaceSlugOf :: WorkspaceSlug
  , workspaceDescription :: Maybe Text
  , workspaceContext :: Maybe Text
  , workspaceSettings :: Object
  -- ^ Free-form. Always present, @{}@ when empty; the surface makes no
  -- promise about its keys, so neither does this type.
  , workspaceRepos :: [WorkspaceRepo]
  , workspaceIssuePrefix :: Text
  -- ^ Composes with @issue.number@ to make the human @identifier@ (@IRI-45@).
  , workspaceAvatarUrl :: Maybe Text
  , workspaceCreatedAt :: Timestamp
  , workspaceUpdatedAt :: Timestamp
  }
  deriving stock (Eq, Show)

-- | An inline repository binding. Not charted anywhere — found by reading a
-- live response — and notable because its @description@ follows the
-- @""@-means-unset convention rather than the @null@ one used by the
-- workspace's own @description@ three fields above it. Same word, same
-- response, two null strategies.
data WorkspaceRepo = WorkspaceRepo
  { repoUrl :: Text
  , repoDescription :: Maybe Text
  }
  deriving stock (Eq, Show)

instance FromJSON WorkspaceRepo where
  parseJSON = withObject "WorkspaceRepo" $ \o ->
    WorkspaceRepo
      <$> o .: "url"
      <*> emptyIsUnset o "description"

instance FromJSON Workspace where
  parseJSON = withObject "Workspace" $ \o ->
    Workspace
      <$> o .: "id"
      <*> o .: "name"
      <*> (workspaceSlug <$> o .: "slug")
      <*> alwaysNull o "description"
      <*> alwaysNull o "context"
      <*> o .: "settings"
      <*> o .: "repos"
      <*> o .: "issue_prefix"
      <*> alwaysNull o "avatar_url"
      <*> o .: "created_at"
      <*> o .: "updated_at"

-- | @GET \/api\/workspaces@ — decodes a bare array.
listWorkspaces :: Transport -> IO (Either ApiError [Workspace])
listWorkspaces t = getJson t ["api", "workspaces"] [] []

-- | @GET \/api\/workspaces\/{id}@.
--
-- Note that this route is scoped by the __path__ parameter, not by header or
-- query (@router.go:856-941@ mounts @RequireWorkspaceMemberFromURL@ over the
-- @\/api\/workspaces\/{id}\/…@ group). That channel is enforced: asking for a
-- workspace the credential is not bound to returns @403@, where the
-- query-parameter channel used by "Board.Issue" silently substitutes. Same
-- logical request, two different failure modes.
getWorkspace :: Transport -> WorkspaceId -> IO (Either ApiError Workspace)
getWorkspace t wid = getJson t ["api", "workspaces", idText wid] [] []
