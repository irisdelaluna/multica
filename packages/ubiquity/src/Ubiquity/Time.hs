{-# LANGUAGE OverloadedStrings #-}

-- | Wire time.
--
-- The surface uses exactly two time shapes and they are not the same type
-- (@contract/maps/api-shape-conventions.md@ §B):
--
-- * 'Timestamp' — RFC3339 with a numeric offset, produced by the single
--   serializer @util.TimestampToString@ (@server/internal/util/pgx.go:80-84@,
--   @t.Time.Format(time.RFC3339)@). Example: @2026-07-23T19:17:36+02:00@.
--
-- * 'CalendarDate' — a day with no time and no zone, produced by
--   @dateToPtr@ (@pgx.go:98-104@, @d.Time.Format(time.DateOnly)@). Example:
--   @2026-03-01@. Note the asymmetry: /requests/ also accept a full RFC3339
--   value at a UTC day boundary (@pgx.go:106-120@), but /responses/ never
--   emit one, so the response decoder here is strict.
--
-- 'Timestamp' retains the exact wire text alongside the parsed 'UTCTime'.
-- Parsing to 'UTCTime' alone would discard the offset the server sent, so
-- re-rendering would not be the identity. Keeping both makes 'Timestamp' a
-- faithful mirror of the wire value: 'parseTimestamp' is injective,
-- 'timestampText' retracts it, and the type is isomorphic to the set of
-- RFC3339 texts the server can emit.
--
-- __Identity is the wire text, and ordering must refine it.__ Because parsing
-- is deterministic, 'timestampUtc' is a function of 'timestampText', so
-- equality on the two fields together is exactly equality of the bytes. An
-- ordering that compared only the instant would then report 'EQ' for two
-- values equality calls distinct — the same instant written at two offsets —
-- and every ordered container would collapse a pair it was told to keep. So
-- 'compare' is chronological first and falls back to the retained text, which
-- makes @'compare' a b == 'EQ'@ and @a == b@ the same statement.
-- 'ordRefinesEq' is provided so that can be tested rather than asserted.
module Ubiquity.Time
  ( Timestamp
  , timestampUtc
  , timestampText
  , parseTimestamp
  , ordRefinesEq
  , CalendarDate
  , calendarDay
  , calendarText
  , parseCalendarDate
  ) where

import Data.Aeson (FromJSON (..), ToJSON (..), withText)
import Data.Text (Text)
import qualified Data.Text as T
import Data.Time (Day, UTCTime, defaultTimeLocale, parseTimeM)
import qualified Data.Time.Format as TF

-- | An instant as the server sent it.
data Timestamp = Timestamp
  { timestampUtc :: UTCTime
  -- ^ The instant, normalised to UTC.
  , timestampText :: Text
  -- ^ The exact bytes that arrived, offset included.
  }
  deriving stock (Eq)

-- | Chronological first, retained wire text as the tie-breaker.
--
-- The tie-breaker is not decoration: without it two spellings of one instant
-- would compare 'EQ' while '==' called them distinct, and 'Data.Set.Set' or
-- 'Data.Map.Map' would silently keep only one of them.
instance Ord Timestamp where
  compare a b =
    compare (timestampUtc a) (timestampUtc b)
      <> compare (timestampText a) (timestampText b)

-- | The claimed law, as a testable predicate: 'compare' agrees with '=='.
--
-- Chronological ordering is still the primary sense — this says only that the
-- order refines equality, not that the text participates in ranking values
-- that denote different instants.
ordRefinesEq :: Timestamp -> Timestamp -> Bool
ordRefinesEq a b = (compare a b == EQ) == (a == b)

instance Show Timestamp where
  show = T.unpack . timestampText

-- | Total. Accepts a numeric offset (@+02:00@) or @Z@.
parseTimestamp :: Text -> Maybe Timestamp
parseTimestamp raw = Timestamp <$> firstParse formats <*> pure raw
  where
    s = T.unpack raw
    formats =
      [ "%Y-%m-%dT%H:%M:%S%Q%Ez"
      , "%Y-%m-%dT%H:%M:%S%QZ"
      ]
    firstParse [] = Nothing
    firstParse (f : rest) =
      case parseTimeM True defaultTimeLocale f s of
        Just t -> Just t
        Nothing -> firstParse rest

-- | A calendar day. No time, no zone — the distinction the DB column makes.
newtype CalendarDate = CalendarDate Day
  deriving stock (Eq, Ord)

instance Show CalendarDate where
  show = T.unpack . calendarText

calendarDay :: CalendarDate -> Day
calendarDay (CalendarDate d) = d

calendarText :: CalendarDate -> Text
calendarText (CalendarDate d) =
  T.pack (TF.formatTime defaultTimeLocale "%Y-%m-%d" d)

-- | Total, and strict: @YYYY-MM-DD@ only, matching what responses emit.
parseCalendarDate :: Text -> Maybe CalendarDate
parseCalendarDate raw =
  CalendarDate <$> parseTimeM True defaultTimeLocale "%Y-%m-%d" (T.unpack raw)

instance FromJSON Timestamp where
  parseJSON = withText "Timestamp" $ \t ->
    case parseTimestamp t of
      Just ts -> pure ts
      Nothing -> fail ("not an RFC3339 timestamp: " <> show t)

instance ToJSON Timestamp where
  toJSON = toJSON . timestampText

instance FromJSON CalendarDate where
  parseJSON = withText "CalendarDate" $ \t ->
    case parseCalendarDate t of
      Just d -> pure d
      Nothing -> fail ("not a YYYY-MM-DD date: " <> show t)

instance ToJSON CalendarDate where
  toJSON = toJSON . calendarText
