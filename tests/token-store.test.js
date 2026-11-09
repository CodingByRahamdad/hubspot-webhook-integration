// tests/token-store.test.js
//
// Tests src/oauth/tokenStore.js (Phase 3, step 2).
// Only fake tokens, random in-test keys and in-memory / temporary databases are
// used. The real data/ folder, the environment and .env are never touched.
//
// Run with:  node --test tests/token-store.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const { createTokenStore, TokenStoreError, DEFAULT_DB_PATH } = require('../src/oauth/tokenStore');
const { TokenCryptoError, KEY_ENV_VAR } = require('../src/security/tokenCrypto');

const newKey = () => crypto.randomBytes(32);
const ACCESS = 'fake-access-token-AAAA-1111';
const REFRESH = 'fake-refresh-token-RRRR-2222';
const SOON = Date.now() + 30 * 60 * 1000;

const tmpDb = (label) => path.join(os.tmpdir(), `${label}-${crypto.randomBytes(6).toString('hex')}.db`);
const removeDb = (p) => ['', '-wal', '-shm'].forEach((s) => fs.rmSync(p + s, { force: true }));

const connection = (extra = {}) => ({
  portalId: 12345,
  accessToken: ACCESS,
  refreshToken: REFRESH,
  expiresAt: SOON,
  scopes: ['oauth', 'crm.objects.contacts.read'],
  ...extra,
});

function captureConsole(run) {
  const names = ['log', 'info', 'warn', 'error', 'debug'];
  const orig = {};
  const lines = [];
  for (const n of names) {
    orig[n] = console[n];
    console[n] = (...a) => lines.push(a.join(' '));
  }
  try {
    run();
  } finally {
    for (const n of names) console[n] = orig[n];
  }
  return lines;
}

function assertStoreError(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof TokenStoreError, 'must be a TokenStoreError');
    assert.equal(err.code, code);
    return true;
  });
}

// Reads the raw table through a SEPARATE connection (what an attacker with the file sees).
function rawRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT * FROM oauth_connections ORDER BY portal_id').all();
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Creating and reading
// ---------------------------------------------------------------------------

test('the default database is a separate file from the webhook event database', () => {
  assert.equal(DEFAULT_DB_PATH, path.join('data', 'oauth-tokens.db'));
  assert.notEqual(path.basename(DEFAULT_DB_PATH), 'webhook-events.db');
});

test('a new connection can be saved and read back (tokens decrypted)', () => {
  let clock = 1_000_000;
  const store = createTokenStore(':memory:', { key: newKey(), now: () => clock });
  const saved = store.save(connection());
  assert.deepEqual(saved, { portalId: '12345', rowVersion: 1 });

  const c = store.get(12345);
  assert.equal(c.portalId, '12345');
  assert.equal(c.accessToken, ACCESS);
  assert.equal(c.refreshToken, REFRESH);
  assert.equal(c.accessExpiresAt, SOON);
  assert.deepEqual(c.scopes, ['oauth', 'crm.objects.contacts.read']);
  assert.equal(c.status, 'active');
  assert.equal(c.refreshFailures, 0);
  assert.equal(c.lastRefreshAt, null);
  assert.equal(c.lastError, null);
  assert.equal(c.connectedAt, 1_000_000);
  assert.equal(c.updatedAt, 1_000_000);
  assert.equal(c.rowVersion, 1);
  store.close();
});

test('an unknown portal returns null', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  assert.equal(store.get(999), null);
  assert.equal(store.getStatus(999), null);
  store.close();
});

test('scopes may be given as a space-separated string or left out', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  store.save(connection({ portalId: 1, scopes: 'oauth crm.objects.contacts.read' }));
  store.save(connection({ portalId: 2, scopes: undefined }));
  assert.deepEqual(store.get(1).scopes, ['oauth', 'crm.objects.contacts.read']);
  assert.deepEqual(store.get(2).scopes, []);
  store.close();
});

test('saving again for the same portal replaces the tokens and bumps the version', () => {
  let clock = 1000;
  const store = createTokenStore(':memory:', { key: newKey(), now: () => clock });
  store.save(connection());
  clock = 5000;
  const again = store.save(connection({ accessToken: 'fake-access-2', refreshToken: 'fake-refresh-2' }));
  assert.equal(again.rowVersion, 2);
  const c = store.get(12345);
  assert.equal(c.accessToken, 'fake-access-2');
  assert.equal(c.refreshToken, 'fake-refresh-2');
  assert.equal(c.connectedAt, 5000);
  assert.equal(store.list().length, 1);
  store.close();
});

