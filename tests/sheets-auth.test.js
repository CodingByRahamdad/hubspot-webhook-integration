// tests/sheets-auth.test.js
//
// Tests src/google/sheetsAuth.js (Phase 2, step 4).
// The REAL Google credentials are never used or read, and no request is made to Google.
// Key files are written to a temporary folder using a throw-away RSA key generated inside
// the test, and the Google JWT client is replaced by a fake (one test builds the real
// class, which makes no network request until a token is needed). .env is never read:
// the environment is passed in as a plain object.
//
// Run with:  node --test tests/sheets-auth.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  KEY_FILE_ENV_VAR,
  SHEETS_SCOPE,
  loadServiceAccountCredentials,
  createSheetsAuth,
  authenticate,
  getSheetsAuth,
  resetSheetsAuth,
} = require('../src/google/sheetsAuth');
const { GoogleSheetsError } = require('../src/google/sheetsErrors');

const FAKE_EMAIL = 'fake-sa@fake-project.iam.gserviceaccount.com';
const { privateKey: FAKE_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
// A distinctive piece of the fake key, used to prove it never shows up in errors or logs.
const KEY_FRAGMENT = FAKE_PEM.split('\n')[2];

const goodKey = (extra = {}) => ({
  type: 'service_account',
  project_id: 'fake-project',
  private_key_id: 'fake-key-id',
  private_key: FAKE_PEM,
  client_email: FAKE_EMAIL,
  client_id: '1234567890',
  token_uri: 'https://oauth2.googleapis.com/token',
  ...extra,
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheets-auth-test-'));
test.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

let counter = 0;
function writeKeyFile(content) {
  counter += 1;
  const file = path.join(tmpDir, `fake-key-${counter}.json`);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}
const envFor = (file) => ({ [KEY_FILE_ENV_VAR]: file });

// The error must not contain the key, the email, the file path or the temp folder.
function assertNoSecrets(err) {
  const text = [err.message, err.stack || '', JSON.stringify(err), String(err.reason)].join('\n');
  assert.ok(!text.includes(KEY_FRAGMENT), 'error must not contain key material');
  assert.ok(!text.includes('PRIVATE KEY'), 'error must not contain PEM text');
  assert.ok(!text.includes(FAKE_EMAIL), 'error must not contain the service-account email');
  assert.ok(!text.includes(tmpDir), 'error must not contain the file path');
}

function assertCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof GoogleSheetsError, 'must be a GoogleSheetsError');
    assert.equal(err.name, 'GoogleSheetsError');
    assert.equal(err.code, code);
    assertNoSecrets(err);
    return true;
  });
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof GoogleSheetsError, 'must be a GoogleSheetsError');
    assert.equal(err.code, code);
    assertNoSecrets(err);
    return true;
  });
}

// Records console output so tests can prove nothing is ever logged.
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

// A stand-in for the Google JWT client that only remembers how it was created.
function makeFakeJwt({ authorizeImpl } = {}) {
  const calls = [];
  class FakeJwt {
    constructor(options) {
      this.options = options;
      calls.push(options);
    }
    async authorize() {
      if (authorizeImpl) return authorizeImpl();
      return { access_token: 'fake-access-token-must-not-be-returned' };
    }
  }
  return { FakeJwt, calls };
}

// --- configuration -----------------------------------------------------------------

test('missing environment variable -> CONFIG_MISSING', () => {
  assertCode(() => loadServiceAccountCredentials({ env: {} }), 'CONFIG_MISSING');
  assertCode(() => loadServiceAccountCredentials({ env: undefined }), 'CONFIG_MISSING');
});

test('empty or blank environment variable -> CONFIG_MISSING', () => {
  assertCode(() => loadServiceAccountCredentials({ env: { [KEY_FILE_ENV_VAR]: '' } }), 'CONFIG_MISSING');
  assertCode(() => loadServiceAccountCredentials({ env: { [KEY_FILE_ENV_VAR]: '   ' } }), 'CONFIG_MISSING');
});

