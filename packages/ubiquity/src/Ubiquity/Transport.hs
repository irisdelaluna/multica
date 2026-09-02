{-# LANGUAGE OverloadedStrings #-}

-- | Read transport for the Multica REST surface.
--
-- This is in 'Ubiquity' rather than in a chart because it is the one piece of
-- machinery that is genuinely the same in every chart: the base URL, the
-- bearer credential, the error body, and the trailing newline are properties
-- of the /site/, not of any bounded context. Nothing here knows what a
-- workspace or an issue is.
--
-- Three surface facts are encoded:
--
-- * __Credentials come in four flavours__, distinguished by prefix (§A):
--   @mdt_@ daemon, @mat_@ agent-task, @mul_@ personal, @mcn_@ cloud-node
--   (@server/internal/auth/jwt.go:40-59@). The flavour is not cosmetic —
--   it decides whether client-supplied workspace scoping means anything at
--   all, which is why 'scopeAuthority' is a function of the credential.
--
-- * __The default error body is @{\"error\": string}@__ and carries no code
--   (@handler.go:345-347@). The status line is where the class lives, so
--   'ApiError' branches on status and keeps the message as opaque prose.
--   The two structured bodies the surface does have
--   (@active_duplicate_issue@, @reason_code@) sit entirely on write and
--   dispatch paths and are therefore out of this read-only slice.
--
-- * __Every response body ends with a trailing newline__
--   (@handler.go:319@, @body = append(body, '\\n')@). Harmless here, because
--   aeson's decoder skips trailing whitespace — recorded so that the next
--   consumer, which may do byte-exact fixture comparison, is not surprised.
module Ubiquity.Transport
  ( -- * Endpoint and credential
    BaseUrl
  , baseUrl
  , baseUrlText
  , TokenFlavour (..)
  , Credential
  , bearer
  , credentialFlavour
  , describeFlavour
  , scopeAuthority

    -- * Transport
  , Transport
  , newTransport
  , transportBaseUrl
  , transportCredential

    -- * Requests
  , ApiError (..)
  , renderApiError
  , getJson
  ) where

import Control.Exception (SomeException, try)
import Data.Aeson (FromJSON, eitherDecode, withObject, (.:))
import qualified Data.Aeson.Types as A
import qualified Data.ByteString.Lazy as BL
import Data.String (fromString)
import Data.Text (Text)
import qualified Data.Text as T
import qualified Data.Text.Encoding as TE
import Network.HTTP.Client
  ( Manager
  , Request (..)
  , Response (..)
  , httpLbs
  , parseRequest
  )
import Network.HTTP.Client.TLS (newTlsManager)
import Network.HTTP.Types.Status (statusCode)
import Network.HTTP.Types.URI (renderQuery)
import Ubiquity.Scope (ScopeAuthority (..))

-- | A server base URL with no trailing slash.
newtype BaseUrl = BaseUrl Text
  deriving stock (Eq)

instance Show BaseUrl where
  show (BaseUrl t) = T.unpack t

-- | Total. Normalises away trailing slashes; rejects the empty string.
baseUrl :: Text -> Maybe BaseUrl
baseUrl raw
  | T.null trimmed = Nothing
  | otherwise = Just (BaseUrl trimmed)
  where
    trimmed = T.dropWhileEnd (== '/') (T.strip raw)

baseUrlText :: BaseUrl -> Text
baseUrlText (BaseUrl t) = t

-- | What kind of thing is authenticating. Classified by prefix, per §A.
data TokenFlavour
  = DaemonToken
  | AgentTaskToken
  | PersonalAccessToken
  | CloudNodeToken
  | UnrecognisedFlavour
  deriving stock (Eq, Show)

-- | A bearer credential. 'Show' redacts the secret; there is no accessor for
-- it outside this module, so the only thing that can read it is the request
-- builder below.
data Credential = Credential
  { credentialFlavour :: TokenFlavour
  , credentialSecret :: Text
  }

instance Show Credential where
  show c = "Credential " <> show (credentialFlavour c) <> " <redacted>"

bearer :: Text -> Credential
bearer secret = Credential (classify secret) secret
  where
    classify t
      | "mdt_" `T.isPrefixOf` t = DaemonToken
      | "mat_" `T.isPrefixOf` t = AgentTaskToken
      | "mul_" `T.isPrefixOf` t = PersonalAccessToken
      | "mcn_" `T.isPrefixOf` t = CloudNodeToken
      | otherwise = UnrecognisedFlavour

describeFlavour :: TokenFlavour -> Text
describeFlavour f = case f of
  DaemonToken -> "mdt_ daemon token"
  AgentTaskToken -> "mat_ agent task token"
  PersonalAccessToken -> "mul_ personal access token"
  CloudNodeToken -> "mcn_ cloud-node token"
  UnrecognisedFlavour -> "unrecognised token prefix"

-- | Whether this credential's holder can choose its own workspace scope.
--
-- Only the task token is 'Advisory': its workspace is stamped on the token and
-- every client-supplied identifier is discarded (@workspace.go:74-77@). Every
-- other flavour resolves scope from the request as charted. This is the one
-- place the trap in "Ubiquity.Scope" becomes predictable in advance rather
-- than diagnosable after the fact.
scopeAuthority :: Credential -> ScopeAuthority
scopeAuthority c = case credentialFlavour c of
  AgentTaskToken -> Advisory
  _ -> Authoritative

data Transport = Transport
  { transportManager :: Manager
  , transportBaseUrl :: BaseUrl
  , transportCredential :: Credential
  }

-- | TLS-capable manager, so the same transport serves @http:\/\/localhost@ and
-- a real @https:\/\/@ deployment.
newTransport :: BaseUrl -> Credential -> IO Transport
newTransport url cred = do
  mgr <- newTlsManager
  pure (Transport mgr url cred)

-- | Everything a read request can go wrong as.
--
-- Deliberately shallow: the default error body has no machine-readable code,
-- so anything finer would be invented rather than mirrored.
data ApiError
  = Unauthorized Text
  | Forbidden Text
  | NotFound Text
  | ClientFailure Int Text
  | ServerFailure Int Text
  | MalformedResponse Text
  | TransportFailure Text
  deriving stock (Eq, Show)

renderApiError :: ApiError -> Text
renderApiError e = case e of
  Unauthorized m -> "401 unauthorized: " <> m
  Forbidden m -> "403 forbidden: " <> m
  NotFound m -> "404 not found: " <> m
  ClientFailure s m -> T.pack (show s) <> " client error: " <> m
  ServerFailure s m -> T.pack (show s) <> " server error: " <> m
  MalformedResponse m -> "response did not decode: " <> m
  TransportFailure m -> "transport failed: " <> m

-- | @GET@ a JSON document.
--
-- The path is given as segments rather than a string so that path building is
-- total and cannot smuggle a @\/@ or a query separator out of an id.
getJson
  :: (FromJSON a)
  => Transport
  -> [Text]
  -- ^ Path segments below the origin, e.g. @["api", "issues"]@.
  -> [(Text, Text)]
  -- ^ Query parameters.
  -> [(Text, Text)]
  -- ^ Extra headers.
  -> IO (Either ApiError a)
getJson t segments query headers = do
  let url = baseUrlText (transportBaseUrl t) <> "/" <> T.intercalate "/" segments
  attempt <- try (parseRequest (T.unpack url)) :: IO (Either SomeException Request)
  case attempt of
    Left err -> pure (Left (TransportFailure (T.pack (show err))))
    Right req0 -> do
      let req =
            req0
              { method = "GET"
              , queryString = renderQuery True [(TE.encodeUtf8 k, Just (TE.encodeUtf8 v)) | (k, v) <- query]
              , requestHeaders =
                  ("Authorization", "Bearer " <> TE.encodeUtf8 (credentialSecret (transportCredential t)))
                    : ("Accept", "application/json")
                    : [(fromString (T.unpack k), TE.encodeUtf8 v) | (k, v) <- headers]
              }
      outcome <- try (httpLbs req (transportManager t))
      case outcome of
        Left err -> pure (Left (TransportFailure (T.pack (show (err :: SomeException)))))
        Right resp -> pure (interpret resp)

interpret :: (FromJSON a) => Response BL.ByteString -> Either ApiError a
interpret resp
  | code >= 200 && code < 300 =
      case eitherDecode body of
        Right v -> Right v
        Left err -> Left (MalformedResponse (T.pack err))
  | code == 401 = Left (Unauthorized message)
  | code == 403 = Left (Forbidden message)
  | code == 404 = Left (NotFound message)
  | code < 500 = Left (ClientFailure code message)
  | otherwise = Left (ServerFailure code message)
  where
    code = statusCode (responseStatus resp)
    body = responseBody resp
    message = errorMessage body

-- | Read @{"error": "..."}@, falling back to the raw body when the server
-- emitted something else (which the middleware's hand-written copy at
-- @middleware/workspace.go:152-156@ can do).
errorMessage :: BL.ByteString -> Text
errorMessage body =
  case A.parseEither (withObject "error" (.: "error")) =<< eitherDecode body of
    Right m -> m
    Left _ -> T.strip (TE.decodeUtf8Lenient (BL.toStrict body))
