{-# LANGUAGE LambdaCase #-}
{-# LANGUAGE OverloadedStrings #-}

-- | @multica-mirror@ — read the live server through the Haskell client and
-- check that what came back is what was asked for.
--
-- The tool is deliberately an assertion, not a printer. Its load-bearing step
-- is step 3: after listing a workspace's issues it runs
-- @Ubiquity.Scope.witnessScope@ over the result and exits non-zero if any
-- issue belongs to a different workspace. Without that check the tool would
-- print a plausible, wrong answer under an @mat_@ credential and look
-- perfectly healthy doing it — see "Ubiquity.Scope" for the evidence.
--
-- @
-- multica-mirror                       -- read and assert
-- multica-mirror --workspace \<uuid\>    -- ask for a specific workspace
-- multica-mirror --scope-trap          -- prove the assertion has teeth
-- @
--
-- @--scope-trap@ asks for a workspace the credential is certainly not bound to
-- and asserts that the check __fires__. Under an authoritative credential the
-- server refuses, and under a task token it silently substitutes; either way
-- the tool must not come back saying \"all good\".
module Main (main) where

import Board.Actor (renderIssueAssignee, renderIssueCreator)
import Board.Issue
  ( Issue (..)
  , IssuePage (..)
  , getIssue
  , listIssues
  , priorityText
  , statusText
  )
import Board.Workspace (Workspace (..), getWorkspace, listWorkspaces)
import Control.Monad (forM_)
import Data.List (find)
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Text.IO as TIO
import System.Environment (getArgs, lookupEnv)
import System.Exit (ExitCode (..), exitSuccess, exitWith)
import Ubiquity.Identifier (Id, idText, parseId)
import Ubiquity.Scope
  ( ScopeAuthority (..)
  , ScopeViolation
  , WorkspaceScope (..)
  , renderScopeViolation
  , witnessScope
  )
import Ubiquity.Transport
  ( ApiError
  , BaseUrl
  , Credential
  , Transport
  , baseUrl
  , baseUrlText
  , bearer
  , credentialFlavour
  , describeFlavour
  , newTransport
  , renderApiError
  , scopeAuthority
  )

data Options = Options
  { optWorkspace :: Maybe (Id Workspace)
  , optScopeTrap :: Bool
  , optSample :: Int
  }

defaultOptions :: Options
defaultOptions = Options Nothing False 5

main :: IO ()
main = do
  opts <- parseArgs defaultOptions =<< getArgs
  urlRaw <- maybe "http://localhost:8080" T.pack <$> lookupEnv "MULTICA_SERVER_URL"
  tokenRaw <- lookupEnv "MULTICA_TOKEN"

  url <- case baseUrl urlRaw of
    Just u -> pure u
    Nothing -> die 2 ("MULTICA_SERVER_URL is not a usable base URL: " <> urlRaw)
  cred <- case tokenRaw of
    Just s | not (null s) -> pure (bearer (T.pack s))
    _ -> die 2 "MULTICA_TOKEN is not set; the mirror needs a bearer credential"

  transport <- newTransport url cred
  banner url cred

  workspaces <- expect =<< listWorkspaces transport
  step "1/4" "GET /api/workspaces" "bare array (workspace.go:111-116)"
  say ("  decoded " <> count (length workspaces) "workspace")
  forM_ workspaces $ \w ->
    say
      ( "  - "
          <> workspaceName w
          <> "  ["
          <> workspaceIssuePrefix w
          <> "]  "
          <> idText (workspaceIdOf w)
      )

  requested <- case optWorkspace opts of
    Just w -> pure w
    Nothing -> case workspaces of
      (w : _) -> pure (workspaceIdOf w)
      [] -> die 2 "the credential can see no workspaces; nothing to mirror"

  step "2/4" ("GET /api/workspaces/" <> idText requested) "single object, path-scoped"
  detail <- expect =<< getWorkspace transport requested
  let listEntry = find ((== requested) . workspaceIdOf) workspaces
  say ("  " <> workspaceName detail <> "  slug " <> T.pack (show (workspaceSlugOf detail)))
  say
    ( "  agrees with the list projection: "
        <> case listEntry of
          Just e | e == detail -> "yes (same shape, field for field)"
          Just _ -> "NO — list and detail disagree"
          Nothing -> "n/a (workspace was not in the list)"
    )

  step "3/4" "GET /api/issues?workspace_id=..." "envelope {issues,total} (issue.go:1269-1271)"
  page <- expect =<< listIssues transport (ScopeById requested)
  say ("  envelope total " <> tshow (pageTotal page) <> ", decoded " <> tshow (length (pageIssues page)))

  say "  scope witness (this is the assertion, not the print):"
  case witnessIssues requested page of
    Left violation -> do
      TIO.putStrLn ""
      TIO.putStrLn (indent (renderScopeViolation violation))
      TIO.putStrLn ""
      die 1 "the server did not honour the requested workspace; the printed data would have been wrong"
    Right checked ->
      say
        ( "    OK — all "
            <> tshow (length checked)
            <> " issues carry workspace_id = "
            <> idText requested
        )

  forM_ (take (optSample opts) (pageIssues page)) $ \i ->
    say ("  - " <> pad 8 (issueIdentifier i) <> " " <> issueTitle i)

  case pageIssues page of
    [] -> say "  (no issues; skipping the single-issue read)"
    (first : _) -> do
      step "4/4" ("GET /api/issues/" <> idText (issueIdOf first)) "single object, polymorphic assignee"
      one <- expect =<< getIssue transport (issueIdOf first)
      say ("  " <> issueIdentifier one <> "  " <> issueTitle one)
      say ("  status   " <> statusText (issueStatus one))
      say ("  priority " <> priorityText (issuePriority one))
      say
        ( "  assignee "
            <> maybe "(unassigned — a state the type has)" renderIssueAssignee (issueAssignee one)
        )
      say ("  creator  " <> renderIssueCreator (issueCreator one))
      say ("  labels   " <> tshow (length (issueLabels one)))

  if optScopeTrap opts
    then scopeTrap transport requested
    else do
      TIO.putStrLn ""
      say "mirror complete: four endpoints read, decoded, and scope-checked."
      exitSuccess

-- | Ask for a workspace the credential is not bound to and require that the
-- mirror notices. A run in which this reports \"honoured\" is a run in which
-- the assertion in step 3 proves nothing.
scopeTrap :: Transport -> Id Workspace -> IO ()
scopeTrap transport realWorkspace = do
  TIO.putStrLn ""
  step "trap" "GET /api/issues?workspace_id=<foreign>" "asserting the check fires"
  foreign' <- case parseId "00000000-0000-0000-0000-000000000000" of
    Just i -> pure i
    Nothing -> die 3 "the nil UUID stopped being a UUID"
  say ("  requesting workspace " <> idText foreign' <> " (deliberately not the bound one)")
  listIssues transport (ScopeById foreign') >>= \case
    Left err -> do
      say ("  server refused: " <> renderApiError err)
      say "  verdict: scope request was ENFORCED at the transport. Good."
      exitSuccess
    Right page ->
      case witnessIssues foreign' page of
        Left violation -> do
          say
            ( "  server answered 200 with "
                <> tshow (length (pageIssues page))
                <> " issues, and they are not the ones asked for."
            )
          TIO.putStrLn ""
          TIO.putStrLn (indent (renderScopeViolation violation))
          TIO.putStrLn ""
          say "  verdict: the check FIRED on a silent substitution. This is the trap,"
          say "           and it is why step 3 asserts instead of printing."
          say ("           (the substituted workspace is " <> idText realWorkspace <> ")")
          exitSuccess
        Right [] -> do
          say "  server answered 200 with an empty page — inconclusive, no records to check."
          exitWith (ExitFailure 3)
        Right _ -> do
          say "  server answered 200 and the issues really do carry the foreign workspace."
          die 3 "inconclusive: this credential genuinely has access to the foreign workspace"

witnessIssues
  :: Id Workspace
  -> IssuePage
  -> Either (ScopeViolation Workspace) [Issue]
witnessIssues requested page =
  witnessScope requested (\i -> (issueIdentifier i, issueWorkspaceId i)) (pageIssues page)

-- Presentation ---------------------------------------------------------------

banner :: BaseUrl -> Credential -> IO ()
banner url cred = do
  say "multica-mirror — Haskell mirror of the Multica board reads"
  say ("  base url   " <> baseUrlText url)
  say ("  credential " <> describeFlavour (credentialFlavour cred))
  say
    ( "  scoping    "
        <> case scopeAuthority cred of
          Authoritative -> "Authoritative — the workspace this client asks for is the workspace it gets"
          Advisory ->
            "Advisory — the server DISCARDS client-supplied workspace scope for this\n"
              <> "             credential (middleware/workspace.go:74-77), so the reply must be checked"
    )

step :: Text -> Text -> Text -> IO ()
step n what note = do
  TIO.putStrLn ""
  TIO.putStrLn ("[" <> n <> "] " <> what)
  TIO.putStrLn ("      " <> note)

say :: Text -> IO ()
say = TIO.putStrLn

tshow :: (Show a) => a -> Text
tshow = T.pack . show

pad :: Int -> Text -> Text
pad n t = t <> T.replicate (max 0 (n - T.length t)) " "

count :: Int -> Text -> Text
count n noun = tshow n <> " " <> noun <> (if n == 1 then "" else "s")

indent :: Text -> Text
indent = T.unlines . map ("    " <>) . T.lines

expect :: Either ApiError a -> IO a
expect (Right a) = pure a
expect (Left e) = die 2 (renderApiError e)

die :: Int -> Text -> IO a
die code msg = do
  TIO.putStrLn ""
  TIO.putStrLn ("multica-mirror: " <> msg)
  exitWith (ExitFailure code)

-- Arguments ------------------------------------------------------------------

parseArgs :: Options -> [String] -> IO Options
parseArgs opts [] = pure opts
parseArgs opts ("--scope-trap" : rest) = parseArgs opts {optScopeTrap = True} rest
parseArgs opts ("--workspace" : w : rest) =
  case parseId (T.pack w) of
    Just i -> parseArgs opts {optWorkspace = Just i} rest
    Nothing -> die 2 ("--workspace expects a UUID, got " <> T.pack w)
parseArgs opts ("--sample" : n : rest)
  | [(k, "")] <- reads n = parseArgs opts {optSample = k} rest
parseArgs _ (bad : _) = die 2 ("unrecognised argument " <> T.pack bad)