test('the variable name and the scope are exactly the agreed ones', () => {
  assert.equal(KEY_FILE_ENV_VAR, 'GOOGLE_SERVICE_ACCOUNT_KEY_FILE');
  assert.equal(SHEETS_SCOPE, 'https://www.googleapis.com/auth/spreadsheets');
});

// --- the key file ------------------------------------------------------------------

test('file does not exist -> CREDENTIALS_FILE_NOT_FOUND', () => {
  const missing = path.join(tmpDir, 'does-not-exist.json');
  assertCode(() => loadServiceAccountCredentials({ env: envFor(missing) }), 'CREDENTIALS_FILE_NOT_FOUND');
});

test('path is a folder -> CREDENTIALS_FILE_UNREADABLE', () => {
  assertCode(() => loadServiceAccountCredentials({ env: envFor(tmpDir) }), 'CREDENTIALS_FILE_UNREADABLE');
});

test('file larger than the limit -> CREDENTIALS_FILE_UNREADABLE (it is not even parsed)', () => {
  const big = writeKeyFile(JSON.stringify(goodKey({ padding: 'x'.repeat(70 * 1024) })));
  assertCode(() => loadServiceAccountCredentials({ env: envFor(big) }), 'CREDENTIALS_FILE_UNREADABLE');
});

test('read error from the file system -> CREDENTIALS_FILE_UNREADABLE with a safe reason code', () => {
  const fakeFs = {
    statSync: () => ({ isFile: () => true, size: 100 }),
    readFileSync: () => {
      const e = new Error(`EACCES: permission denied, open '${tmpDir}/secret.json'`);
      e.code = 'EACCES';
      throw e;
    },
  };
  assert.throws(
    () => loadServiceAccountCredentials({ env: envFor('whatever.json'), fileSystem: fakeFs }),
    (err) => {
      assert.equal(err.code, 'CREDENTIALS_FILE_UNREADABLE');
      assert.equal(err.reason, 'EACCES');
      assertNoSecrets(err);
      return true;
    }
  );
});

test('invalid JSON -> CREDENTIALS_INVALID_JSON, and the file content is not quoted', () => {
  const file = writeKeyFile(`{"private_key": "${KEY_FRAGMENT}" this is not json`);
  assertCode(() => loadServiceAccountCredentials({ env: envFor(file) }), 'CREDENTIALS_INVALID_JSON');
});

test('empty file -> CREDENTIALS_INVALID_JSON', () => {
  assertCode(() => loadServiceAccountCredentials({ env: envFor(writeKeyFile('')) }), 'CREDENTIALS_INVALID_JSON');
});

test('valid JSON that is not an object -> CREDENTIALS_INVALID', () => {
  for (const content of ['null', '42', '"text"', '[]', '[1,2]']) {
    assertCode(() => loadServiceAccountCredentials({ env: envFor(writeKeyFile(content)) }), 'CREDENTIALS_INVALID');
  }
});

test('wrong structure -> CREDENTIALS_INVALID (type, email and private key are all required)', () => {
  const bad = [
    goodKey({ type: 'authorized_user' }),
    goodKey({ type: undefined }),
    goodKey({ client_email: undefined }),
    goodKey({ client_email: '' }),
    goodKey({ client_email: 'not-an-email' }),
    goodKey({ client_email: 12345 }),
    goodKey({ private_key: undefined }),
    goodKey({ private_key: '' }),
    goodKey({ private_key: 'not a pem key' }),
    goodKey({ private_key: '-----BEGIN PRIVATE KEY-----\nabc' }), // no END line
    goodKey({ private_key: ['array'] }),
  ];
  for (const content of bad) {
    assertCode(() => loadServiceAccountCredentials({ env: envFor(writeKeyFile(content)) }), 'CREDENTIALS_INVALID');
  }
});

test('a valid key file is accepted and its values are returned for internal use', () => {
  const file = writeKeyFile(goodKey());
  const creds = loadServiceAccountCredentials({ env: envFor(file) });
  assert.equal(creds.type, 'service_account');
  assert.equal(creds.client_email, FAKE_EMAIL);
  assert.equal(creds.private_key, FAKE_PEM);
});

