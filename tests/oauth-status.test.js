// tests/oauth-status.test.js
//
// Tests scripts/oauth-status.js (Phase 3, step 6) and the package.json wiring.
// The script is run as a child process against TEMPORARY databases with FAKE tokens
// and an explicit environment (the key is always set explicitly, even to "", so a
// real .env can never influence a test). Nothing here touches HubSpot.
//
// Run with:  node --test tests/oauth-status.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createTokenStore } = require('../src/oauth/tokenStore');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'oauth-status.js');
const ACCESS = 'fake-access-token-AAAA-1111';
const REFRESH = 'fake-refresh-token-RRRR-2222';
const MIN = 60 * 1000;

const newKey = () => crypto.randomBytes(32);
const tmpName = (label) => path.join(os.tmpdir(), `${label}-${crypto.randomBytes(6).toString('hex')}`);
const removeDb = (p) => ['', '-wal', '-shm'].forEach((s) => fs.rmSync(p + s, { force: true }));
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function run({ dbPath, keyValue, args = [] }) {
  const env = { ...process.env, OAUTH_TOKEN_DB_PATH: dbPath, TOKEN_ENCRYPTION_KEY: keyValue ?? '' };
  const out = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  return { status: out.status, stdout: out.stdout, stderr: out.stderr, all: `${out.stdout}\n${out.stderr}` };
}

// A database with three portals: active, access token expired, needs re-authorization.
function makeDb(key) {
  const dbPath = `${tmpName('oauth-status')}.db`;
  const store = createTokenStore(dbPath, { key });
  store.save({ portalId: 111, accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 30 * MIN, scopes: ['oauth', 'crm.objects.contacts.read'] });
  store.save({ portalId: 222, accessToken: `${ACCESS}-222`, refreshToken: `${REFRESH}-222`, expiresAt: Date.now() - 10 * MIN });
  store.save({ portalId: 333, accessToken: `${ACCESS}-333`, refreshToken: `${REFRESH}-333`, expiresAt: Date.now() + 30 * MIN });
  store.markNeedsReauth(333, 'INVALID_GRANT');
  store.close();
  return dbPath;
}

function assertNoLeaks(output, key, dbPath, extra = []) {
  const secrets = [ACCESS, REFRESH, key && key.toString('base64'), key && key.toString('hex'), 'v1.', 'access_token_enc', 'refresh_token_enc', 'SELECT', 'sqlite', 'SQLITE', path.basename(dbPath), os.tmpdir(), ...extra].filter(Boolean);
  for (const secret of secrets) assert.ok(!output.includes(secret), `output leaked "${secret}"`);
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

test('no database: reports "not connected" and does not create anything', () => {
  const dbPath = `${tmpName('oauth-none')}.db`;
  const r = run({ dbPath, keyValue: newKey().toString('base64') });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Token database: not found/);
  assert.match(r.stdout, /No HubSpot account is connected\./);
  assert.equal(fs.existsSync(dbPath), false, 'a status check must never create the database');
  assertNoLeaks(r.all, null, dbPath);
});

test('an empty database reports that nothing is connected', () => {
  const dbPath = `${tmpName('oauth-empty')}.db`;
  createTokenStore(dbPath, { key: newKey() }).close();
  try {
    const r = run({ dbPath, keyValue: newKey().toString('base64') });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Token database: found/);
    assert.match(r.stdout, /No HubSpot account is connected\./);
  } finally {
    removeDb(dbPath);
  }
});

test('connected accounts: portal, status, expiry and counts are shown', () => {
  const key = newKey();
  const dbPath = makeDb(key);
  try {
    const r = run({ dbPath, keyValue: key.toString('base64') });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Encryption key \(TOKEN_ENCRYPTION_KEY\): configured/);
    assert.match(r.stdout, /Token database: found/);
    assert.match(r.stdout, /3 HubSpot account\(s\) connected \(2 active, 1 need re-authorization\)/);
    for (const portal of ['111', '222', '333']) assert.match(r.stdout, new RegExp(`'${portal}'`));
    assert.match(r.stdout, /expires in (29|30) min/);
    assert.match(r.stdout, /expired (9|10) min ago/);
    assert.match(r.stdout, /needs re-authorization/);
    assert.match(r.stdout, /INVALID_GRANT/);
    assert.match(r.stdout, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/); // ISO expiry time
    assert.match(r.stdout, /\/oauth\/install/);
    assertNoLeaks(r.all, key, dbPath);
  } finally {
    removeDb(dbPath);
  }
});

test('the encryption key state is reported as configured / missing / invalid (never its value)', () => {
  const key = newKey();
  const dbPath = makeDb(key);
  try {
    const states = [
      [key.toString('base64'), 'configured'],
      ['', 'missing'],
      ['too-short', 'invalid'],
      [crypto.randomBytes(16).toString('base64'), 'invalid'],
    ];
    for (const [value, expected] of states) {
      const r = run({ dbPath, keyValue: value });
      assert.equal(r.status, 0);
      assert.match(r.stdout, new RegExp(`TOKEN_ENCRYPTION_KEY\\): ${expected}`));
      assert.ok(!r.all.includes(value) || value === '', 'the key value must never be printed');
    }
  } finally {
    removeDb(dbPath);
  }
});

test('a custom database location is announced without printing the path', () => {
  const dbPath = `${tmpName('oauth-custom')}.db`;
  const r = run({ dbPath, keyValue: '' });
  assert.match(r.stdout, /Token database location: custom \(OAUTH_TOKEN_DB_PATH\)/);
  assertNoLeaks(r.all, null, dbPath);
});