test('several portals are stored independently; "123" and 123 are the same portal', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  store.save(connection({ portalId: 111, accessToken: 'access-111', refreshToken: 'refresh-111' }));
  store.save(connection({ portalId: 222, accessToken: 'access-222', refreshToken: 'refresh-222' }));
  store.save(connection({ portalId: '333', accessToken: 'access-333', refreshToken: 'refresh-333' }));

  assert.equal(store.get(111).accessToken, 'access-111');
  assert.equal(store.get('222').refreshToken, 'refresh-222');
  assert.equal(store.get(333).accessToken, 'access-333');
  assert.deepEqual(store.list().map((c) => c.portalId), ['111', '222', '333']);

  // Changing one portal never touches another.
  const v = store.get(111).rowVersion;
  assert.equal(store.update(111, v, { accessToken: 'access-111b', expiresAt: SOON }).updated, true);
  assert.equal(store.get(222).accessToken, 'access-222');
  assert.equal(store.get(222).rowVersion, 1);
  store.close();
});

// ---------------------------------------------------------------------------
// Updating: atomic, with version checks
// ---------------------------------------------------------------------------

test('update stores new tokens, bumps the version and keeps the refresh token when none is given', () => {
  let clock = 1000;
  const store = createTokenStore(':memory:', { key: newKey(), now: () => clock });
  store.save(connection({ scopes: 'oauth a b' }));
  clock = 9000;
  const result = store.update(12345, 1, { accessToken: 'fake-access-new', expiresAt: SOON + 1000 });
  assert.deepEqual(result, { updated: true, rowVersion: 2 });

  const c = store.get(12345);
  assert.equal(c.accessToken, 'fake-access-new');
  assert.equal(c.refreshToken, REFRESH); // kept
  assert.deepEqual(c.scopes, ['oauth', 'a', 'b']); // kept
  assert.equal(c.accessExpiresAt, SOON + 1000);
  assert.equal(c.lastRefreshAt, 9000);
  assert.equal(c.updatedAt, 9000);
  assert.equal(c.connectedAt, 1000); // unchanged
  assert.equal(c.rowVersion, 2);
  store.close();
});

test('update replaces the refresh token when HubSpot returned a new one (rotation)', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  store.save(connection());
  store.update(12345, 1, { accessToken: 'fake-access-new', refreshToken: 'fake-refresh-rotated', expiresAt: SOON });
  assert.equal(store.get(12345).refreshToken, 'fake-refresh-rotated');
  store.close();
});

test('a stale update (old version) is refused and changes nothing', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  store.save(connection());
  assert.equal(store.update(12345, 1, { accessToken: 'winner', expiresAt: SOON }).updated, true);

  const stale = store.update(12345, 1, { accessToken: 'loser', refreshToken: 'loser-refresh', expiresAt: SOON });
  assert.deepEqual(stale, { updated: false });
  const c = store.get(12345);
  assert.equal(c.accessToken, 'winner');
  assert.equal(c.refreshToken, REFRESH);
  assert.equal(c.rowVersion, 2);

  // Wrong future version and unknown portal are refused too.
  assert.equal(store.update(12345, 99, { accessToken: 'x', expiresAt: SOON }).updated, false);
  assert.equal(store.update(777, 1, { accessToken: 'x', expiresAt: SOON }).updated, false);
  store.close();
});

