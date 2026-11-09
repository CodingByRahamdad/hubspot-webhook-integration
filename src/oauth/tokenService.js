// src/oauth/tokenService.js
// Hands out a VALID HubSpot access token and keeps it fresh (Phase 3, step 4).
//
//   getValidAccessToken(portalId)  -> a working access token (string)
//   saveAuthorizedTokens(...)      -> store tokens after the OAuth callback
//   getConnectionStatus(portalId)  -> metadata only, never tokens
//
// Built from three injected parts (all tested separately):
//   store  = tokenStore.js         (encrypted SQLite, version-checked writes)
//   client = hubspotTokenClient.js (the refresh request to HubSpot)
//   now    = clock
//
// How a refresh stays safe:
//   - Within one process, concurrent callers share ONE in-flight refresh.
//   - Across processes, the store only accepts the new tokens if the row has not
//     changed since we read it (row_version). A stale result is thrown away.
//   - If HubSpot sends no new refresh token, the stored one is kept.
//   - A refresh token HubSpot rejects marks the connection "needs_reauth".
//   - Temporary failures never touch the stored tokens; they start a bounded
//     cooldown so we do not hammer HubSpot.
//   - An expired access token is NEVER returned after a failed refresh.
//
// This module never logs. Every error is a TokenServiceError with a fixed message
// and a short safe code; raw store, crypto, client or HubSpot errors are never passed on.

const { createTokenStore, TokenStoreError, DEFAULT_DB_PATH } = require('./tokenStore');
const { createHubspotTokenClient, HubspotTokenError } = require('./hubspotTokenClient');
const { TokenCryptoError } = require('../security/tokenCrypto');

const DEFAULTS = {
  skewMs: 5 * 60 * 1000, // refresh when 5 minutes or less remain
  minUsableMs: 30 * 1000, // after a failed refresh, a token with less than this left is not used
  cooldownMs: 30 * 1000, // first pause after a temporary failure (doubles each time)
  maxCooldownMs: 5 * 60 * 1000,
};
const MIN_COOLDOWN_MS = 1000;
const MAX_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

const ERRORS = {
  INVALID_INPUT: { message: 'Invalid input for the token service.', retryable: false, reauthRequired: false },
  NOT_CONNECTED: { message: 'No HubSpot connection exists for this portal.', retryable: false, reauthRequired: false },
  REAUTH_REQUIRED: { message: 'The HubSpot account must be authorized again.', retryable: false, reauthRequired: true },
  REFRESH_FAILED: { message: 'Refreshing the HubSpot token failed temporarily.', retryable: true, reauthRequired: false },
  REFRESH_COOLDOWN: { message: 'A token refresh failed recently; waiting before trying again.', retryable: true, reauthRequired: false },
  REFRESH_CONFLICT: { message: 'The stored token changed during the refresh; try again.', retryable: true, reauthRequired: false },
  REFRESH_REJECTED: { message: 'HubSpot rejected the token refresh request.', retryable: false, reauthRequired: false },
  REFRESH_MISCONFIGURED: { message: 'The HubSpot app credentials are not configured.', retryable: false, reauthRequired: false },
  ENCRYPTION_ERROR: { message: 'Stored tokens could not be encrypted or decrypted.', retryable: false, reauthRequired: false },
  STORAGE_ERROR: { message: 'The token database is unavailable.', retryable: true, reauthRequired: false },
  INTERNAL_ERROR: { message: 'Unexpected token service error.', retryable: false, reauthRequired: false },
};

class TokenServiceError extends Error {
  constructor(code, { retryAfterMs = null, reason = null } = {}) {
    const info = ERRORS[code] || ERRORS.INTERNAL_ERROR;
    super(info.message);
    this.name = 'TokenServiceError';
    this.code = code;
    this.retryable = info.retryable;
    this.reauthRequired = info.reauthRequired;
    this.retryAfterMs = retryAfterMs;
    this.reason = reason; // a short code from the layer below (never a message)
  }
}

// Failures after which a still-usable (not expired) access token may be returned.
const FALLBACK_CODES = new Set(['REFRESH_FAILED', 'REFRESH_COOLDOWN', 'REFRESH_CONFLICT']);

function normalizePortalId(portalId) {
  if (typeof portalId === 'string' && portalId.length > 0 && portalId.length <= 64) return portalId;
  if (Number.isSafeInteger(portalId) && portalId > 0) return String(portalId);
  throw new TokenServiceError('INVALID_INPUT');
}

