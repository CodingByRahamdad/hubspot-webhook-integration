// src/oauth.js
// HubSpot OAuth 2.0 (authorization code flow).
//
// Routes (mounted at /oauth in server.js):
//   GET /oauth/install   -> starts the flow, redirects the browser to HubSpot
//   GET /oauth/callback  -> HubSpot sends the user back here with ?code&state
//
// After a successful code exchange the tokens are saved ENCRYPTED in
// data/oauth-tokens.db (see src/oauth/tokenService.js, tokenStore.js and
// src/security/tokenCrypto.js). The callback only reports success AFTER the save
// worked. Tokens are never sent to the browser or written to logs.
//
// Configuration (environment variables): HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET,
// HUBSPOT_REDIRECT_URI, optional HUBSPOT_SCOPES, TOKEN_ENCRYPTION_KEY and optional
// OAUTH_TOKEN_DB_PATH (default data/oauth-tokens.db).
//
// Learning limitation: state values live in memory only (lost on restart, so an
// install started before a restart must be started again).

const crypto = require('crypto');
const express = require('express');
const { loadKey } = require('./security/tokenCrypto');
const { getTokenService, saveAuthorizedTokens } = require('./oauth/tokenService');

const router = express.Router();

const HUBSPOT_AUTHORIZE_URL = 'https://app.hubspot.com/oauth/authorize';
const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v3/token';
const HUBSPOT_INTROSPECT_URL = 'https://api.hubapi.com/oauth/v3/token/introspect';
const STATE_TTL_MS = 10 * 60 * 1000; // a login attempt is valid for 10 minutes
const HTTP_TIMEOUT_MS = 10 * 1000; // give up on HubSpot after 10 seconds
const MIN_EXPIRES_IN = 60; // same limits as src/oauth/hubspotTokenClient.js
const MAX_EXPIRES_IN = 7 * 24 * 60 * 60;
const MAX_TOKEN_CHARS = 8192;
const DEFAULT_SCOPES =
  'oauth crm.objects.contacts.read crm.objects.contacts.write crm.objects.companies.read crm.objects.deals.read crm.objects.tickets.read';

// state value -> expiry timestamp (ms). Each state can be used only once.
const pendingStates = new Map();

// Reads configuration at request time so a missing .env gives a clear error
// instead of crashing the whole server on startup.
function getConfig() {
  const clientId = process.env.HUBSPOT_CLIENT_ID;
  const clientSecret = process.env.HUBSPOT_CLIENT_SECRET;
  const redirectUri = process.env.HUBSPOT_REDIRECT_URI;
  const scopes = process.env.HUBSPOT_SCOPES || DEFAULT_SCOPES;

  if (!clientId || !clientSecret || !redirectUri) {
    return null;
  }
  return { clientId, clientSecret, redirectUri, scopes };
}

// Removes expired states so the Map cannot grow forever.
function sweepExpiredStates() {
  const now = Date.now();
  for (const [state, expiresAt] of pendingStates) {
    if (expiresAt <= now) pendingStates.delete(state);
  }
}

// Returns true only if the state exists and is not expired.
// The state is always deleted, so it cannot be replayed.
function consumeState(state) {
  const expiresAt = pendingStates.get(state);
  pendingStates.delete(state);
  return typeof expiresAt === 'number' && expiresAt > Date.now();
}

// A token must be a printable-ASCII string without spaces.
function isValidToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_CHARS && /^[\x21-\x7E]+$/.test(value);
}

const isPortalId = (value) => Number.isSafeInteger(value) && value > 0;

// Returns a list of invalid field NAMES (never values), or [] if the token
// response is usable.
function validateTokenResponse(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return ['body'];
  const problems = [];
  if (!isValidToken(data.access_token)) problems.push('access_token');
  if (!isValidToken(data.refresh_token)) problems.push('refresh_token');
  if (!Number.isInteger(data.expires_in) || data.expires_in < MIN_EXPIRES_IN || data.expires_in > MAX_EXPIRES_IN) {
    problems.push('expires_in');
  }
  return problems;
}

function configError(res) {
  return res.status(500).json({
    status: 'error',
    message:
      'OAuth is not configured. Set HUBSPOT_CLIENT_ID, HUBSPOT_CLIENT_SECRET and HUBSPOT_REDIRECT_URI in .env.',
  });
}

// Sends a form-encoded POST to HubSpot. Credentials go in the BODY (never the URL).
// Redirects are refused (the secret must not follow a redirect) and the request
// times out. Resolves { ok, status, data } (data is null if the body is not JSON);
// rejects on network errors and timeouts.
async function postForm(url, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params,
    redirect: 'error',
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  const data = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, data };
}

// Fallback when the token response has no usable hub_id: ask HubSpot who the new
// access token belongs to. Returns the portal ID or null. Logs only fixed text.
async function lookupPortalId(config, accessToken) {
  try {
    const result = await postForm(
      HUBSPOT_INTROSPECT_URL,
      new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        token_type_hint: 'access_token',
        token: accessToken,
      })
    );
    if (!result.ok) {
      console.error(`OAuth: token introspection failed (HTTP ${result.status}).`);
      return null;
    }
    const data = result.data;
    if (!data || typeof data !== 'object' || data.active !== true || !isPortalId(data.hub_id)) {
      console.error('OAuth: token introspection did not return a usable account ID.');
      return null;
    }
    return data.hub_id;
  } catch (err) {
    console.error(`OAuth: token introspection request failed (${err && err.name ? err.name : 'Error'}).`);
    return null;
  }
}