test('two connections to the same file: only the first of two racing updates wins', () => {
  const dbPath = tmpDb('tok-race');
  const key = newKey();
  const a = createTokenStore(dbPath, { key });
  const b = createTokenStore(dbPath, { key });
  try {
    a.save(connection());
    const seenByA = a.get(12345).rowVersion;
    const seenByB = b.get(12345).rowVersion;
    assert.equal(seenByA, seenByB);

    assert.equal(a.update(12345, seenByA, { accessToken: 'from-a', expiresAt: SOON }).updated, true);
    assert.equal(b.update(12345, seenByB, { accessToken: 'from-b', expiresAt: SOON }).updated, false);
    assert.equal(b.get(12345).accessToken, 'from-a');
  } finally {
    a.close();
    b.close();
    removeDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// Re-authorization status
// ---------------------------------------------------------------------------

test('markNeedsReauth sets the status, keeps the tokens and records only a short code', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  store.save(connection());
  const r = store.markNeedsReauth(12345, 'invalid_grant');
  assert.deepEqual(r, { updated: true, rowVersion: 2 });

  const s = store.getStatus(12345);
  assert.equal(s.status, 'needs_reauth');
  assert.equal(s.lastError, 'invalid_grant');
  assert.equal(store.get(12345).accessToken, ACCESS); // not deleted
  store.close();
});

test('markNeedsReauth rejects unsafe error text and unknown portals', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  store.save(connection());
  store.markNeedsReauth(12345, `Bad refresh token ${REFRESH} for user a@b.c`);
  assert.equal(store.getStatus(12345).lastError, 'unknown');
  store.markNeedsReauth(12345, undefined);
  assert.equal(store.getStatus(12345).lastError, 'unknown');
  assert.deepEqual(store.markNeedsReauth(404, 'invalid_grant'), { updated: false });
  store.close();
});

test('markNeedsReauth with a version only applies when the version still matches', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  store.save(connection());
  store.update(12345, 1, { accessToken: 'newer', expiresAt: SOON }); // now version 2
  assert.deepEqual(store.markNeedsReauth(12345, 'invalid_grant', 1), { updated: false });
  assert.equal(store.getStatus(12345).status, 'active');
  assert.deepEqual(store.markNeedsReauth(12345, 'invalid_grant', 2), { updated: true, rowVersion: 3 });
  store.close();
});

test('after markNeedsReauth a stale refresh cannot bring the connection back; a new save does', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  store.save(connection());
  const seenByRefresh = store.get(12345).rowVersion; // a slow refresh starts here
  store.markNeedsReauth(12345, 'invalid_grant');
  assert.equal(store.update(12345, seenByRefresh, { accessToken: 'late', expiresAt: SOON }).updated, false);
  assert.equal(store.getStatus(12345).status, 'needs_reauth');

  store.save(connection({ accessToken: 'reauthorized', refreshToken: 'fresh-refresh' }));
  const s = store.getStatus(12345);
  assert.equal(s.status, 'active');
  assert.equal(s.lastError, null);
  assert.equal(s.refreshFailures, 0);
  assert.equal(store.get(12345).accessToken, 'reauthorized');
  store.close();
});

// ---------------------------------------------------------------------------
// Encrypted persistence
// ---------------------------------------------------------------------------