// ---------------------------------------------------------------------------
// --check-decrypt
// ---------------------------------------------------------------------------

test('--check-decrypt: the right key reports ok for every account and prints no secrets', () => {
  const key = newKey();
  const dbPath = makeDb(key);
  try {
    const r = run({ dbPath, keyValue: key.toString('base64'), args: ['--check-decrypt'] });
    assert.equal(r.status, 0);
    assert.equal((r.stdout.match(/'ok'/g) || []).length, 3);
    assert.doesNotMatch(r.stdout, /cannot decrypt/);
    assertNoLeaks(r.all, key, dbPath);
  } finally {
    removeDb(dbPath);
  }
});

test('--check-decrypt: a wrong key is detected (exit 1) without leaking anything', () => {
  const key = newKey();
  const wrong = newKey();
  const dbPath = makeDb(key);
  try {
    const r = run({ dbPath, keyValue: wrong.toString('base64'), args: ['--check-decrypt'] });
    assert.equal(r.status, 1);
    assert.equal((r.stdout.match(/cannot decrypt/g) || []).length, 3);
    assert.match(r.stdout, /Decrypt check FAILED/);
    assertNoLeaks(r.all, key, dbPath, [wrong.toString('base64')]);
  } finally {
    removeDb(dbPath);
  }
});

test('--check-decrypt: a missing or invalid key is reported safely (exit 1)', () => {
  const key = newKey();
  const dbPath = makeDb(key);
  try {
    for (const value of ['', 'not-a-valid-key']) {
      const r = run({ dbPath, keyValue: value, args: ['--check-decrypt'] });
      assert.equal(r.status, 1);
      assert.match(r.stdout, /no valid key/);
      assertNoLeaks(r.all, key, dbPath);
    }
    // Without the flag, a missing key is only a report line (exit 0).
    assert.equal(run({ dbPath, keyValue: '' }).status, 0);
  } finally {
    removeDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// Read-only and safe failures
// ---------------------------------------------------------------------------

test('the script never changes the database', () => {
  const key = newKey();
  const dbPath = makeDb(key);
  try {
    // Baseline AFTER the store has been opened and closed once (that is the store's own business).
    const store = createTokenStore(dbPath, { key });
    const rowsBefore = JSON.stringify(store.list());
    store.close();
    const before = { hash: sha(dbPath), size: fs.statSync(dbPath).size };

    run({ dbPath, keyValue: key.toString('base64') });
    run({ dbPath, keyValue: key.toString('base64'), args: ['--check-decrypt'] });
    run({ dbPath, keyValue: '' });

    assert.equal(sha(dbPath), before.hash);
    assert.equal(fs.statSync(dbPath).size, before.size);
    const again = createTokenStore(dbPath, { key });
    assert.equal(JSON.stringify(again.list()), rowsBefore);
    assert.equal(again.get(111).rowVersion, 1);
    again.close();
  } finally {
    removeDb(dbPath);
  }
});

test('an unreadable database gives a generic message and exit code 2 (no path, no SQLite text)', () => {
  const dir = fs.mkdtempSync(tmpName('oauth-dir-'));
  const garbage = `${tmpName('oauth-garbage')}.db`;
  fs.writeFileSync(garbage, 'this is definitely not a SQLite database '.repeat(50));
  try {
    for (const target of [dir, garbage]) {
      const r = run({ dbPath: target, keyValue: newKey().toString('base64') });
      assert.equal(r.status, 2);
      assert.match(r.stdout, /Token database: could not be read/);
      assertNoLeaks(r.all, null, target, [path.basename(dir)]);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(garbage, { force: true });
  }
});

test('a database without the expected table is reported as unreadable, not repaired', () => {
  const dbPath = `${tmpName('oauth-notable')}.db`;
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec('CREATE TABLE something_else (a INTEGER)');
  raw.close();
  try {
    const before = sha(dbPath);
    const r = run({ dbPath, keyValue: '' });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /could not be read/);
    assertNoLeaks(r.all, null, dbPath, ['oauth_connections', 'no such table']);
    assert.equal(sha(dbPath), before);
  } finally {
    removeDb(dbPath);
  }
});

test('unknown arguments print usage and exit with code 2', () => {
  const r = run({ dbPath: `${tmpName('oauth-args')}.db`, keyValue: '', args: ['--delete-everything'] });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Usage: npm run oauth:status/);
});

// ---------------------------------------------------------------------------
// package.json wiring
// ---------------------------------------------------------------------------

test('package.json: npm test runs every file in tests/ and oauth:status is registered', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.test, 'node --test "tests/*.test.js"');
  assert.equal(pkg.scripts['oauth:status'], 'node scripts/oauth-status.js');
  assert.equal(pkg.scripts['events:failed'], 'node scripts/list-failed-events.js'); // unchanged

  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js'));
  for (const expected of [
    'webhook-events.test.js',
    'webhook-signature.test.js',
    'security.test.js',
    'idempotency.test.js',
    'error-handling.test.js',
    'token-crypto.test.js',
    'token-store.test.js',
    'hubspot-token-client.test.js',
    'token-service.test.js',
    'oauth-callback.test.js',
    'oauth-status.test.js',
  ]) {
    assert.ok(files.includes(expected), `${expected} must exist so that the glob picks it up`);
  }
});

test('.env.example documents the new settings with empty/commented values only', () => {
  const text = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  assert.match(text, /^TOKEN_ENCRYPTION_KEY=$/m);
  assert.match(text, /^# OAUTH_TOKEN_DB_PATH=data\/oauth-tokens\.db$/m);
  assert.doesNotMatch(text, /^TOKEN_ENCRYPTION_KEY=\S/m);
});
