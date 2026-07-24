{-# LANGUAGE OverloadedStrings #-}

-- | The two actor contexts this slice actually needs, and their restriction
-- maps into the carrier in "Ubiquity.Actor".
--
-- These are __two types, not one__, and that is the whole point. Reading the
-- CHECK constraints:
--
-- * @issue.assignee_type@ ∈ @{member, agent, squad}@, __nullable__
--   (@server/migrations/084_squad.up.sql:33@)
-- * @issue.creator_type@ ∈ @{member, agent}@, __NOT NULL__
--   (@server/migrations/001_init.up.sql:63@)
--
-- The optionality is part of the proposition, so it is part of the type: an
-- issue's assignee is @'Maybe' 'IssueAssignee'@ and its creator is a plain
-- 'IssueCreator' with no @Maybe@ anywhere. Collapsing them into one nullable
-- actor field would make \"unassigned\" and \"uncreated\" the same shape, and
-- only one of those is a state the domain has.
--
-- Not a hypothetical distinction. Snapshot of the Iris board, 2026-07-24,
-- 50 issues, all of which this decoder accepted:
--
-- @
-- assignee_type   null 26   agent 21   member 2   squad 1    -- all four states occur
-- creator_type    member 45  agent 5   null 0                -- the null column stays empty
-- @
--
-- __Why these sums are closed while status and priority are open.__ The
-- surface types every enum as @z.string()@ on purpose, so that an unrecognised
-- value renders as a fallback rather than crashing (@schemas.ts:196-199@), and
-- "Board.Issue" honours that for status and priority via
-- @Ubiquity.Wire.OpenEnum@. The assignee kind is treated differently, and the
-- reason is what the value is /for/:
--
-- * A status is __displayed__. An unknown one degrades to showing the raw
--   string, which is a real and correct behaviour.
-- * An assignee kind is __branched on__. The server itself dispatches work on
--   it — @service/task.go:3439-3441@ switches on @"agent"@ and @"squad"@ —
--   and there is no meaningful fallback for \"assigned to something this
--   client cannot name\". Rendering it as prose would hide a fact the caller
--   needs.
--
-- So an unrecognised assignee kind is a decode failure, on purpose. That is a
-- deliberate divergence from the TS client's never-crash policy, made because
-- a mirror's job is to report drift, not absorb it. It is the most likely
-- thing in this package to be argued with, which is why it is written down
-- rather than left implicit.
module Board.Actor
  ( -- * Phantom entity tags
    Member
  , Agent
  , Squad

    -- * Issue assignment (member | agent | squad, optional)
  , IssueAssignee (..)
  , parseIssueAssignee

    -- * Issue authorship (member | agent, total)
  , IssueCreator (..)
  , parseIssueCreator

    -- * Rendering
  , renderIssueAssignee
  , renderIssueCreator
  ) where

import Data.Aeson (Object)
import Data.Aeson.Types (Parser)
import Data.Text (Text)
import Ubiquity.Actor
  ( ActorKind
  , ActorRef (..)
  , ActorRestriction (..)
  , Proxy (..)
  , actorKind
  , actorKindText
  , parseActorPair
  )
import Ubiquity.Identifier (Id, idText, idUuid, unsafeIdFromUuid)

-- | Uninhabited. These exist only to keep @'Id' Member@ and @'Id' Agent@ from
-- unifying; the entities themselves are outside this slice.
data Member

data Agent

data Squad

kindMember, kindAgent, kindSquad :: ActorKind
kindMember = actorKind "member"
kindAgent = actorKind "agent"
kindSquad = actorKind "squad"

-- | Who an issue is assigned to, when it is assigned to anyone.
data IssueAssignee
  = AssignedToMember (Id Member)
  | AssignedToAgent (Id Agent)
  | AssignedToSquad (Id Squad)
  deriving stock (Eq, Show)

instance ActorRestriction IssueAssignee where
  intoCarrier a = case a of
    AssignedToMember i -> ActorRef kindMember (idUuid i)
    AssignedToAgent i -> ActorRef kindAgent (idUuid i)
    AssignedToSquad i -> ActorRef kindSquad (idUuid i)

  outOfCarrier (ActorRef k u)
    | k == kindMember = Just (AssignedToMember (unsafeIdFromUuid u))
    | k == kindAgent = Just (AssignedToAgent (unsafeIdFromUuid u))
    | k == kindSquad = Just (AssignedToSquad (unsafeIdFromUuid u))
    | otherwise = Nothing

  admissibleKinds _ = [kindMember, kindAgent, kindSquad]

-- | Who created an issue. Never absent — @creator_type@ and @creator_id@ are
-- @NOT NULL@ at the DB level, and every issue in the snapshot above carries
-- both.
data IssueCreator
  = CreatedByMember (Id Member)
  | CreatedByAgent (Id Agent)
  deriving stock (Eq, Show)

instance ActorRestriction IssueCreator where
  intoCarrier a = case a of
    CreatedByMember i -> ActorRef kindMember (idUuid i)
    CreatedByAgent i -> ActorRef kindAgent (idUuid i)

  outOfCarrier (ActorRef k u)
    | k == kindMember = Just (CreatedByMember (unsafeIdFromUuid u))
    | k == kindAgent = Just (CreatedByAgent (unsafeIdFromUuid u))
    | otherwise = Nothing

  admissibleKinds _ = [kindMember, kindAgent]

-- | @assignee_type@ \/ @assignee_id@. Absent as a pair is a legitimate state.
parseIssueAssignee :: Object -> Parser (Maybe IssueAssignee)
parseIssueAssignee o = do
  carrier <- parseActorPair o "assignee_type" "assignee_id"
  case carrier of
    Nothing -> pure Nothing
    Just ref -> case outOfCarrier ref of
      Just a -> pure (Just a)
      Nothing -> fail (outOfContext "assignee_type" ref (Proxy :: Proxy IssueAssignee))

-- | @creator_type@ \/ @creator_id@. Absent as a pair is __not__ a legitimate
-- state, so the pair being null is a decode failure rather than a 'Nothing'.
parseIssueCreator :: Object -> Parser IssueCreator
parseIssueCreator o = do
  carrier <- parseActorPair o "creator_type" "creator_id"
  case carrier of
    Nothing -> fail "creator_type/creator_id are null, but creator is NOT NULL (001_init.up.sql:63)"
    Just ref -> case outOfCarrier ref of
      Just a -> pure (a :: IssueCreator)
      Nothing -> fail (outOfContext "creator_type" ref (Proxy :: Proxy IssueCreator))

outOfContext :: (ActorRestriction a) => String -> ActorRef -> Proxy a -> String
outOfContext field ref proxy =
  field
    <> " = "
    <> show (actorRefKind ref)
    <> " is not one of "
    <> show (map actorKindText (admissibleKinds proxy))

renderIssueAssignee :: IssueAssignee -> Text
renderIssueAssignee a = case a of
  AssignedToMember i -> "member " <> idText i
  AssignedToAgent i -> "agent " <> idText i
  AssignedToSquad i -> "squad " <> idText i

renderIssueCreator :: IssueCreator -> Text
renderIssueCreator a = case a of
  CreatedByMember i -> "member " <> idText i
  CreatedByAgent i -> "agent " <> idText i
