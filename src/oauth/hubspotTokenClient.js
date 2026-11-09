// src/oauth/hubspotTokenClient.js
// Sends the HubSpot "refresh token" request and returns normalized token data
// (Phase 3, step 3). It only talks to HubSpot: it does not store tokens (see
// tokenStore.js) and does not decide what to do after a failure (a later step).
//
//   POST https://api.hubapi.com/oauth/v3/token
//   grant_type=refresh_token & client_id & client_secret & refresh_token  (form BODY)
//
// Credentials come from HUBSPOT_CLIENT_ID / HUBSPOT_CLIENT_SECRET in process.env
// (loaded from .env by server.js; this file never reads .env itself).
//
// SAFETY: this module never logs. Every failure becomes a HubspotTokenError with a
// fixed message and a short code. Raw fetch errors and HubSpot response bodies are
// NEVER copied into an error (bodies are only inspected to classify the failure).

const HUBSPOT_TOKEN_URL = 'https://api.hubapi.com/oauth/v3/token';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_BODY_CHARS = 100_000;
const MAX_TOKEN_CHARS = 8192;
const MIN_EXPIRES_IN = 60; // seconds; HubSpot normally sends 1800
const MAX_EXPIRES_IN = 7 * 24 * 60 * 60;
const MAX_RETRY_AFTER_SECONDS = 3600;

const ERRORS = {
  CONFIG_MISSING: { message: 'HubSpot client credentials are not configured.', retryable: false, reauthRequired: false },
  INVALID_INPUT: { message: 'Invalid input for the token refresh.', retryable: false, reauthRequired: false },
  NETWORK_ERROR: { message: 'Could not reach HubSpot.', retryable: true, reauthRequired: false },
  TIMEOUT: { message: 'The HubSpot token request timed out.', retryable: true, reauthRequired: false },
  RATE_LIMITED: { message: 'HubSpot rate limit reached.', retryable: true, reauthRequired: false },
  SERVER_ERROR: { message: 'HubSpot reported a temporary server error.', retryable: true, reauthRequired: false },
  INVALID_GRANT: { message: 'HubSpot rejected the refresh token. The account must be authorized again.', retryable: false, reauthRequired: true },
  INVALID_CLIENT: { message: 'HubSpot rejected the app credentials.', retryable: false, reauthRequired: false },
  REQUEST_REJECTED: { message: 'HubSpot rejected the token request.', retryable: false, reauthRequired: false },
  INVALID_JSON: { message: 'HubSpot returned a response that is not valid JSON.', retryable: true, reauthRequired: false },
  INVALID_RESPONSE: { message: 'HubSpot returned an unexpected token response.', retryable: true, reauthRequired: false },
};

class HubspotTokenError extends Error {
  constructor(code, { httpStatus = null, retryAfterMs = null } = {}) {
    const info = ERRORS[code] || { message: 'Token request failed.', retryable: false, reauthRequired: false };
    super(info.message);
    this.name = 'HubspotTokenError';
    this.code = code;
    this.retryable = info.retryable;
    this.reauthRequired = info.reauthRequired;
    this.httpStatus = httpStatus;
    this.retryAfterMs = retryAfterMs;
  }
}

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

// A token must be a printable-ASCII string without spaces (safe for headers).
function isValidToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_TOKEN_CHARS && /^[\x21-\x7E]+$/.test(value);
}

function parseJson(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_BODY_CHARS) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

