{-# LANGUAGE OverloadedStrings #-}

-- | Entity identifiers.
--
-- Every entity primary key on the surface is a Postgres UUID v4 rendered as a
-- plain string (@contract/maps/api-shape-conventions.md@ §A, citing
-- @server/migrations/001_init.up.sql:6@). Numeric identifiers exist
-- (@issue.number@, @issue.position@, @issue.stage@) but they are not entity
-- keys and are not modelled here.
--
-- Two propositions are made in the types:
--
-- * A 'Uuid' is well-formed by construction. The only way to obtain one is
--   'parseUuid', which is total and says @Maybe@ where the wire says @string@.
--
-- * An @'Id' e@ knows which entity it points at. There is deliberately no
--   @castId@: the whole point of the phantom is that @'Id' Issue@ and
--   @'Id' Workspace@ do not unify.
module Ubiquity.Identifier
  ( Uuid
  , uuidText
  , parseUuid
  , Id
  , idUuid
  , idText
  , parseId
  , unsafeIdFromUuid
  ) where

import Data.Aeson (FromJSON (..), ToJSON (..), withText)
import Data.Char (isHexDigit)
import Data.Text (Text)
import qualified Data.Text as T

-- | A syntactically valid UUID. The constructor is not exported; 'parseUuid'
-- is the only introduction form.
newtype Uuid = Uuid Text
  deriving stock (Eq, Ord)

instance Show Uuid where
  show (Uuid t) = T.unpack t

uuidText :: Uuid -> Text
uuidText (Uuid t) = t

-- | Total. Accepts the canonical 8-4-4-4-12 lowercase-or-uppercase hex form
-- and normalises to lowercase, which is what the server emits.
parseUuid :: Text -> Maybe Uuid
parseUuid raw
  | wellFormed = Just (Uuid (T.toLower raw))
  | otherwise = Nothing
  where
    groups = T.splitOn "-" raw
    wellFormed =
      map T.length groups == [8, 4, 4, 4, 12]
        && all (T.all isHexDigit) groups

-- | An identifier tagged with the entity it denotes. @e@ is a phantom.
newtype Id e = Id Uuid
  deriving stock (Eq, Ord)

instance Show (Id e) where
  show (Id u) = show u

idUuid :: Id e -> Uuid
idUuid (Id u) = u

idText :: Id e -> Text
idText (Id u) = uuidText u

parseId :: Text -> Maybe (Id e)
parseId = fmap Id . parseUuid

-- | Retag a 'Uuid' that is already known to denote @e@ (e.g. one that arrived
-- in the @assignee_id@ position after @assignee_type@ was matched). Named
-- @unsafe@ because the caller, not the type, supplies the evidence.
unsafeIdFromUuid :: Uuid -> Id e
unsafeIdFromUuid = Id

instance FromJSON (Id e) where
  parseJSON = withText "Id" $ \t ->
    case parseId t of
      Just i -> pure i
      Nothing -> fail ("not a UUID: " <> show t)

instance ToJSON (Id e) where
  toJSON = toJSON . idText