// Turns a storage/encryption failure into a safe HTTP response. Never includes
// error messages, only fixed text and a short code in the log.
function storageFailure(res, err) {
  const code = err && typeof err.code === 'string' && /^[A-Z_]{1,40}$/.test(err.code) ? err.code : 'UNKNOWN';
  const reason = err && typeof err.reason === 'string' && /^[A-Z_]{1,40}$/.test(err.reason) ? `, ${err.reason}` : '';
  console.error(`OAuth: tokens could not be stored (${code}${reason}).`);

  const name = err && err.name;
  if (code === 'ENCRYPTION_ERROR' || name === 'TokenCryptoError') {
    return res.status(500).json({
      status: 'error',
      message:
        'Tokens could not be stored securely because token encryption is not configured correctly. The HubSpot account was NOT connected.',
    });
  }
  if (code === 'STORAGE_ERROR' || name === 'TokenStoreError') {
    return res.status(503).json({
      status: 'error',
      message: 'Token storage is unavailable. The HubSpot account was NOT connected.',
    });
  }
  if (code === 'INVALID_INPUT') {
    return res.status(502).json({
      status: 'error',
      message: 'HubSpot returned token data that could not be stored. The HubSpot account was NOT connected.',
    });
  }
  return res.status(500).json({
    status: 'error',
    message: 'Tokens could not be stored. The HubSpot account was NOT connected.',
  });
}

// GET /oauth/install - step 1: send the user to HubSpot to approve access.
router.get('/install', (req, res) => {
  const config = getConfig();
  if (!config) return configError(res);

  sweepExpiredStates();

  const state = crypto.randomBytes(32).toString('hex');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: config.scopes,
    state,
  });

  console.log('OAuth: starting install, redirecting to HubSpot.');
  res.redirect(`${HUBSPOT_AUTHORIZE_URL}?${params.toString()}`);
});

// GET /oauth/callback - step 2: HubSpot sends the user back here.
router.get('/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  // The user clicked "Cancel", or HubSpot reported a problem.
  if (error) {
    // Only the error name is logged; the description is user-controlled text.
    console.warn(`OAuth: authorization failed or denied (${String(error)}).`);
    if (typeof state === 'string') pendingStates.delete(state);
    return res.status(400).json({
      status: 'error',
      message:
        error === 'access_denied'
          ? 'Authorization was denied. No access was granted.'
          : 'HubSpot reported an authorization error.',
    });
  }

  if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing required query parameters: code and state.',
    });
  }

  // CSRF protection: only accept a state that we issued, once, recently.
  if (!consumeState(state)) {
    console.warn('OAuth: invalid, expired or reused state.');
    return res.status(400).json({
      status: 'error',
      message: 'Invalid or expired state. Please start again at /oauth/install.',
    });
  }

  const config = getConfig();
  if (!config) return configError(res);

  // Check that tokens CAN be stored before using the one-time authorization code.
  // Otherwise a missing encryption key would waste the code and lose the tokens.
  try {
    loadKey();
    getTokenService();
  } catch (err) {
    return storageFailure(res, err);
  }

  try {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      code,
    });

    const exchange = await postForm(HUBSPOT_TOKEN_URL, body);
    const receivedAt = Date.now(); // expiry is counted from the moment the tokens arrived
    const data = exchange.data;

    if (!exchange.ok) {
      // Log only the HTTP status and a fixed label, never HubSpot's response text.
      const invalidGrant = exchange.status === 400 && data && typeof data === 'object' && data.error === 'invalid_grant';
      console.error(`OAuth: token exchange failed (HTTP ${exchange.status}${invalidGrant ? ', invalid_grant' : ''}).`);
      if (invalidGrant) {
        return res.status(400).json({
          status: 'error',
          message: 'The authorization code is invalid or expired. Please start again at /oauth/install.',
        });
      }
      return res.status(502).json({
        status: 'error',
        message:
          'Token exchange with HubSpot failed. Check your client ID, secret and redirect URI.',
      });
    }

    // Validate before storing so a malformed response never replaces tokens.
    const problems = validateTokenResponse(data);
    if (problems.length > 0) {
      console.error(
        `OAuth: unexpected token response (invalid fields: ${problems.join(', ')}).`
      );
      return res.status(502).json({
        status: 'error',
        message:
          'HubSpot returned an unexpected token response. No tokens were stored.',
      });
    }

    // Which HubSpot account is this? Prefer hub_id from the token response.
    const portalId = isPortalId(data.hub_id) ? data.hub_id : await lookupPortalId(config, data.access_token);
    if (!portalId) {
      return res.status(502).json({
        status: 'error',
        message: 'Could not determine the HubSpot account ID. No tokens were stored.',
      });
    }

    const scopes =
      Array.isArray(data.scopes) && data.scopes.length > 0 && data.scopes.every((s) => typeof s === 'string' && /^\S{1,200}$/.test(s))
        ? data.scopes
        : undefined;

    // Success is only reported AFTER the encrypted save worked.
    try {
      await saveAuthorizedTokens({
        portalId,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: receivedAt + data.expires_in * 1000,
        scopes,
      });
    } catch (err) {
      return storageFailure(res, err);
    }

    console.log(`OAuth: connected HubSpot portal ${portalId}; tokens stored encrypted.`);
    return res.status(200).json({
      status: 'success',
      message: 'HubSpot account connected. Tokens are stored encrypted.',
      portalId,
    });
  } catch (err) {
    // Network error or timeout. Log the error name only; never the request body.
    console.error(`OAuth: token exchange request failed (${err && err.name ? err.name : 'Error'}).`);
    return res.status(502).json({
      status: 'error',
      message: 'Could not reach HubSpot to exchange the authorization code.',
    });
  }
});

module.exports = router;
