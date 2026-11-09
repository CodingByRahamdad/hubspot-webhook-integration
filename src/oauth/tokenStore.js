// src/oauth/tokenStore.js
// Persistent, ENCRYPTED storage of HubSpot OAuth connections (Phase 3, step 2).
//
// - Its own SQLite file (default data/oauth-tokens.db), separate from the webhook
//   event database, built with Node's "node:sqlite" like src/idempotency/eventStore.js.
// - One row per HubSpot portal ID.
// - Callers pass PLAINTEXT tokens in and get plaintext out; this module encrypts
//   before writing (src/security/tokenCrypto.js) and decrypts after reading, so a
//   plaintext token can never reach the database by accident.
// - Every write is ONE SQL statement. update() and markNeedsReauth() compare a
//   row_version number, so a stale writer (for example a slow token refresh that
//   finished after someone else changed the row) is refused instead of overwriting.
// - All SQL is parameterized.
//
// This module NEVER logs. Its own errors carry a fixed generic message and a short
// code; raw database errors (which can contain SQL or data) are never passed on.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { encryptToken, decryptToken, loadKey } = require('../security/tokenCrypto');

const DEFAULT_DB_PATH = path.join('data', 'oauth-tokens.db');
const SCHEMA_VERSION = 1;
const CURRENT_KEY_VERSION = 1;
const STATUSES = Object.freeze(['active', 'needs_reauth']);

const MESSAGES = {
  INVALID_INPUT: 'Invalid input for the token store.',
  DB_OPEN_FAILED: 'Could not open the token database.',
  DB_ERROR: 'Token database operation failed.',
};

