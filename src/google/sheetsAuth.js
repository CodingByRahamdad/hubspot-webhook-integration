// src/google/sheetsAuth.js
// Google SERVICE-ACCOUNT authentication for the Sheets integration (see docs/23).
//
//   loadServiceAccountCredentials()  reads + validates the key file
//   createSheetsAuth()               builds a Google JWT client limited to Sheets
//   authenticate(client)             proves Google accepts the key (safe errors)
//   getSheetsAuth() / resetSheetsAuth()   shared instance, created on first use
//
// Why JWT and not GoogleAuth({ credentials })? The Google library marks the
// "credentials"/"keyFilename" options as deprecated and recommends constructing the
// client class directly. We validate the key file ourselves first, then hand the library
// only the three things it needs: the account email, the private key and the scope.
//
// The key file path comes ONLY from the GOOGLE_SERVICE_ACCOUNT_KEY_FILE environment
// variable. There is no default path and no key in source code. Nothing happens when
// this file is required: a missing Google setup can never stop the server from starting
// or the webhook receiver from working.
//
// Completely separate from HubSpot OAuth: it imports nothing from src/oauth*,
// src/security or src/webhooks, and uses no HubSpot tokens or database.
//
// This module never logs. Every failure is a GoogleSheetsError with a fixed message and
// a short code; the raw error, the file path and the credentials are never passed on.

const fs = require('node:fs');
const { auth: googleAuthNamespace } = require('@googleapis/sheets');
const { GoogleSheetsError, isTemporaryNetworkError } = require('./sheetsErrors');

const KEY_FILE_ENV_VAR = 'GOOGLE_SERVICE_ACCOUNT_KEY_FILE';
// The smallest scope that can read and write spreadsheet cells. No Drive access.
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const MAX_KEY_FILE_BYTES = 64 * 1024; // real key files are about 2.4 KB

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PEM_PATTERN = /^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\s*$/;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Checks the shape of a parsed key file. Returns true/false only: it never reports
// which value was wrong, so nothing from the file can leak into an error.
function looksLikeServiceAccountKey(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.type !== 'service_account') return false;
  if (!isNonEmptyString(data.client_email) || !EMAIL_PATTERN.test(data.client_email)) return false;
  if (!isNonEmptyString(data.private_key) || !PEM_PATTERN.test(data.private_key.trim())) return false;
  return true;
}

// Reads and validates the key file. Returns the parsed credentials for INTERNAL use
// (they go straight into GoogleAuth). Callers must never print or return them.
// "env" and "fileSystem" are parameters so tests never touch the real environment or disk.
function loadServiceAccountCredentials({ env = process.env, fileSystem = fs } = {}) {
  const keyPath = env ? env[KEY_FILE_ENV_VAR] : undefined;
  if (typeof keyPath !== 'string' || keyPath.trim() === '') {
    throw new GoogleSheetsError('CONFIG_MISSING');
  }

  let stat;
  try {
    stat = fileSystem.statSync(keyPath);
  } catch (err) {
    const missing = err && (err.code === 'ENOENT' || err.code === 'ENOTDIR');
    throw new GoogleSheetsError(missing ? 'CREDENTIALS_FILE_NOT_FOUND' : 'CREDENTIALS_FILE_UNREADABLE', {
      reason: err && err.code,
    });
  }
  if (!stat.isFile() || stat.size > MAX_KEY_FILE_BYTES) {
    throw new GoogleSheetsError('CREDENTIALS_FILE_UNREADABLE');
  }

  let text;
  try {
    text = fileSystem.readFileSync(keyPath, 'utf8');
  } catch (err) {
    throw new GoogleSheetsError('CREDENTIALS_FILE_UNREADABLE', { reason: err && err.code });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // The JSON error message can quote part of the file: it is deliberately dropped.
    throw new GoogleSheetsError('CREDENTIALS_INVALID_JSON');
  }

  if (!looksLikeServiceAccountKey(data)) throw new GoogleSheetsError('CREDENTIALS_INVALID');
  return data;
}

// Builds the Google JWT client. It makes NO network request: Google is only contacted
// later, when a token is actually needed (an API call, or authenticate()). The key file
// is read once, here, so what was validated is exactly what is used.
function createSheetsAuth({ env = process.env, fileSystem = fs, JWT = googleAuthNamespace.JWT } = {}) {
  const credentials = loadServiceAccountCredentials({ env, fileSystem });
  const options = {
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [SHEETS_SCOPE],
  };
  if (isNonEmptyString(credentials.private_key_id)) options.keyId = credentials.private_key_id;
  try {
    return new JWT(options);
  } catch {
    throw new GoogleSheetsError('INTERNAL_ERROR');
  }
}

// Turns anything thrown by the Google library into a safe GoogleSheetsError.
// (Its messages can quote the account email or key, so they are never used.)
function toAuthError(err) {
  if (err instanceof GoogleSheetsError) return err;
  const code = err && typeof err.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code) ? err.code : null;
  const status = err && err.response && Number.isInteger(err.response.status) ? err.response.status : null;
  // Network problems and Google 429/5xx are temporary; anything else means Google (or the key) said no.
  if (isTemporaryNetworkError(err) || (status !== null && (status === 429 || status >= 500))) {
    return new GoogleSheetsError('AUTH_UNAVAILABLE', { reason: code });
  }
  return new GoogleSheetsError('AUTH_FAILED', { reason: code });
}

// Asks Google for an access token to prove the key is accepted (this is the one place
// that contacts Google). Resolves true on success. The token itself is deliberately
// NOT returned: the client keeps and renews it internally.
async function authenticate(client) {
  if (!client || typeof client.authorize !== 'function') throw new GoogleSheetsError('INVALID_INPUT');
  try {
    await client.authorize();
    return true;
  } catch (err) {
    throw toAuthError(err);
  }
}

// ---------------------------------------------------------------------------
// Shared instance for the application (created on first use, not at require time)
// ---------------------------------------------------------------------------

let defaultAuth = null;

function getSheetsAuth() {
  if (!defaultAuth) defaultAuth = createSheetsAuth();
  return defaultAuth;
}

function resetSheetsAuth() {
  defaultAuth = null;
}

module.exports = {
  KEY_FILE_ENV_VAR,
  SHEETS_SCOPE,
  loadServiceAccountCredentials,
  createSheetsAuth,
  authenticate,
  getSheetsAuth,
  resetSheetsAuth,
};
