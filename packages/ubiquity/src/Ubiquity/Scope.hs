{-# LANGUAGE OverloadedStrings #-}

-- | Workspace scoping — and the witness that the server honoured it.
--
-- \"Which workspace\" travels over __six__ channels with a documented priority
-- order (@server/internal/middleware/workspace.go:54-61@, charted at
-- @contract/maps/api-shape-conventions.md@ §H):
--
-- @
--  1. task-token binding (X-Actor-Source == "task_token")  -- authoritative
--  2. middleware-injected context
--  3. X-Workspace-Slug header
--  4. ?workspace_slug query
--  5. X-Workspace-ID header
--  6. ?workspace_id query                                   -- lowest
-- @
--
-- __The trap this module exists to close.__ Under a task token the server does
-- not merely deprioritise the client's identifier, it discards it —
-- @workspace.go:74-77@, verbatim:
--
-- > Any other workspace identifier on the request (slug header/query, ID
-- > query, URL param) is the agent trying to widen its blast radius — ignore it.
--
-- So @GET \/api\/issues?workspace_id=X@ under an @mat_@ token returns the
-- /token-bound/ workspace's issues with HTTP 200 and no diagnostic. A tool that
-- prints the result is printing a plausible, wrong answer, and it looks correct
-- whenever the bound workspace happens to be the one that was asked for.
--
-- Verified live on this server while building the mirror:
--
-- @
-- GET \/api\/issues?workspace_id=00000000-0000-0000-0000-000000000000
--   -> 200, total 48, every issue.workspace_id = 91d9fdfc-… (the bound workspace)
-- GET \/api\/workspaces\/00000000-0000-0000-0000-000000000000
--   -> 403 {"error":"task token is bound to a different workspace"}
-- @
--
-- The asymmetry is the finding: the __path-param__ channel enforces, the
-- __query-param__ channel silently substitutes. So a client cannot infer from
-- the absence of an error that its scope request was honoured, and must check
-- the payload instead. 'witnessScope' is that check, and it is the difference
-- between a printer and a mirror.
module Ubiquity.Scope
  ( WorkspaceSlug
  , workspaceSlug
  , workspaceSlugText
  , WorkspaceScope (..)
  , scopeQuery
  , scopeHeaders
  , ScopeAuthority (..)
  , ScopeViolation (..)
  , renderScopeViolation
  , witnessScope
  ) where

import Data.Text (Text)
import qualified Data.Text as T
import Ubiquity.Identifier (Id, idText)

-- | A workspace slug, e.g. @iris@.
newtype WorkspaceSlug = WorkspaceSlug Text
  deriving stock (Eq, Ord)

instance Show WorkspaceSlug where
  show (WorkspaceSlug t) = T.unpack t

workspaceSlug :: Text -> WorkspaceSlug
workspaceSlug = WorkspaceSlug

workspaceSlugText :: WorkspaceSlug -> Text
workspaceSlugText (WorkspaceSlug t) = t

-- | How the client asks for a workspace. Parametric in the workspace entity
-- tag @w@: this module does not know what a workspace /is/, only that requests
-- carry one, which keeps 'Ubiquity' free of a dependency on any chart.
data WorkspaceScope w
  = ScopeBySlug WorkspaceSlug
  | ScopeById (Id w)
  deriving stock (Eq, Show)

-- | The query-parameter channel (priority 4 and 6).
scopeQuery :: WorkspaceScope w -> [(Text, Text)]
scopeQuery (ScopeBySlug s) = [("workspace_slug", workspaceSlugText s)]
scopeQuery (ScopeById i) = [("workspace_id", idText i)]

-- | The header channel (priority 3 and 5).
scopeHeaders :: WorkspaceScope w -> [(Text, Text)]
scopeHeaders (ScopeBySlug s) = [("X-Workspace-Slug", workspaceSlugText s)]
scopeHeaders (ScopeById i) = [("X-Workspace-ID", idText i)]

-- | Whether the credential in use lets the client choose its own scope at all.
--
-- 'Advisory' is not a weaker form of 'Authoritative'; it means the request's
-- scope fields are inert. Carrying this as a value lets the tool say which
-- regime it is in instead of guessing from behaviour.
data ScopeAuthority
  = Authoritative
  | Advisory
  deriving stock (Eq, Show)

-- | A returned record that does not belong to the requested workspace.
data ScopeViolation w = ScopeViolation
  { violationRequested :: Id w
  , violationObserved :: Id w
  , violationSubject :: Text
  -- ^ Human label for the offending record, e.g. its identifier.
  , violationTotal :: Int
  -- ^ How many records were checked before the first violation.
  }
  deriving stock (Eq, Show)

renderScopeViolation :: ScopeViolation w -> Text
renderScopeViolation v =
  T.intercalate
    "\n"
    [ "scope violation: the server did not honour the requested workspace."
    , "  requested workspace: " <> idText (violationRequested v)
    , "  observed workspace:  " <> idText (violationObserved v)
    , "  first offending record: " <> violationSubject v
    , "  records checked before the violation: " <> T.pack (show (violationTotal v))
    ]

-- | Check that every record carries the workspace that was asked for.
--
-- Total, and returns the records on success so it composes as a checked
-- pass-through rather than a side condition someone can forget to call.
witnessScope
  :: Id w
  -- ^ The workspace the client requested.
  -> (a -> (Text, Id w))
  -- ^ Label and workspace of a record.
  -> [a]
  -> Either (ScopeViolation w) [a]
witnessScope requested project = go 0
  where
    go _ [] = Right []
    go n (x : xs) =
      let (label, observed) = project x
       in if observed == requested
            then (x :) <$> go (n + 1 :: Int) xs
            else
              Left
                ScopeViolation
                  { violationRequested = requested
                  , violationObserved = observed
                  , violationSubject = label
                  , violationTotal = n
                  }
