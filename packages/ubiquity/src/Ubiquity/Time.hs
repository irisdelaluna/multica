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
-- re-rendering would not be the identity. Keeping both makes equality
-- syntactic and ordering chronological, which are the two things callers
-- actually want, without pretending the conversion was lossless.
module Ubiquity.Time
  ( Timestamp
  , timestampUtc
  , timestampText
  , parseTimestamp
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

-- | Chronological, not lexicographic: two spellings of the same instant in
-- different offsets compare 'EQ' here but are not 'Eq'.
instance Ord Timestamp where
  compare a b = compare (timestampUtc a) (timestampUtc b)

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
