{-# LANGUAGE OverloadedStrings #-}

-- | The wire conventions the surface actually uses.
--
-- Two facts from @contract/maps/api-shape-conventions.md@ are encoded here,
-- because both are genuinely constant across every chart:
--
-- __1. Enums are open by policy, not by accident.__ §C: the zod schemas
-- deliberately type every enum as @z.string()@ so that "a new server-side enum
-- value should render as a fallback in the UI, never crash a @safeParse@"
-- (@packages\/core\/api\/schemas.ts:196-199@). A closed Haskell sum would
-- therefore lie about the wire. 'OpenEnum' says the truth: /one of the values
-- this mirror knows, or a tag it does not/.
--
-- The subtlety is that a naive @data E = ... | Unknown Text@ makes the illegal
-- state @Unknown "done"@ representable — a second, spurious spelling of a value
-- the type already has. 'UnknownTag' is abstract, so outside this module the
-- only way to reach the 'Unknown' branch is 'openEnum', which cannot produce it
-- for a recognised name. The guarantee is relative to the supplied recogniser
-- and no stronger; that is stated rather than hidden.
--
-- __2. "No value" has four spellings.__ §E: @null@, absent, @""@, and @[]@,
-- and which one a field uses is not predictable from its type — only from the
-- Go struct tag. @CommentResponse@ spells two nullable strings two different
-- ways three lines apart (@comment.go:31@ vs @:37@). Haskell's 'Maybe'
-- collapses @null@ and absent into one value, so the distinction survives only
-- in the /name of the combinator/ a decoder reaches for: 'alwaysNull' asserts
-- the key is present, 'omittedWhenUnset' allows it to be missing. Reaching for
-- the wrong one is now a decode failure instead of a silent agreement.
module Ubiquity.Wire
  ( -- * Open enums
    UnknownTag
  , unknownTagText
  , OpenEnum (Known, Unknown)
  , openEnum
  , knownValue
  , openEnumText

    -- * Null, absent, empty
  , alwaysNull
  , omittedWhenUnset
  , emptyIsUnset
  ) where

import Data.Aeson (FromJSON, Object, (.:), (.:?))
import Data.Aeson.Key (Key)
import qualified Data.Aeson.KeyMap as KM
import Data.Aeson.Types (Parser)
import Data.Text (Text)
import qualified Data.Text as T

-- | A wire enum value this mirror does not recognise. Abstract on purpose:
-- see the module header.
newtype UnknownTag = UnknownTag Text
  deriving stock (Eq, Ord)

instance Show UnknownTag where
  show (UnknownTag t) = T.unpack t

unknownTagText :: UnknownTag -> Text
unknownTagText (UnknownTag t) = t

-- | An enum that is closed in the domain but open on the wire.
data OpenEnum a
  = Known a
  | Unknown UnknownTag
  deriving stock (Eq, Ord, Show)

-- | The only introduction form. Total.
openEnum :: (Text -> Maybe a) -> Text -> OpenEnum a
openEnum recognise raw = maybe (Unknown (UnknownTag raw)) Known (recognise raw)

knownValue :: OpenEnum a -> Maybe a
knownValue (Known a) = Just a
knownValue (Unknown _) = Nothing

openEnumText :: (a -> Text) -> OpenEnum a -> Text
openEnumText render (Known a) = render a
openEnumText _ (Unknown t) = unknownTagText t

-- | For a field the server /always emits/, using @null@ for "unset" — a
-- @*T@ Go field with no @omitempty@ (§E, e.g. @WorkspaceResponse.Description@
-- at @workspace.go:41@).
--
-- Strict about presence: a missing key is a decode failure, not a 'Nothing'.
-- This is a mirror, so a server that starts omitting the field should be
-- reported rather than absorbed.
alwaysNull :: (FromJSON a) => Object -> Key -> Parser (Maybe a)
alwaysNull o k
  | KM.member k o = o .: k
  | otherwise = fail ("expected key " <> show k <> " to be present (null when unset)")

-- | For a field the server /omits/ when unset — a @*T@ Go field carrying
-- @omitempty@ (§E, e.g. @CommentResponse.SourceTaskID@ at @comment.go:37@).
-- Accepts absent or @null@ alike, because the two are indistinguishable to a
-- consumer and the server may emit either.
omittedWhenUnset :: (FromJSON a) => Object -> Key -> Parser (Maybe a)
omittedWhenUnset o k = o .:? k

-- | For a field whose column is @TEXT NOT NULL DEFAULT ''@, so "unset" is the
-- empty string and never @null@ (§E, e.g. @UserSchema.profile_description@ at
-- @schemas.ts:1420@; live example: @label.description@ is @""@).
emptyIsUnset :: Object -> Key -> Parser (Maybe Text)
emptyIsUnset o k = blankToNothing <$> (o .: k)
  where
    blankToNothing t
      | T.null t = Nothing
      | otherwise = Just t

-- There is deliberately no @FromJSON (OpenEnum a)@ instance. A generic
-- instance would have to invent a recogniser, and the recogniser is exactly
-- the part that carries the domain knowledge. Each enum supplies its own.
