{-# LANGUAGE OverloadedStrings #-}

-- | Law checks for the vocabulary in @ubiquity@.
--
-- Deliberately hand-rolled against @base@ rather than a test framework: the
-- choice of harness for the Haskell line belongs to the VERIFY lane, and this
-- package should not pre-empt it with a dependency. Each case is a named
-- predicate so a failure prints which law broke.
module Main (main) where

import Control.Monad (unless)
import qualified Data.Set as Set
import Data.Text (Text)
import System.Exit (exitFailure)
import Ubiquity.Time
  ( Timestamp
  , ordRefinesEq
  , parseTimestamp
  , timestampText
  , timestampUtc
  )

main :: IO ()
main = do
  results <- mapM run cases
  unless (and results) exitFailure
  putStrLn ("ok — " <> show (length cases) <> " law checks passed")
  where
    run (name, ok) = do
      putStrLn ((if ok then "  ok   " else "  FAIL ") <> name)
      pure ok

cases :: [(String, Bool)]
cases =
  [ ("parse: Z and numeric-offset spellings both parse", bothSpellingsParse)
  , ("same instant, different offset: denote one instant", sameInstant)
  , ("same instant, different offset: are not Eq", utcNoon /= cetNoon)
  , ("same instant, different offset: do not compare EQ", compare utcNoon cetNoon /= EQ)
  , ("Ord refines Eq — the regression this file exists for", lawHoldsPairwise)
  , ("ordered containers keep what Eq calls distinct", setKeepsBoth)
  , ("ordering is chronological, not lexicographic", chronologicalNotLexicographic)
  , ("identical wire text: Eq and EQ", sameTextAgrees)
  , ("antisymmetry across the sample", antisymmetric)
  ]

-- | @2026-07-24T12:00:00Z@ and @2026-07-24T14:00:00+02:00@ are the same
-- instant written two ways. This is the pair the reviewed defect turned into
-- a contradiction: @(a == b, compare a b) == (False, EQ)@.
utcNoon, cetNoon :: Timestamp
utcNoon = parsed "2026-07-24T12:00:00Z"
cetNoon = parsed "2026-07-24T14:00:00+02:00"

-- | 13:00Z is /later/ than @cetNoon@ (12:00Z) but its text sorts /earlier/
-- than @"2026-07-24T14:00:00+02:00"@, so lexicographic and chronological
-- order disagree here and the primary sense has to be visible.
laterInstantEarlierText :: Timestamp
laterInstantEarlierText = parsed "2026-07-24T13:00:00Z"

sample :: [Timestamp]
sample = [utcNoon, cetNoon, laterInstantEarlierText, parsed "2025-01-01T00:00:00Z"]

bothSpellingsParse :: Bool
bothSpellingsParse =
  all
    (\t -> maybe False (const True) (parseTimestamp t))
    ["2026-07-24T12:00:00Z", "2026-07-24T14:00:00+02:00"]

sameInstant :: Bool
sameInstant = timestampUtc utcNoon == timestampUtc cetNoon

lawHoldsPairwise :: Bool
lawHoldsPairwise = and [ordRefinesEq a b | a <- sample, b <- sample]

-- | The concrete consequence of an unlawful pair: a set built from two values
-- equality calls distinct must hold both.
setKeepsBoth :: Bool
setKeepsBoth = Set.size (Set.fromList [utcNoon, cetNoon]) == 2

chronologicalNotLexicographic :: Bool
chronologicalNotLexicographic =
  compare cetNoon laterInstantEarlierText == LT
    && compare (timestampText cetNoon) (timestampText laterInstantEarlierText) == GT

sameTextAgrees :: Bool
sameTextAgrees =
  let a = parsed "2026-07-24T12:00:00Z"
   in a == utcNoon && compare a utcNoon == EQ

antisymmetric :: Bool
antisymmetric =
  and [compare a b == flipOrdering (compare b a) | a <- sample, b <- sample]
  where
    flipOrdering LT = GT
    flipOrdering GT = LT
    flipOrdering EQ = EQ

parsed :: Text -> Timestamp
parsed t = case parseTimestamp t of
  Just ts -> ts
  Nothing -> error ("test fixture is not RFC3339: " <> show t)