// Converts anything thrown below us into a safe TokenServiceError.
function toServiceError(err) {
  if (err instanceof TokenServiceError) return err;
  if (err instanceof TokenCryptoError) return new TokenServiceError('ENCRYPTION_ERROR', { reason: err.code });
  if (err instanceof TokenStoreError) return new TokenServiceError('STORAGE_ERROR', { reason: err.code });
  return new TokenServiceError('INTERNAL_ERROR');
}

function createTokenService({ store, client, now = Date.now, ...options } = {}) {
  const cfg = { ...DEFAULTS, ...options };
  const storeOk = store && ['get', 'getStatus', 'save', 'update', 'markNeedsReauth'].every((m) => typeof store[m] === 'function');
  const clientOk = client && typeof client.refreshAccessToken === 'function';
  const numbersOk = ['skewMs', 'minUsableMs', 'cooldownMs', 'maxCooldownMs'].every((k) => Number.isSafeInteger(cfg[k]) && cfg[k] > 0);
  if (!storeOk || !clientOk || typeof now !== 'function' || !numbersOk || cfg.maxCooldownMs < MIN_COOLDOWN_MS) {
    throw new TokenServiceError('INVALID_INPUT');
  }

  const inFlight = new Map(); // portalId -> Promise of the new access token
  const cooldowns = new Map(); // portalId -> { until, failures, at }

  function activeCooldown(portal) {
    const entry = cooldowns.get(portal);
    return entry && entry.until > now() ? entry : null;
  }

  // Records a failure and returns how long to wait. Uses HubSpot's Retry-After when
  // present, otherwise doubles the pause with every consecutive failure. Bounded.
  function startCooldown(portal, retryAfterMs) {
    const previous = cooldowns.get(portal);
    const stillCounting = previous && now() - previous.at <= cfg.maxCooldownMs * 2;
    const failures = (stillCounting ? previous.failures : 0) + 1;
    const wanted = retryAfterMs !== null && retryAfterMs !== undefined ? retryAfterMs : cfg.cooldownMs * 2 ** Math.min(failures - 1, 20);
    const delay = Math.min(cfg.maxCooldownMs, Math.max(MIN_COOLDOWN_MS, wanted));
    cooldowns.set(portal, { until: now() + delay, failures, at: now() });
    return delay;
  }

  function failureToServiceError(portal, err) {
    if (err.retryable) {
      const delay = startCooldown(portal, err.retryAfterMs);
      return new TokenServiceError('REFRESH_FAILED', { retryAfterMs: delay, reason: err.code });
    }
    if (err.code === 'INVALID_CLIENT' || err.code === 'REQUEST_REJECTED') {
      const delay = startCooldown(portal, null);
      return new TokenServiceError('REFRESH_REJECTED', { retryAfterMs: delay, reason: err.code });
    }
    if (err.code === 'CONFIG_MISSING' || err.code === 'INVALID_INPUT') {
      return new TokenServiceError('REFRESH_MISCONFIGURED', { reason: err.code });
    }
    return new TokenServiceError('REFRESH_REJECTED', { reason: err.code });
  }

  // The refresh itself. At most two attempts: a second one only happens when the row
  // changed underneath us (another process, or a new authorization).
  async function doRefresh(portal) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const conn = store.get(portal); // fresh read: someone else may have refreshed already
      if (!conn) throw new TokenServiceError('NOT_CONNECTED');
      if (conn.status !== 'active') throw new TokenServiceError('REAUTH_REQUIRED');
      if (conn.accessExpiresAt - now() > cfg.skewMs) {
        cooldowns.delete(portal);
        return conn.accessToken;
      }

      let result;
      try {
        result = await client.refreshAccessToken(conn.refreshToken);
      } catch (err) {
        if (!(err instanceof HubspotTokenError)) throw err;
        if (err.reauthRequired) {
          // Only mark the connection if it is still the row we tried to refresh.
          const marked = store.markNeedsReauth(portal, err.code, conn.rowVersion);
          if (marked.updated) {
            cooldowns.delete(portal);
            throw new TokenServiceError('REAUTH_REQUIRED', { reason: err.code });
          }
          continue; // the row changed meanwhile: look at the newer one
        }
        throw failureToServiceError(portal, err);
      }

      const saved = store.update(portal, conn.rowVersion, {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken === null ? undefined : result.refreshToken, // undefined = keep the old one
        expiresAt: result.expiresAt,
        scopes: Array.isArray(result.scopes) && result.scopes.length > 0 ? result.scopes : undefined,
      });
      if (saved.updated) {
        cooldowns.delete(portal);
        return result.accessToken;
      }
      // Stale: our result is discarded (never overwrites newer data). Loop and re-read.
    }
    throw new TokenServiceError('REFRESH_CONFLICT', { retryAfterMs: MIN_COOLDOWN_MS });
  }

  function startRefresh(portal) {
    const promise = (async () => {
      try {
        return await doRefresh(portal);
      } finally {
        inFlight.delete(portal);
      }
    })();
    inFlight.set(portal, promise);
    return promise;
  }

  // After a temporary failure, a token that is not expired (with a small safety margin)
  // is still fine to use. An expired one is never returned.
  function usableOrThrow(conn, error) {
    if (conn.accessExpiresAt - now() > cfg.minUsableMs) return conn.accessToken;
    throw error;
  }

  async function getValid(portal) {
    const conn = store.get(portal);
    if (!conn) throw new TokenServiceError('NOT_CONNECTED');
    if (conn.status !== 'active') throw new TokenServiceError('REAUTH_REQUIRED');
    if (conn.accessExpiresAt - now() > cfg.skewMs) return conn.accessToken;

    let pending = inFlight.get(portal);
    if (!pending) {
      const cooling = activeCooldown(portal);
      if (cooling) {
        return usableOrThrow(
          conn,
          new TokenServiceError('REFRESH_COOLDOWN', { retryAfterMs: cooling.until - now() })
        );
      }
      pending = startRefresh(portal);
    }

    try {
      return await pending; // concurrent callers all wait for the same refresh
    } catch (err) {
      if (err instanceof TokenServiceError && FALLBACK_CODES.has(err.code)) return usableOrThrow(conn, err);
      throw err;
    }
  }

  return {
    // Returns a valid access token or throws a TokenServiceError.
    async getValidAccessToken(portalId) {
      try {
        return await getValid(normalizePortalId(portalId));
      } catch (err) {
        throw toServiceError(err);
      }
    },

    // For the OAuth callback: stores a freshly authorized token pair (encrypted).
    // Give exactly one of expiresIn (seconds, as HubSpot sends it) or expiresAt (ms).
    // Returns { portalId, rowVersion } only.
    async saveAuthorizedTokens({ portalId, accessToken, refreshToken, expiresIn, expiresAt, scopes } = {}) {
      try {
        const portal = normalizePortalId(portalId);
        const hasIn = expiresIn !== undefined;
        const hasAt = expiresAt !== undefined;
        if (hasIn === hasAt) throw new TokenServiceError('INVALID_INPUT');
        if (hasIn && !(Number.isSafeInteger(expiresIn) && expiresIn >= 1 && expiresIn <= MAX_EXPIRES_IN_SECONDS)) {
          throw new TokenServiceError('INVALID_INPUT');
        }
        if (typeof accessToken !== 'string' || !accessToken || typeof refreshToken !== 'string' || !refreshToken) {
          throw new TokenServiceError('INVALID_INPUT');
        }
        const saved = store.save({
          portalId: portal,
          accessToken,
          refreshToken,
          expiresAt: hasIn ? now() + expiresIn * 1000 : expiresAt,
          scopes,
        });
        cooldowns.delete(portal); // a new authorization starts clean
        return { portalId: saved.portalId, rowVersion: saved.rowVersion };
      } catch (err) {
        const mapped = toServiceError(err);
        throw mapped;
      }
    },

    // Metadata only (never tokens). null if the portal is not connected.
    getConnectionStatus(portalId) {
      try {
        const status = store.getStatus(normalizePortalId(portalId));
        if (!status) return null;
        const cooling = activeCooldown(String(status.portalId));
        return { ...status, refreshCooldownUntil: cooling ? cooling.until : null };
      } catch (err) {
        throw toServiceError(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Shared instance for the application (created on first use, not at require time)
// ---------------------------------------------------------------------------

let defaultService = null;
let defaultStore = null;

function getTokenService() {
  if (!defaultService) {
    const store = createTokenStore(process.env.OAUTH_TOKEN_DB_PATH || DEFAULT_DB_PATH);
    try {
      defaultService = createTokenService({ store, client: createHubspotTokenClient() });
    } catch (err) {
      store.close();
      throw err;
    }
    defaultStore = store;
  }
  return defaultService;
}

function closeTokenService() {
  const store = defaultStore;
  defaultStore = null;
  defaultService = null;
  if (store) store.close();
}

async function getValidAccessToken(portalId) {
  let service;
  try {
    service = getTokenService();
  } catch (err) {
    throw toServiceError(err);
  }
  return service.getValidAccessToken(portalId);
}

async function saveAuthorizedTokens(details) {
  let service;
  try {
    service = getTokenService();
  } catch (err) {
    throw toServiceError(err);
  }
  return service.saveAuthorizedTokens(details);
}

module.exports = {
  createTokenService,
  TokenServiceError,
  getTokenService,
  closeTokenService,
  getValidAccessToken,
  saveAuthorizedTokens,
};
