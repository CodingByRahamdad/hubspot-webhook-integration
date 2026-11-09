// tests/token-crypto.test.js
//
// Tests src/security/tokenCrypto.js (Phase 3, step 1).
// Only fake tokens and random in-test keys are used. The real environment and
// .env are never read: keys are passed explicitly or via a fake "env" object.
//
// Run with:  node --test tests/token-crypto.test.js   (also part of npm test later)

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  loadKey,
  encryptToken,
  decryptToken,
  TokenCryptoError,
  TOKEN_FIELDS,
  KEY_ENV_VAR,
} = require('../src/security/tokenCrypto');

const newKey = () => crypto.randomBytes(32);
const ACCESS = 'fake-access-token-AAAA-1111';
const REFRESH = 'fake-refresh-token-RRRR-2222';
const ctx = (extra = {}) => ({ portalId: 12345, field: 'access_token', ...extra });

function assertCode(fn, code) {
  assert.throws(fn, (err) => {
    assert.ok(err instanceof TokenCryptoError, 'must be a TokenCryptoError');
    assert.equal(err.name, 'TokenCryptoError');
    assert.equal(err.code, code);
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

// Flips one character in the chosen part (0=version, 1=iv, 2=tag, 3=ciphertext).
function tamper(blob, partIndex) {
  const parts = blob.split('.');
  const p = parts[partIndex];
  const i = Math.floor(p.length / 2);
  parts[partIndex] = p.slice(0, i) + (p[i] === 'A' ? 'B' : 'A') + p.slice(i + 1);
  return parts.join('.');
}

// ---------------------------------------------------------------------------
// Success paths
// ---------------------------------------------------------------------------

test('round trip works for the access_token and refresh_token fields', () => {
  const key = newKey();
  const a = encryptToken(ACCESS, ctx({ key }));
  const r = encryptToken(REFRESH, ctx({ key, field: 'refresh_token' }));
  assert.equal(decryptToken(a, ctx({ key })), ACCESS);
  assert.equal(decryptToken(r, ctx({ key, field: 'refresh_token' })), REFRESH);
  assert.deepEqual([...TOKEN_FIELDS], ['access_token', 'refresh_token']);
});

test('long and non-ASCII tokens round trip', () => {
  const key = newKey();
  for (const token of ['x'.repeat(5000), 'tökén-日本語-🔑']) {
    assert.equal(decryptToken(encryptToken(token, ctx({ key })), ctx({ key })), token);
  }
});

test('the stored value has the expected format and does not contain the plaintext', () => {
  const key = newKey();
  const blob = encryptToken(ACCESS, ctx({ key }));
  assert.match(blob, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(blob.split('.').length, 4);
  assert.ok(!blob.includes(ACCESS));
  assert.ok(!Buffer.from(blob).includes(Buffer.from(ACCESS)));
});

test('the same token encrypted twice uses different IVs and produces different output', () => {
  const key = newKey();
  const one = encryptToken(ACCESS, ctx({ key }));
  const two = encryptToken(ACCESS, ctx({ key }));
  assert.notEqual(one, two);
  assert.notEqual(one.split('.')[1], two.split('.')[1]); // iv
  assert.notEqual(one.split('.')[3], two.split('.')[3]); // ciphertext
  assert.equal(decryptToken(one, ctx({ key })), ACCESS);
  assert.equal(decryptToken(two, ctx({ key })), ACCESS);
});

test('200 encryptions never reuse an IV', () => {
  const key = newKey();
  const ivs = new Set();
  for (let i = 0; i < 200; i += 1) ivs.add(encryptToken(ACCESS, ctx({ key })).split('.')[1]);
  assert.equal(ivs.size, 200);
});

test('a numeric and a string portal ID are the same portal', () => {
  const key = newKey();
  const blob = encryptToken(ACCESS, ctx({ key, portalId: 777 }));
  assert.equal(decryptToken(blob, ctx({ key, portalId: '777' })), ACCESS);
});

test('the key buffer passed in is not modified', () => {
  const key = newKey();
  const copy = Buffer.from(key);
  decryptToken(encryptToken(ACCESS, ctx({ key })), ctx({ key }));
  assert.ok(key.equals(copy));
});

// ---------------------------------------------------------------------------
// Failure paths: wrong key, tampering, wrong context
// ---------------------------------------------------------------------------

test('decrypting with a different key fails', () => {
  const blob = encryptToken(ACCESS, ctx({ key: newKey() }));
  assertCode(() => decryptToken(blob, ctx({ key: newKey() })), 'DECRYPT_FAILED');
});

test('tampering with the IV, tag or ciphertext is detected', () => {
  const key = newKey();
  const blob = encryptToken(ACCESS, ctx({ key }));
  for (const part of [1, 2, 3]) {
    assertCode(() => decryptToken(tamper(blob, part), ctx({ key })), 'DECRYPT_FAILED');
  }
});

test('a changed or wrong key-version prefix is rejected', () => {
  const key = newKey();
  const blob = encryptToken(ACCESS, ctx({ key }));
  assertCode(() => decryptToken(blob.replace(/^v1/, 'v2'), ctx({ key })), 'DECRYPT_FAILED');
  assertCode(() => decryptToken(blob.replace(/^v1/, 'x1'), ctx({ key })), 'INVALID_FORMAT');
  // A blob made for key version 2 only opens when the caller expects version 2.
  const v2 = encryptToken(ACCESS, ctx({ key, keyVersion: 2 }));
  assert.ok(v2.startsWith('v2.'));
  assertCode(() => decryptToken(v2, ctx({ key })), 'DECRYPT_FAILED');
  assert.equal(decryptToken(v2, ctx({ key, keyVersion: 2 })), ACCESS);
});

test('malformed stored values are rejected without a crash', () => {
  const key = newKey();
  const good = encryptToken(ACCESS, ctx({ key }));
  const [v, iv, tag, ct] = good.split('.');
  const bad = [
    '',
    'garbage',
    `${v}.${iv}.${tag}`, // too few parts
    `${good}.extra`, // too many parts
    `${v}.${iv}.${tag}.`, // empty ciphertext
    `${v}.${iv.slice(2)}.${tag}.${ct}`, // short IV
    `${v}.${iv}.${tag.slice(2)}.${ct}`, // short tag
    `${v}.${iv}.${tag}.${ct}=`, // padding is not canonical
    `${v}.${iv}.${tag}.${ct}!`, // illegal character
    `${v}.${iv}.${tag}.${ct.slice(0, -1)}`, // truncated ciphertext
  ];
  for (const value of bad) {
    assert.throws(() => decryptToken(value, ctx({ key })), TokenCryptoError, JSON.stringify(value));
  }
  for (const value of [null, undefined, 123, {}, []]) {
    assertCode(() => decryptToken(value, ctx({ key })), 'INVALID_FORMAT');
  }
});

test('a ciphertext cannot be moved to another portal', () => {
  const key = newKey();
  const blob = encryptToken(ACCESS, ctx({ key, portalId: 111 }));
  assertCode(() => decryptToken(blob, ctx({ key, portalId: 222 })), 'DECRYPT_FAILED');
});

test('a ciphertext cannot be moved to another token field', () => {
  const key = newKey();
  const accessBlob = encryptToken(ACCESS, ctx({ key, field: 'access_token' }));
  const refreshBlob = encryptToken(REFRESH, ctx({ key, field: 'refresh_token' }));
  assertCode(() => decryptToken(accessBlob, ctx({ key, field: 'refresh_token' })), 'DECRYPT_FAILED');
  assertCode(() => decryptToken(refreshBlob, ctx({ key, field: 'access_token' })), 'DECRYPT_FAILED');
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

test('invalid field, portal ID, plaintext or key version are rejected', () => {
  const key = newKey();
  const blob = encryptToken(ACCESS, ctx({ key }));
  for (const field of ['id_token', '', undefined, null, 'ACCESS_TOKEN']) {
    assertCode(() => encryptToken(ACCESS, ctx({ key, field })), 'INVALID_INPUT');
    assertCode(() => decryptToken(blob, ctx({ key, field })), 'INVALID_INPUT');
  }
  for (const portalId of [undefined, null, '', 0, -5, 1.5, NaN, {}, [], true]) {
    assertCode(() => encryptToken(ACCESS, ctx({ key, portalId })), 'INVALID_INPUT');
    assertCode(() => decryptToken(blob, ctx({ key, portalId })), 'INVALID_INPUT');
  }
  for (const plaintext of ['', undefined, null, 42, {}, Buffer.from('x')]) {
    assertCode(() => encryptToken(plaintext, ctx({ key })), 'INVALID_INPUT');
  }
  for (const keyVersion of [0, -1, 1.5, '1']) {
    assertCode(() => encryptToken(ACCESS, ctx({ key, keyVersion })), 'INVALID_INPUT');
  }
});

// ---------------------------------------------------------------------------
// Key validation (fail securely)
// ---------------------------------------------------------------------------

test('loadKey accepts a valid 32-byte base64 key and returns an independent copy', () => {
  const raw = newKey();
  const env = { [KEY_ENV_VAR]: raw.toString('base64') };
  const key = loadKey(env);
  assert.equal(key.length, 32);
  assert.ok(key.equals(raw));
  key.fill(1); // changing the copy must not change what the next call returns
  assert.ok(loadKey(env).equals(raw));
});

test('loadKey fails closed when the key is missing', () => {
  for (const env of [{}, { [KEY_ENV_VAR]: undefined }, { [KEY_ENV_VAR]: '' }, null]) {
    assertCode(() => loadKey(env), 'KEY_MISSING');
  }
});

test('loadKey rejects malformed keys', () => {
  const good = newKey().toString('base64');
  const invalid = [
    '   ',
    ' ' + good, // whitespace
    good + '\n',
    good.slice(0, -4), // too short
    crypto.randomBytes(16).toString('base64'),
    crypto.randomBytes(31).toString('base64'),
    crypto.randomBytes(33).toString('base64'),
    crypto.randomBytes(32).toString('hex'), // hex is not accepted
    'not base64 at all!!',
    good.replace(/=+$/, '').slice(0, 40) + '?', // illegal character
    Buffer.alloc(32, 0).toString('base64'), // all zeros
    Buffer.alloc(32, 255).toString('base64'), // all the same byte
    good.slice(0, 42) + 'B=', // non-canonical encoding of 32 bytes
  ];
  for (const raw of invalid) {
    assertCode(() => loadKey({ [KEY_ENV_VAR]: raw }), 'KEY_INVALID');
  }
  assertCode(() => loadKey({ [KEY_ENV_VAR]: 12345 }), 'KEY_INVALID');
  assertCode(() => loadKey({ [KEY_ENV_VAR]: [good] }), 'KEY_INVALID');
});

test('encrypt and decrypt reject an invalid explicit key (no fallback key)', () => {
  const blob = encryptToken(ACCESS, ctx({ key: newKey() }));
  for (const key of [Buffer.alloc(16, 7), Buffer.alloc(33, 7), 'a-string', 123, null]) {
    assertCode(() => encryptToken(ACCESS, ctx({ key })), 'KEY_INVALID');
    assertCode(() => decryptToken(blob, ctx({ key })), 'KEY_INVALID');
  }
});

test('without an explicit key the module reads TOKEN_ENCRYPTION_KEY and fails closed when it is unusable', () => {
  const saved = process.env[KEY_ENV_VAR];
  try {
    delete process.env[KEY_ENV_VAR];
    assertCode(() => encryptToken(ACCESS, ctx()), 'KEY_MISSING');
    assertCode(() => decryptToken('v1.a.b.c', ctx()), 'KEY_MISSING');

    process.env[KEY_ENV_VAR] = 'too-short';
    assertCode(() => encryptToken(ACCESS, ctx()), 'KEY_INVALID');

    process.env[KEY_ENV_VAR] = newKey().toString('base64');
    assert.equal(decryptToken(encryptToken(ACCESS, ctx()), ctx()), ACCESS);
  } finally {
    if (saved === undefined) delete process.env[KEY_ENV_VAR];
    else process.env[KEY_ENV_VAR] = saved;
  }
});

// ---------------------------------------------------------------------------
// Nothing sensitive leaks
// ---------------------------------------------------------------------------

test('errors never contain the token, the key or the ciphertext', () => {
  const key = newKey();
  const blob = encryptToken(ACCESS, ctx({ key }));
  const secrets = [ACCESS, key.toString('base64'), key.toString('hex'), blob, blob.split('.')[3]];
  const rawKey = newKey().toString('base64');

  const failures = [
    () => decryptToken(tamper(blob, 3), ctx({ key })),
    () => decryptToken(blob, ctx({ key: newKey() })),
    () => decryptToken(blob, ctx({ key, portalId: 999 })),
    () => encryptToken(ACCESS, ctx({ key, field: 'bogus' })),
    () => loadKey({ [KEY_ENV_VAR]: rawKey.slice(0, 20) }),
  ];
  secrets.push(rawKey, rawKey.slice(0, 20));

  for (const run of failures) {
    let caught;
    try {
      run();
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof TokenCryptoError);
    const text = [caught.message, caught.stack, JSON.stringify(caught), String(caught), caught.code].join('\n');
    for (const secret of secrets) assert.ok(!text.includes(secret), 'error text leaked a secret');
  }
});

test('nothing is ever written to the console, on success or failure', () => {
  const key = newKey();
  const lines = captureConsole(() => {
    const blob = encryptToken(ACCESS, ctx({ key }));
    decryptToken(blob, ctx({ key }));
    for (const run of [
      () => decryptToken(tamper(blob, 3), ctx({ key })),
      () => decryptToken('garbage', ctx({ key })),
      () => loadKey({}),
      () => loadKey({ [KEY_ENV_VAR]: 'bad' }),
    ]) {
      try {
        run();
      } catch {
        // expected
      }
    }
  });
  assert.deepEqual(lines, []);
});
