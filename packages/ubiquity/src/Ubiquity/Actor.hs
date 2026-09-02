{-# LANGUAGE OverloadedStrings #-}

-- | The actor __carrier__ — and nothing more.
--
-- __Why there is no @Actor@ sum type here.__ The surface spells the
-- polymorphic-actor relation with a @*_type@ \/ @*_id@ pair in at least
-- fifteen places (@contract/maps/api-shape-conventions.md@ §D), and the set of
-- legal tags is __not the same set twice__. From the CHECK constraints, which
-- are the ground truth:
--
-- @
-- issue.assignee_type          member, agent, squad   nullable   084_squad.up.sql:33
-- issue.creator_type           member, agent          NOT NULL   001_init.up.sql:63
-- comment.author_type          member, agent, system  NOT NULL   107_comment_system_author.up.sql:8
-- autopilot.assignee_type      agent, squad           NOT NULL   096_autopilot_squad_assignee.up.sql:17
-- *_reaction.actor_type        member, agent          NOT NULL   026:5, 027:5
-- issue_subscriber.user_type   member, agent          NOT NULL   015_issue_subscriber.up.sql:4
-- autopilot_subscriber.user_type  member only         NOT NULL   120:10, 128:13
-- @
--
-- Seven distinct sets, and the decisive fact is not the count: @{agent, squad}@
-- and @{member, agent}@ are __incomparable__. Neither contains the other, so
-- there is no smallest actor type that restricts correctly to every site. A
-- single @Actor@ would have to be the join @{member, agent, squad, system}@,
-- after which every site re-validates at runtime exactly what the type was
-- supposed to guarantee. That is the flattened type that lies, and freezing it
-- into 'Ubiquity' is the most expensive mistake available.
--
-- So this module holds the carrier: an opaque tag plus an untyped id, making
-- __no claim__ about which tags are legal or what the id denotes. Each
-- capability context defines its own legal inhabitants and its own
-- 'ActorRestriction' into the carrier. That is a restriction map, not a
-- unification.
--
-- __The law.__ For every instance, @'outOfCarrier' . 'intoCarrier' == Just@:
-- restriction into the carrier loses no information about a value that was
-- already in the context. The converse does not hold, and must not:
-- @'intoCarrier' \<$\> 'outOfCarrier' r@ is @Nothing@ for exactly those carrier
-- points that do not lie in the context. 'restrictionRoundTrips' is provided
-- so the law can be tested rather than asserted.
module Ubiquity.Actor
  ( ActorKind
  , actorKindText
  , actorKind
  , ActorRef (..)
  , ActorRestriction (..)
  , restrictionRoundTrips
  , parseActorPair
  , Proxy (..)
  ) where

import Data.Aeson (Object)
import Data.Aeson.Key (Key)
import Data.Aeson.Types (Parser)
import Data.Proxy (Proxy (..))
import Data.Text (Text)
import qualified Data.Text as T
import Ubiquity.Identifier (Uuid, parseUuid)
import Ubiquity.Wire (alwaysNull)

-- | A wire tag such as @"member"@, @"agent"@, @"squad"@, @"system"@. Opaque,
-- and deliberately not an enumeration: this module does not know, and must not
-- claim, which tags any particular site allows.
newtype ActorKind = ActorKind Text
  deriving stock (Eq, Ord)

instance Show ActorKind where
  show (ActorKind t) = T.unpack t

actorKind :: Text -> ActorKind
actorKind = ActorKind

actorKindText :: ActorKind -> Text
actorKindText (ActorKind t) = t

-- | A point of the carrier: a tag and an id, with no relation asserted
-- between them. The id is a bare 'Uuid' rather than an @Id e@ because the
-- carrier does not know what @e@ is — recovering that is precisely what
-- 'outOfCarrier' does.
data ActorRef = ActorRef
  { actorRefKind :: ActorKind
  , actorRefId :: Uuid
  }
  deriving stock (Eq, Ord, Show)

-- | A context's legal actors, together with its restriction map into the
-- carrier.
class ActorRestriction a where
  -- | Total: every inhabitant of the context has a carrier image.
  intoCarrier :: a -> ActorRef

  -- | Partial, and honestly so: not every carrier point lies in this context.
  outOfCarrier :: ActorRef -> Maybe a

  -- | The tags this context admits, for error messages and for tests that
  -- want to enumerate the fibre. Order is the order the domain lists them in.
  -- The 'Proxy' is there only to fix @a@; the answer does not depend on a
  -- value, because admissibility is a property of the context, not of an
  -- inhabitant.
  admissibleKinds :: Proxy a -> [ActorKind]

-- | The claimed law, as a testable predicate.
restrictionRoundTrips :: (ActorRestriction a, Eq a) => a -> Bool
restrictionRoundTrips a = outOfCarrier (intoCarrier a) == Just a

-- | Decode a @\<prefix\>_type@ \/ @\<prefix\>_id@ pair into a carrier point.
--
-- Both halves are nullable together on the wire (@schemas.ts:452-453@), which
-- admits two states the domain does not have: tag without id, and id without
-- tag. Those are rejected here rather than silently coerced — the wire is
-- wider than the type, which is the direction a mirror should fail in.
parseActorPair :: Object -> Key -> Key -> Parser (Maybe ActorRef)
parseActorPair o kindKey idKey = do
  mKind <- alwaysNull o kindKey
  mId <- alwaysNull o idKey
  case (mKind :: Maybe Text, mId :: Maybe Text) of
    (Nothing, Nothing) -> pure Nothing
    (Just k, Just i) ->
      case parseUuid i of
        Nothing -> fail (show idKey <> " is not a UUID: " <> show i)
        Just u -> pure (Just (ActorRef (ActorKind k) u))
    (Just _, Nothing) ->
      fail (show kindKey <> " present but " <> show idKey <> " is null")
    (Nothing, Just _) ->
      fail (show idKey <> " present but " <> show kindKey <> " is null")