class TokenStoreError extends Error {
  constructor(code) {
    super(MESSAGES[code] || 'Token store error.');
    this.name = 'TokenStoreError';
    this.code = code;
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS oauth_connections (
    portal_id         TEXT PRIMARY KEY,
    access_token_enc  TEXT NOT NULL,
    refresh_token_enc TEXT NOT NULL,
    key_version       INTEGER NOT NULL,
    access_expires_at INTEGER NOT NULL,
    scopes            TEXT NOT NULL DEFAULT '',
    status            TEXT NOT NULL CHECK (status IN ('active', 'needs_reauth')),
    refresh_failures  INTEGER NOT NULL DEFAULT 0,
    last_refresh_at   INTEGER,
    last_error        TEXT,
    connected_at      INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    row_version       INTEGER NOT NULL
  )
`;

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function invalid() {
  return new TokenStoreError('INVALID_INPUT');
}

// Portal IDs are stored as text. "123" and 123 are the same portal.
function normalizePortalId(portalId) {
  if (typeof portalId === 'string' && portalId.length > 0 && portalId.length <= 64) return portalId;
  if (Number.isSafeInteger(portalId) && portalId > 0) return String(portalId);
  throw invalid();
}

function requireExpiresAt(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid();
  return value;
}

function requireVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid();
  return value;
}

// Scopes may be an array or a space-separated string. Stored space-separated.
function normalizeScopes(scopes) {
  if (scopes === undefined || scopes === null) return null;
  const list = Array.isArray(scopes) ? scopes : typeof scopes === 'string' ? scopes.split(/\s+/) : null;
  if (!list) throw invalid();
  const clean = list.filter((s) => s !== '');
  if (!clean.every((s) => typeof s === 'string' && /^\S{1,200}$/.test(s))) throw invalid();
  return clean.join(' ');
}

// Only a short code is ever kept as last_error (never a message).
function safeErrorCode(code) {
  return typeof code === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(code) ? code : 'unknown';
}

function toConnection(row, accessToken, refreshToken) {
  const base = metadata(row);
  return accessToken === undefined ? base : { ...base, accessToken, refreshToken };
}

// Everything EXCEPT the tokens (and their ciphertext).
function metadata(row) {
  return {
    portalId: row.portal_id,
    accessExpiresAt: row.access_expires_at,
    scopes: row.scopes === '' ? [] : row.scopes.split(' '),
    status: row.status,
    refreshFailures: row.refresh_failures,
    lastRefreshAt: row.last_refresh_at,
    lastError: row.last_error,
    connectedAt: row.connected_at,
    updatedAt: row.updated_at,
    rowVersion: row.row_version,
  };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

// options.key: 32-byte Buffer. If omitted, TOKEN_ENCRYPTION_KEY is read when a token
// is saved or read (and the operation fails securely if it is missing or invalid).
// options.now: clock, injectable for tests.
function createTokenStore(dbPath = DEFAULT_DB_PATH, { key, now = Date.now } = {}) {
  let db;
  try {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    }
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA busy_timeout = 5000'); // wait (not fail) if another connection holds a lock
    if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

    const { user_version: found } = db.prepare('PRAGMA user_version').get();
    if (found > SCHEMA_VERSION) throw new Error('database was created by a newer version');
    db.exec(SCHEMA);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  } catch {
    try {
      if (db) db.close();
    } catch {
      // ignore: we are already failing
    }
    throw new TokenStoreError('DB_OPEN_FAILED');
  }

  // New connection, or re-authorization: replaces the tokens, resets status/failures,
  // and bumps row_version so any refresh that started earlier is refused.
  const upsertStmt = db.prepare(`
    INSERT INTO oauth_connections
      (portal_id, access_token_enc, refresh_token_enc, key_version, access_expires_at, scopes,
       status, refresh_failures, last_refresh_at, last_error, connected_at, updated_at, row_version)
    VALUES (?, ?, ?, ?, ?, ?, 'active', 0, NULL, NULL, ?, ?, 1)
    ON CONFLICT (portal_id) DO UPDATE SET
      access_token_enc  = excluded.access_token_enc,
      refresh_token_enc = excluded.refresh_token_enc,
      key_version       = excluded.key_version,
      access_expires_at = excluded.access_expires_at,
      scopes            = excluded.scopes,
      status            = 'active',
      refresh_failures  = 0,
      last_refresh_at   = NULL,
      last_error        = NULL,
      connected_at      = excluded.connected_at,
      updated_at        = excluded.updated_at,
      row_version       = oauth_connections.row_version + 1
    RETURNING row_version
  `);

  // Compare-and-swap: only applies if row_version is still what the caller saw.
  // A NULL refresh token / scopes parameter keeps the stored value.
  const updateStmt = db.prepare(`
    UPDATE oauth_connections SET
      access_token_enc  = ?,
      refresh_token_enc = COALESCE(?, refresh_token_enc),
      access_expires_at = ?,
      scopes            = COALESCE(?, scopes),
      status            = 'active',
      refresh_failures  = 0,
      last_refresh_at   = ?,
      last_error        = NULL,
      updated_at        = ?,
      row_version       = row_version + 1
    WHERE portal_id = ? AND row_version = ?
    RETURNING row_version
  `);

  const reauthAnyStmt = db.prepare(`
    UPDATE oauth_connections SET
      status = 'needs_reauth', last_error = ?, updated_at = ?, row_version = row_version + 1
    WHERE portal_id = ?
    RETURNING row_version
  `);
  const reauthCasStmt = db.prepare(`
    UPDATE oauth_connections SET
      status = 'needs_reauth', last_error = ?, updated_at = ?, row_version = row_version + 1
    WHERE portal_id = ? AND row_version = ?
    RETURNING row_version
  `);
  const selectStmt = db.prepare('SELECT * FROM oauth_connections WHERE portal_id = ?');
  const listStmt = db.prepare('SELECT * FROM oauth_connections ORDER BY portal_id');

  const getKey = () => (key === undefined ? loadKey() : key);

  // Turns any unexpected database failure into a generic error (raw errors can
  // contain SQL text or data). Our own errors and TokenCryptoErrors are already safe.
  function guard(fn) {
    try {
      return fn();
    } catch (err) {
      if (err instanceof TokenStoreError || (err && err.name === 'TokenCryptoError')) throw err;
      throw new TokenStoreError('DB_ERROR');
    }
  }

  return {
    // Creates or replaces the connection for a portal. Returns { portalId, rowVersion }.
    save({ portalId, accessToken, refreshToken, expiresAt, scopes }) {
      return guard(() => {
        const portal = normalizePortalId(portalId);
        requireExpiresAt(expiresAt);
        const scopeText = normalizeScopes(scopes) ?? '';
        const aesKey = getKey();
        const accessEnc = encryptToken(accessToken, { portalId: portal, field: 'access_token', key: aesKey, keyVersion: CURRENT_KEY_VERSION });
        const refreshEnc = encryptToken(refreshToken, { portalId: portal, field: 'refresh_token', key: aesKey, keyVersion: CURRENT_KEY_VERSION });
        const t = now();
        const row = upsertStmt.get(portal, accessEnc, refreshEnc, CURRENT_KEY_VERSION, expiresAt, scopeText, t, t);
        return { portalId: portal, rowVersion: row.row_version };
      });
    },

    // Returns the connection with DECRYPTED tokens, or null if the portal is unknown.
    get(portalId) {
      return guard(() => {
        const portal = normalizePortalId(portalId);
        const row = selectStmt.get(portal);
        if (!row) return null;
        const aesKey = getKey();
        const accessToken = decryptToken(row.access_token_enc, { portalId: portal, field: 'access_token', key: aesKey, keyVersion: row.key_version });
        const refreshToken = decryptToken(row.refresh_token_enc, { portalId: portal, field: 'refresh_token', key: aesKey, keyVersion: row.key_version });
        return toConnection(row, accessToken, refreshToken);
      });
    },

    // Same as get() but WITHOUT tokens and without needing the encryption key.
    getStatus(portalId) {
      return guard(() => {
        const row = selectStmt.get(normalizePortalId(portalId));
        return row ? metadata(row) : null;
      });
    },

    // Metadata of every connection (no tokens), for status reports.
    list() {
      return guard(() => listStmt.all().map(metadata));
    },

    // Stores a refreshed token pair, ONLY if row_version is still expectedVersion.
    // refreshToken / scopes are optional (omitted = keep what is stored).
    // Returns { updated: true, rowVersion } or { updated: false } when the row is
    // missing or has changed in the meantime (a stale writer). Never overwrites then.
    update(portalId, expectedVersion, { accessToken, refreshToken, expiresAt, scopes }) {
      return guard(() => {
        const portal = normalizePortalId(portalId);
        requireVersion(expectedVersion);
        requireExpiresAt(expiresAt);
        const scopeText = normalizeScopes(scopes);
        const aesKey = getKey();
        const accessEnc = encryptToken(accessToken, { portalId: portal, field: 'access_token', key: aesKey, keyVersion: CURRENT_KEY_VERSION });
        const refreshEnc =
          refreshToken === undefined || refreshToken === null
            ? null
            : encryptToken(refreshToken, { portalId: portal, field: 'refresh_token', key: aesKey, keyVersion: CURRENT_KEY_VERSION });
        const t = now();
        const row = updateStmt.get(accessEnc, refreshEnc, expiresAt, scopeText, t, t, portal, expectedVersion);
        return row ? { updated: true, rowVersion: row.row_version } : { updated: false };
      });
    },

    // Marks the connection as needing the user to authorize again. The tokens are
    // kept (not deleted). Bumps row_version, so a stale refresh can no longer write.
    // expectedVersion is optional; when given, the change only applies if it matches.
    // Returns { updated: true, rowVersion } or { updated: false }.
    markNeedsReauth(portalId, errorCode, expectedVersion) {
      return guard(() => {
        const portal = normalizePortalId(portalId);
        const code = safeErrorCode(errorCode);
        const t = now();
        const row =
          expectedVersion === undefined
            ? reauthAnyStmt.get(code, t, portal)
            : reauthCasStmt.get(code, t, portal, requireVersion(expectedVersion));
        return row ? { updated: true, rowVersion: row.row_version } : { updated: false };
      });
    },

    close() {
      try {
        db.close();
      } catch {
        throw new TokenStoreError('DB_ERROR');
      }
    },
  };
}

module.exports = { createTokenStore, TokenStoreError, DEFAULT_DB_PATH, STATUSES };
