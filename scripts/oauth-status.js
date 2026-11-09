// scripts/oauth-status.js
// READ-ONLY report of the HubSpot OAuth connection(s) (see docs/22).
//
// Run from the project folder:
//   npm run oauth:status                      show the connection status
//   npm run oauth:status -- --check-decrypt   also check the stored tokens can be
//                                             decrypted with the configured key
//
// It only reads: it never creates, changes or repairs the database. It selects
// metadata columns only; the encrypted token columns are read solely for
// --check-decrypt, in memory, and never printed. It prints no tokens, ciphertext,
// encryption key, file paths or raw database errors.
//
// Exit codes: 0 = report shown, 1 = --check-decrypt found a problem,
//             2 = the database could not be read (or bad usage).

require('dotenv').config({ quiet: true });

const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { loadKey, decryptToken } = require('../src/security/tokenCrypto');
const { DEFAULT_DB_PATH } = require('../src/oauth/tokenStore');

const args = process.argv.slice(2);
const checkDecrypt = args.includes('--check-decrypt');
if (args.some((a) => a !== '--check-decrypt')) {
  console.error('Usage: npm run oauth:status [-- --check-decrypt]');
  process.exit(2);
}

const dbPath = process.env.OAUTH_TOKEN_DB_PATH || DEFAULT_DB_PATH;
const customLocation = Boolean(process.env.OAUTH_TOKEN_DB_PATH);

// Only a short code is shown from the database, never free text.
const safeCode = (value) => (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,60}$/.test(value) ? value : value ? 'unknown' : '');
const safePortal = (value) => (typeof value === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(value) ? value : '(invalid)');

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function relative(ms, now) {
  if (!Number.isFinite(ms)) return '';
  const minutes = Math.round(Math.abs(ms - now) / 60000);
  return ms > now ? `expires in ${minutes} min` : `expired ${minutes} min ago`;
}

function keyStatus() {
  try {
    return { state: 'configured', key: loadKey() };
  } catch (err) {
    return { state: err && err.code === 'KEY_MISSING' ? 'missing' : 'invalid', key: null };
  }
}

function main() {
  const now = Date.now();
  const { state: keyState, key } = keyStatus();

  console.log('HubSpot OAuth status (read-only)');
  console.log(`  Encryption key (TOKEN_ENCRYPTION_KEY): ${keyState}`);
  console.log(`  Token database location: ${customLocation ? 'custom (OAUTH_TOKEN_DB_PATH)' : 'default'}`);

  if (!fs.existsSync(dbPath)) {
    console.log('  Token database: not found (no HubSpot account has been connected yet)');
    console.log('\nNo HubSpot account is connected.');
    return checkDecrypt && keyState !== 'configured' ? 1 : 0;
  }

  let db;
  let rows;
  let secrets = [];
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    rows = db
      .prepare(
        `SELECT portal_id, status, access_expires_at, scopes, refresh_failures,
                last_refresh_at, last_error, connected_at, key_version
         FROM oauth_connections ORDER BY portal_id`
      )
      .all();
    if (checkDecrypt && key) {
      secrets = db.prepare('SELECT portal_id, access_token_enc, refresh_token_enc, key_version FROM oauth_connections ORDER BY portal_id').all();
    }
  } catch {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
    console.log('  Token database: could not be read');
    return 2;
  }
  db.close();
  console.log('  Token database: found');

  if (rows.length === 0) {
    console.log('\nNo HubSpot account is connected.');
    return checkDecrypt && keyState !== 'configured' ? 1 : 0;
  }

  // --check-decrypt: in memory only; the result is just ok / cannot decrypt.
  const decryptResult = new Map();
  let problems = 0;
  if (checkDecrypt) {
    for (const row of secrets) {
      let ok = true;
      try {
        decryptToken(row.access_token_enc, { portalId: row.portal_id, field: 'access_token', key, keyVersion: row.key_version });
        decryptToken(row.refresh_token_enc, { portalId: row.portal_id, field: 'refresh_token', key, keyVersion: row.key_version });
      } catch {
        ok = false;
      }
      decryptResult.set(row.portal_id, ok);
      if (!ok) problems += 1;
    }
    if (!key) problems += 1;
  }

  const active = rows.filter((r) => r.status === 'active').length;
  const reauth = rows.length - active;
  console.log(`\n${rows.length} HubSpot account(s) connected (${active} active, ${reauth} need re-authorization):`);
  console.table(
    rows.map((r) => {
      const line = {
        portal_id: safePortal(r.portal_id),
        status: r.status === 'active' ? 'active' : 'needs re-authorization',
        access_token: relative(r.access_expires_at, now),
        access_expires_at: iso(r.access_expires_at),
        last_refresh_at: iso(r.last_refresh_at),
        connected_at: iso(r.connected_at),
        refresh_failures: r.refresh_failures,
        last_error: safeCode(r.last_error),
        scopes: r.scopes ? r.scopes.split(' ').length : 0,
      };
      if (checkDecrypt) line.decrypt = key ? (decryptResult.get(r.portal_id) ? 'ok' : 'cannot decrypt') : 'no valid key';
      return line;
    })
  );

  if (reauth > 0) console.log('Accounts needing re-authorization must be connected again at /oauth/install.');
  if (checkDecrypt && problems > 0) {
    console.log('Decrypt check FAILED: the configured key does not match the stored tokens (or no valid key is set).');
    return 1;
  }
  return 0;
}

let exitCode;
try {
  exitCode = main();
} catch {
  console.log('Could not complete the status check.');
  exitCode = 2;
}
process.exitCode = exitCode;