test('no plaintext token is stored: not in the columns and not in the database files', () => {
  const dbPath = tmpDb('tok-plain');
  const key = newKey();
  const store = createTokenStore(dbPath, { key });
  try {
    store.save(connection());
    store.update(12345, 1, { accessToken: 'fake-access-NEW-9999', refreshToken: 'fake-refresh-NEW-8888', expiresAt: SOON });

    const rows = rawRows(dbPath);
    assert.equal(rows.length, 1);
    const stored = JSON.stringify(rows);
    const plaintexts = [ACCESS, REFRESH, 'fake-access-NEW-9999', 'fake-refresh-NEW-8888'];
    for (const p of plaintexts) assert.ok(!stored.includes(p), 'plaintext found in a column');
    assert.match(rows[0].access_token_enc, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.match(rows[0].refresh_token_enc, /^v1\./);

    // Raw bytes of the main file and the write-ahead log / shared memory files.
    for (const suffix of ['', '-wal', '-shm']) {
      if (!fs.existsSync(dbPath + suffix)) continue;
      const bytes = fs.readFileSync(dbPath + suffix);
      for (const p of plaintexts) assert.ok(!bytes.includes(Buffer.from(p)), `plaintext found in ${suffix || 'db file'}`);
      assert.ok(!bytes.includes(key), 'key found in file');
      assert.ok(!bytes.includes(Buffer.from(key.toString('base64'))), 'key found in file');
    }
  } finally {
    store.close();
    removeDb(dbPath);
  }
});

test('tokens survive closing and reopening the database file', () => {
  const dbPath = tmpDb('tok-persist');
  const key = newKey();
  try {
    const first = createTokenStore(dbPath, { key });
    first.save(connection());
    first.close();

    const second = createTokenStore(dbPath, { key });
    const c = second.get(12345);
    assert.equal(c.accessToken, ACCESS);
    assert.equal(c.refreshToken, REFRESH);
    second.close();
  } finally {
    removeDb(dbPath);
  }
});

test('the same token saved twice is stored with different ciphertext', () => {
  const dbPath = tmpDb('tok-iv');
  const store = createTokenStore(dbPath, { key: newKey() });
  try {
    store.save(connection());
    const first = rawRows(dbPath)[0].access_token_enc;
    store.save(connection());
    const second = rawRows(dbPath)[0].access_token_enc;
    assert.notEqual(first, second);
  } finally {
    store.close();
    removeDb(dbPath);
  }
});

test('reading with the wrong key fails securely', () => {
  const dbPath = tmpDb('tok-wrongkey');
  const writer = createTokenStore(dbPath, { key: newKey() });
  const reader = createTokenStore(dbPath, { key: newKey() });
  try {
    writer.save(connection());
    assert.throws(() => reader.get(12345), (err) => err instanceof TokenCryptoError && err.code === 'DECRYPT_FAILED');
    assert.equal(reader.getStatus(12345).status, 'active'); // metadata needs no key
  } finally {
    writer.close();
    reader.close();
    removeDb(dbPath);
  }
});

test('ciphertext copied to another portal row cannot be decrypted (bound to portal)', () => {
  const dbPath = tmpDb('tok-bound');
  const key = newKey();
  const store = createTokenStore(dbPath, { key });
  try {
    store.save(connection({ portalId: 111, accessToken: 'access-111', refreshToken: 'refresh-111' }));
    store.save(connection({ portalId: 222, accessToken: 'access-222', refreshToken: 'refresh-222' }));
    const raw = new DatabaseSync(dbPath);
    raw.prepare('UPDATE oauth_connections SET access_token_enc = (SELECT access_token_enc FROM oauth_connections WHERE portal_id = ?) WHERE portal_id = ?').run('111', '222');
    raw.close();
    assert.throws(() => store.get(222), (err) => err instanceof TokenCryptoError && err.code === 'DECRYPT_FAILED');
    assert.equal(store.get(111).accessToken, 'access-111');
  } finally {
    store.close();
    removeDb(dbPath);
  }
});

test('a corrupted ciphertext in the database fails securely and leaks nothing', () => {
  const dbPath = tmpDb('tok-corrupt');
  const store = createTokenStore(dbPath, { key: newKey() });
  try {
    store.save(connection());
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE oauth_connections SET refresh_token_enc = 'garbage' WHERE portal_id = ?").run('12345');
    raw.close();
    assert.throws(() => store.get(12345), (err) => {
      assert.ok(err instanceof TokenCryptoError);
      assert.ok(!`${err.message}${err.stack}`.includes('garbage'));
      return true;
    });
  } finally {
    store.close();
    removeDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// Failing securely
// ---------------------------------------------------------------------------

test('a missing or invalid encryption key fails closed and stores nothing', () => {
  const saved = process.env[KEY_ENV_VAR];
  const dbPath = tmpDb('tok-nokey');
  try {
    delete process.env[KEY_ENV_VAR];
    const store = createTokenStore(dbPath); // opening does not need the key
    assert.throws(() => store.save(connection()), (err) => err instanceof TokenCryptoError && err.code === 'KEY_MISSING');
    assert.equal(rawRows(dbPath).length, 0);

    process.env[KEY_ENV_VAR] = 'too-short';
    assert.throws(() => store.save(connection()), (err) => err instanceof TokenCryptoError && err.code === 'KEY_INVALID');
    assert.equal(rawRows(dbPath).length, 0);

    process.env[KEY_ENV_VAR] = newKey().toString('base64'); // key read from the environment
    store.save(connection());
    assert.equal(store.get(12345).accessToken, ACCESS);
    store.close();
  } finally {
    if (saved === undefined) delete process.env[KEY_ENV_VAR];
    else process.env[KEY_ENV_VAR] = saved;
    removeDb(dbPath);
  }
});

test('invalid input is rejected before anything is written', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  for (const portalId of [undefined, null, '', 0, -1, 1.5, {}, 'x'.repeat(65)]) {
    assertStoreError(() => store.save(connection({ portalId })), 'INVALID_INPUT');
    assertStoreError(() => store.get(portalId), 'INVALID_INPUT');
  }
  for (const expiresAt of [undefined, 0, -5, 1.5, '123', NaN]) {
    assertStoreError(() => store.save(connection({ expiresAt })), 'INVALID_INPUT');
  }
  for (const scopes of [123, { a: 1 }, ['ok', 5], ['has space inside']]) {
    assertStoreError(() => store.save(connection({ scopes })), 'INVALID_INPUT');
  }
  for (const bad of ['', undefined, null, 42]) {
    assert.throws(() => store.save(connection({ accessToken: bad })), TokenCryptoError);
    assert.throws(() => store.save(connection({ refreshToken: bad })), TokenCryptoError);
  }
  assert.equal(store.list().length, 0);

  store.save(connection());
  for (const version of [undefined, 0, -1, 1.5, '1']) {
    assertStoreError(() => store.update(12345, version, { accessToken: 'x', expiresAt: SOON }), 'INVALID_INPUT');
  }
  assertStoreError(() => store.update(12345, 1, { accessToken: 'x', expiresAt: 0 }), 'INVALID_INPUT');
  store.close();
});

test('a database that cannot be opened gives a generic error without paths or SQL details', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tok-dir-'));
  try {
    // A directory cannot be opened as a database file.
    assert.throws(() => createTokenStore(dir, { key: newKey() }), (err) => {
      assert.ok(err instanceof TokenStoreError);
      assert.equal(err.code, 'DB_OPEN_FAILED');
      assert.ok(!`${err.message}${err.stack}`.includes(dir));
      return true;
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a database created by a newer schema version is refused', () => {
  const dbPath = tmpDb('tok-newer');
  const raw = new DatabaseSync(dbPath);
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  try {
    assertStoreError(() => createTokenStore(dbPath, { key: newKey() }), 'DB_OPEN_FAILED');
  } finally {
    removeDb(dbPath);
  }
});

test('opening an existing database is safe and keeps its rows', () => {
  const dbPath = tmpDb('tok-reopen');
  const key = newKey();
  try {
    const a = createTokenStore(dbPath, { key });
    a.save(connection());
    a.close();
    const b = createTokenStore(dbPath, { key }); // schema creation is idempotent
    const c = createTokenStore(dbPath, { key });
    assert.equal(b.list().length, 1);
    assert.equal(c.get(12345).accessToken, ACCESS);
    b.close();
    c.close();
  } finally {
    removeDb(dbPath);
  }
});

test('database failures give a generic error (no SQL, no raw message, no secrets)', () => {
  const dbPath = tmpDb('tok-dbfail');
  const store = createTokenStore(dbPath, { key: newKey() });
  try {
    store.save(connection());
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TABLE oauth_connections'); // sabotage from outside
    raw.close();

    const operations = [
      () => store.save(connection()),
      () => store.get(12345),
      () => store.getStatus(12345),
      () => store.list(),
      () => store.update(12345, 1, { accessToken: 'x-secret-token', expiresAt: SOON }),
      () => store.markNeedsReauth(12345, 'invalid_grant'),
    ];
    for (const run of operations) {
      assert.throws(run, (err) => {
        assert.ok(err instanceof TokenStoreError);
        assert.equal(err.code, 'DB_ERROR');
        const text = [err.message, err.stack, JSON.stringify(err), String(err)].join('\n');
        for (const leak of ['oauth_connections', 'no such table', 'SELECT', 'UPDATE', 'INSERT', ACCESS, REFRESH, 'x-secret-token']) {
          assert.ok(!text.includes(leak), `error text leaked "${leak}"`);
        }
        return true;
      });
    }
  } finally {
    store.close();
    removeDb(dbPath);
  }
});

test('using a closed store fails with a generic error', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  store.close();
  assertStoreError(() => store.get(1), 'DB_ERROR');
  assertStoreError(() => store.save(connection()), 'DB_ERROR');
  assertStoreError(() => store.close(), 'DB_ERROR');
});

test('metadata views contain no tokens and no ciphertext', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  store.save(connection());
  const text = JSON.stringify([store.getStatus(12345), store.list()]);
  assert.ok(!text.includes(ACCESS));
  assert.ok(!text.includes(REFRESH));
  assert.ok(!text.includes('v1.'));
  assert.ok(!('accessToken' in store.getStatus(12345)));
  store.close();
});

test('the store never writes to the console', () => {
  const key = newKey();
  const lines = captureConsole(() => {
    const store = createTokenStore(':memory:', { key });
    store.save(connection());
    store.get(12345);
    store.update(12345, 1, { accessToken: 'n', expiresAt: SOON });
    store.update(12345, 1, { accessToken: 'stale', expiresAt: SOON });
    store.markNeedsReauth(12345, 'invalid_grant');
    for (const run of [() => store.get(''), () => store.save(connection({ expiresAt: -1 }))]) {
      try {
        run();
      } catch {
        // expected
      }
    }
    store.close();
    try {
      store.get(12345);
    } catch {
      // expected
    }
  });
  assert.deepEqual(lines, []);
});