// --- successful initialization with a fake JWT client -------------------------------

test('createSheetsAuth builds the JWT client with email, key and ONLY the Sheets scope', () => {
  const file = writeKeyFile(goodKey());
  const { FakeJwt, calls } = makeFakeJwt();

  const client = createSheetsAuth({ env: envFor(file), JWT: FakeJwt });

  assert.ok(client instanceof FakeJwt);
  assert.equal(calls.length, 1);
  const options = calls[0];
  assert.deepEqual(options.scopes, ['https://www.googleapis.com/auth/spreadsheets']);
  assert.equal(options.email, FAKE_EMAIL);
  assert.equal(options.key, FAKE_PEM);
  assert.equal(options.keyId, 'fake-key-id');
  assert.equal('keyFile' in options, false, 'the file is read once by us, not again by the library');
  assert.equal('credentials' in options, false, 'the deprecated credentials option is not used');
  assert.deepEqual(Object.keys(options).sort(), ['email', 'key', 'keyId', 'scopes']);
});

test('keyId is only passed when the key file has one', () => {
  const file = writeKeyFile(goodKey({ private_key_id: undefined }));
  const { FakeJwt, calls } = makeFakeJwt();
  createSheetsAuth({ env: envFor(file), JWT: FakeJwt });
  assert.deepEqual(Object.keys(calls[0]).sort(), ['email', 'key', 'scopes']);
});

test('createSheetsAuth passes configuration errors on unchanged', () => {
  const { FakeJwt, calls } = makeFakeJwt();
  assertCode(() => createSheetsAuth({ env: {}, JWT: FakeJwt }), 'CONFIG_MISSING');
  assertCode(
    () => createSheetsAuth({ env: envFor(path.join(tmpDir, 'nope.json')), JWT: FakeJwt }),
    'CREDENTIALS_FILE_NOT_FOUND'
  );
  assert.equal(calls.length, 0, 'the client must not be created when the key file is bad');
});

test('createSheetsAuth hides a failing client constructor behind INTERNAL_ERROR', () => {
  class ExplodingJwt {
    constructor(options) {
      throw new Error(`boom with ${options.key}`);
    }
  }
  const file = writeKeyFile(goodKey());
  assertCode(() => createSheetsAuth({ env: envFor(file), JWT: ExplodingJwt }), 'INTERNAL_ERROR');
});

test('the real Google JWT class accepts a valid fake key, makes no request and prints no warning', () => {
  const file = writeKeyFile(goodKey());
  let client;
  const lines = captureConsole(() => {
    client = createSheetsAuth({ env: envFor(file) }); // real @googleapis/sheets JWT
  });
  assert.equal(typeof client.authorize, 'function');
  assert.deepEqual(lines, [], 'no deprecation warning from the Google library');
});

// --- authentication errors ----------------------------------------------------------

test('authenticate resolves true on success and does NOT return the token', async () => {
  const { FakeJwt } = makeFakeJwt();
  assert.equal(await authenticate(new FakeJwt({})), true);
});

test('authenticate rejects invalid input with INVALID_INPUT', async () => {
  for (const bad of [undefined, null, {}, 'client', { authorize: 'nope' }]) {
    await assertRejectsCode(authenticate(bad), 'INVALID_INPUT');
  }
});

test('Google rejecting the key -> AUTH_FAILED (not retryable), and the raw error is not passed on', async () => {
  const { FakeJwt } = makeFakeJwt({
    authorizeImpl: () => {
      const e = new Error(`invalid_grant: Invalid JWT signature for ${FAKE_EMAIL} ${FAKE_PEM}`);
      e.response = { status: 400 };
      throw e;
    },
  });
  await assert.rejects(authenticate(new FakeJwt({})), (err) => {
    assert.equal(err.code, 'AUTH_FAILED');
    assert.equal(err.retryable, false);
    assertNoSecrets(err);
    return true;
  });
});