// Only whole seconds, capped; anything else is ignored.
function readRetryAfterMs(response) {
  try {
    const raw = response.headers && typeof response.headers.get === 'function' ? response.headers.get('retry-after') : null;
    if (typeof raw !== 'string' || !/^\d{1,4}$/.test(raw.trim())) return null;
    const seconds = Number(raw.trim());
    return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

// Decides which error an HTTP error status is. The body is read only to classify.
function classifyHttpError(status, body, response) {
  if (status === 429) return new HubspotTokenError('RATE_LIMITED', { httpStatus: status, retryAfterMs: readRetryAfterMs(response) });
  if (status >= 500 || status === 408) return new HubspotTokenError('SERVER_ERROR', { httpStatus: status });
  if (status === 400 || status === 401) {
    const parsed = body && body.ok && body.value && typeof body.value === 'object' ? body.value : null;
    if (parsed && (parsed.error === 'invalid_grant' || parsed.status === 'BAD_REFRESH_TOKEN')) {
      return new HubspotTokenError('INVALID_GRANT', { httpStatus: status });
    }
    if (parsed && (parsed.error === 'invalid_client' || parsed.error === 'unauthorized_client')) {
      return new HubspotTokenError('INVALID_CLIENT', { httpStatus: status });
    }
  }
  return new HubspotTokenError('REQUEST_REJECTED', { httpStatus: status });
}

// Validates a successful body and returns normalized data, or null if unusable.
function normalizeSuccess(data, now) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (!isValidToken(data.access_token)) return null;
  const expiresIn = data.expires_in;
  if (!Number.isInteger(expiresIn) || expiresIn < MIN_EXPIRES_IN || expiresIn > MAX_EXPIRES_IN) return null;

  // HubSpot may or may not send a new refresh token: absent is fine, garbage is not.
  let refreshToken = null;
  if (data.refresh_token !== undefined && data.refresh_token !== null) {
    if (!isValidToken(data.refresh_token)) return null;
    refreshToken = data.refresh_token;
  }

  const scopes =
    Array.isArray(data.scopes) && data.scopes.every((s) => typeof s === 'string' && /^\S{1,200}$/.test(s)) ? [...data.scopes] : [];
  const hubId = Number.isSafeInteger(data.hub_id) && data.hub_id > 0 ? data.hub_id : null;

  return {
    accessToken: data.access_token,
    refreshToken,
    expiresIn,
    expiresAt: now() + expiresIn * 1000,
    scopes,
    hubId,
  };
}

function createHubspotTokenClient({ fetchImpl, env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new HubspotTokenError('INVALID_INPUT');
  }
  const doFetch = fetchImpl || ((...args) => globalThis.fetch(...args));

  // Returns { accessToken, refreshToken|null, expiresIn, expiresAt, scopes, hubId }.
  // Throws HubspotTokenError (see the table in docs / the "ERRORS" object above).
  async function refreshAccessToken(refreshToken) {
    const clientId = env ? env.HUBSPOT_CLIENT_ID : undefined;
    const clientSecret = env ? env.HUBSPOT_CLIENT_SECRET : undefined;
    if (!isNonEmptyString(clientId) || !isNonEmptyString(clientSecret)) throw new HubspotTokenError('CONFIG_MISSING');
    if (!isNonEmptyString(refreshToken)) throw new HubspotTokenError('INVALID_INPUT');

    // Credentials go in the BODY, never in the URL.
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }).toString();

    const controller = new AbortController();
    let timedOut = false;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new HubspotTokenError('TIMEOUT'));
      }, timeoutMs);
    });

    const perform = async () => {
      let response;
      try {
        response = await doFetch(HUBSPOT_TOKEN_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body,
          redirect: 'error', // never send the client secret to a redirect target
          signal: controller.signal,
        });
      } catch {
        throw new HubspotTokenError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR');
      }

      const status = response && response.status;
      if (!Number.isInteger(status) || typeof response.text !== 'function') throw new HubspotTokenError('INVALID_RESPONSE');
      const isSuccess = status >= 200 && status < 300;

      let text = null;
      try {
        text = await response.text();
      } catch {
        if (timedOut) throw new HubspotTokenError('TIMEOUT');
        if (isSuccess) throw new HubspotTokenError('NETWORK_ERROR');
        // Error status and unreadable body: classify by status alone.
      }

      if (!isSuccess) {
        if (status < 400) throw new HubspotTokenError('INVALID_RESPONSE', { httpStatus: status });
        throw classifyHttpError(status, parseJson(text), response);
      }

      const parsed = parseJson(text);
      if (!parsed.ok) throw new HubspotTokenError('INVALID_JSON', { httpStatus: status });
      const result = normalizeSuccess(parsed.value, now);
      if (!result) throw new HubspotTokenError('INVALID_RESPONSE', { httpStatus: status });
      return result;
    };

    try {
      // The race makes the timeout reliable even if a fetch ignores the abort signal.
      return await Promise.race([perform(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  return { refreshAccessToken };
}

module.exports = {
  createHubspotTokenClient,
  HubspotTokenError,
  HUBSPOT_TOKEN_URL,
  DEFAULT_TIMEOUT_MS,
};