test('network problems and Google 5xx/429 -> AUTH_UNAVAILABLE (retryable)', async () => {
  const failures = [
    Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    Object.assign(new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com'), { code: 'ENOTFOUND' }),
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    Object.assign(new Error('server error'), { response: { status: 503 } }),
    Object.assign(new Error('slow down'), { response: { status: 429 } }),
  ];
  for (const failure of failures) {
    const { FakeJwt } = makeFakeJwt({
      authorizeImpl: () => {
        throw failure;
      },
    });
    await assert.rejects(authenticate(new FakeJwt({})), (err) => {
      assert.equal(err.code, 'AUTH_UNAVAILABLE');
      assert.equal(err.retryable, true);
      assertNoSecrets(err);
      return true;
    });
  }
});

test('non-Error values thrown by the library still become safe errors', async () => {
  for (const thrown of ['a string', 42, null, undefined, { weird: true }]) {
    const { FakeJwt } = makeFakeJwt({
      authorizeImpl: () => {
        throw thrown;
      },
    });
    await assertRejectsCode(authenticate(new FakeJwt({})), 'AUTH_FAILED');
  }
});

// --- shared instance, logging, boundaries ------------------------------------------

test('getSheetsAuth is lazy: it reads the real environment only when called', () => {
  const saved = process.env[KEY_FILE_ENV_VAR];
  try {
    resetSheetsAuth();
    delete process.env[KEY_FILE_ENV_VAR];
    // Requiring the module (already done above) did not throw; calling it does.
    assertCode(() => getSheetsAuth(), 'CONFIG_MISSING');

    process.env[KEY_FILE_ENV_VAR] = writeKeyFile(goodKey());
    const first = getSheetsAuth();
    assert.equal(getSheetsAuth(), first, 'the same instance is reused');

    resetSheetsAuth();
    assert.notEqual(getSheetsAuth(), first, 'reset creates a fresh instance');
  } finally {
    resetSheetsAuth();
    if (saved === undefined) delete process.env[KEY_FILE_ENV_VAR];
    else process.env[KEY_FILE_ENV_VAR] = saved;
  }
});

test('nothing is ever logged, on success or on any failure', async () => {
  const goodFile = writeKeyFile(goodKey());
  const invalidFile = writeKeyFile('{ not json');
  const lines = captureConsole(() => {
    const { FakeJwt } = makeFakeJwt();
    createSheetsAuth({ env: envFor(goodFile), JWT: FakeJwt });
    for (const env of [{}, envFor(invalidFile), envFor(path.join(tmpDir, 'missing.json'))]) {
      try {
        createSheetsAuth({ env, JWT: FakeJwt });
      } catch {
        // expected
      }
    }
  });
  assert.deepEqual(lines, []);

  const { FakeJwt } = makeFakeJwt({
    authorizeImpl: () => {
      throw new Error(FAKE_PEM);
    },
  });
  const logged = [];
  const origError = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    await authenticate(new FakeJwt({})).catch(() => {});
  } finally {
    console.error = origError;
  }
  assert.deepEqual(logged, []);
});

test('the source has no hardcoded credential path or key, and no HubSpot imports', () => {
  const dir = path.join(__dirname, '..', 'src', 'google');
  for (const name of ['sheetsAuth.js', 'sheetsErrors.js']) {
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.doesNotMatch(source, /BEGIN (RSA )?PRIVATE KEY-----\s*[A-Za-z0-9+/]{20}/, `${name}: no key material`);
    assert.doesNotMatch(source, /Google-Credentials|nifty-stage|[A-Za-z]:\\\\/i, `${name}: no hardcoded path`);
    assert.doesNotMatch(source, /require\(['"]\.\.\/(oauth|security|webhooks|idempotency)/, `${name}: stays separate from HubSpot code`);
    assert.doesNotMatch(source, /require\(['"]\.\.?\/oauth/, `${name}: stays separate from HubSpot OAuth`);
    assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)\s*\(/, `${name}: never logs`);
  }
});
