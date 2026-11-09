// tests/oauth-callback.test.js
//
// Tests the OAuth routes in src/oauth.js together with the encrypted token storage
// (Phase 3, step 5).
//
// - Only src/oauth.js is mounted (on its own Express app). server.js is never loaded,
//   so .env is never read. All credentials, tokens and keys below are FAKE.
// - HubSpot is a stub: globalThis.fetch is replaced while each test runs. The test's
//   own requests to the local server use the real fetch (localhost only).
// - Tokens are stored in a temporary SQLite file that is deleted afterwards.
//
// Run with:  node --test tests/oauth-callback.test.js

const test = require('node:test');
const { beforeEach, afterEach } = test;
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { DatabaseSync } = require('node:sqlite');

const oauthRouter = require('../src/oauth');
const { closeTokenService } = require('../src/oauth/tokenService');
const { createTokenStore } = require('../src/oauth/tokenStore');

const realFetch = globalThis.fetch;

const CLIENT_ID = 'fake-client-id-1234';
const CLIENT_SECRET = 'fake-client-secret-SECRET-5678';
const REDIRECT_URI = 'http://localhost:3000/oauth/callback';
const CODE = 'fake-auth-code-CODE-9999';
const ACCESS = 'fake-access-token-AAAA-1111';
const REFRESH = 'fake-refresh-token-RRRR-2222';
const LEAK = 'LEAKY-HUBSPOT-TEXT-do-not-show';
const PORTAL = 4242;

const TOKEN_URL = 'https://api.hubapi.com/oauth/v3/token';
const INTROSPECT_URL = 'https://api.hubapi.com/oauth/v3/token/introspect';

const ENV_NAMES = [
  'HUBSPOT_CLIENT_ID',
  'HUBSPOT_CLIENT_SECRET',
  'HUBSPOT_REDIRECT_URI',
  'HUBSPOT_SCOPES',
  'TOKEN_ENCRYPTION_KEY',
  'OAUTH_TOKEN_DB_PATH',
];

let server;
let baseUrl;
let savedEnv;
let dbPath;
let key;
let hubspot; // the fake HubSpot of the current test

// ---------------------------------------------------------------------------
// Test environment
// ---------------------------------------------------------------------------

test.before(async () => {
  const app = express();
  app.use('/oauth', oauthRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  closeTokenService();
  savedEnv = Object.fromEntries(ENV_NAMES.map((n) => [n, process.env[n]]));
  key = crypto.randomBytes(32);
  dbPath = path.join(os.tmpdir(), `oauth-cb-${crypto.randomBytes(6).toString('hex')}.db`);
  process.env.HUBSPOT_CLIENT_ID = CLIENT_ID;
  process.env.HUBSPOT_CLIENT_SECRET = CLIENT_SECRET;
  process.env.HUBSPOT_REDIRECT_URI = REDIRECT_URI;
  delete process.env.HUBSPOT_SCOPES;
  process.env.TOKEN_ENCRYPTION_KEY = key.toString('base64');
  process.env.OAUTH_TOKEN_DB_PATH = dbPath;
  hubspot = installFakeHubspot();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  closeTokenService();
  for (const n of ENV_NAMES) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  }
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});

const goodTokenBody = (extra = {}) => ({
  token_type: 'bearer',
  access_token: ACCESS,
  refresh_token: REFRESH,
  expires_in: 1800,
  hub_id: PORTAL,
  scopes: ['oauth', 'crm.objects.contacts.read'],
  ...extra,
});

const reply = (status, body) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// Replaces globalThis.fetch with a fake HubSpot that records every request.
function installFakeHubspot() {
  const fake = {
    calls: [],
    token: () => reply(200, goodTokenBody()),
    introspect: () => reply(200, { active: true, hub_id: PORTAL, token_use: 'access_token' }),
  };
  globalThis.fetch = async (url, init = {}) => {
    const form = init.body ? Object.fromEntries(new URLSearchParams(String(init.body))) : {};
    fake.calls.push({
      url: String(url),
      method: init.method,
      headers: init.headers,
      form,
      redirect: init.redirect,
      hasSignal: init.signal instanceof AbortSignal,
    });
    if (String(url) === TOKEN_URL) return fake.token(init);
    if (String(url) === INTROSPECT_URL) return fake.introspect(init);
    throw new Error(`unexpected request to ${url}`);
  };
  return fake;
}

// ---------------------------------------------------------------------------
// Helpers to drive the real routes
// ---------------------------------------------------------------------------

async function startInstall() {
  const origLog = console.log;
  console.log = () => {}; // keep the test output quiet ("OAuth: starting install...")
  let res;
  try {
    res = await realFetch(`${baseUrl}/oauth/install`, { redirect: 'manual' });
  } finally {
    console.log = origLog;
  }
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  return { location, state: location.searchParams.get('state') };
}

async function callback(query) {
  const res = await realFetch(`${baseUrl}/oauth/callback?${new URLSearchParams(query).toString()}`);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, text, json, headers: Object.fromEntries(res.headers) };
}

// Logs everything printed while `run` executes.
async function withLogs(run) {
  const names = ['log', 'info', 'warn', 'error', 'debug'];
  const orig = {};
  const lines = [];
  for (const n of names) {
    orig[n] = console[n];
    console[n] = (...a) => lines.push(a.join(' '));
  }
  try {
    return { result: await run(), logs: lines.join('\n') };
  } finally {
    for (const n of names) console[n] = orig[n];
  }
}

// Full happy-path driver: install, then callback with the given code.
async function authorize({ code = CODE } = {}) {
  const { state } = await startInstall();
  return withLogs(() => callback({ code, state }));
}

function readConnection(portalId) {
  const store = createTokenStore(dbPath, { key });
  try {
    return store.get(portalId);
  } finally {
    store.close();
  }
}

function listConnections() {
  if (!fs.existsSync(dbPath)) return [];
  const store = createTokenStore(dbPath, { key });
  try {
    return store.list();
  } finally {
    store.close();
  }
}

function seedConnection(extra = {}) {
  const store = createTokenStore(dbPath, { key });
  try {
    store.save({
      portalId: PORTAL,
      accessToken: 'seeded-access-token',
      refreshToken: 'seeded-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
      ...extra,
    });
  } finally {
    store.close();
  }
}

// Nothing secret may be in the response (body or headers) or in the log output.
function assertNoLeaks(response, logs, extra = []) {
  const secrets = [ACCESS, REFRESH, CLIENT_SECRET, CODE, key.toString('base64'), key.toString('hex'), LEAK, ...extra];
  const haystack = [response.text, JSON.stringify(response.headers), logs].join('\n');
  for (const secret of secrets) assert.ok(!haystack.includes(secret), `leaked "${secret}"`);
}

// ---------------------------------------------------------------------------
// Existing behaviour is preserved
// ---------------------------------------------------------------------------

test('/oauth/install still redirects to HubSpot with a fresh random state', async () => {
  const { location, state } = await startInstall();
  assert.equal(location.origin + location.pathname, 'https://app.hubspot.com/oauth/authorize');
  assert.equal(location.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(location.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.match(location.searchParams.get('scope'), /^oauth crm\.objects\.contacts\.read /);
  assert.match(state, /^[0-9a-f]{64}$/);
  assert.notEqual((await startInstall()).state, state);
  assert.equal(hubspot.calls.length, 0);
});

test('/oauth/install reports missing configuration', async () => {
  delete process.env.HUBSPOT_CLIENT_ID;
  const res = await realFetch(`${baseUrl}/oauth/install`, { redirect: 'manual' });
  assert.equal(res.status, 500);
});

test('callback: missing parameters, unknown state, denied and error responses', async () => {
  for (const query of [{}, { code: CODE }, { state: 'abc' }, { code: '', state: '' }]) {
    const res = await callback(query);
    assert.equal(res.status, 400, JSON.stringify(query));
    assert.match(res.json.message, /Missing required query parameters/);
  }
  const unknown = await callback({ code: CODE, state: 'f'.repeat(64) });
  assert.equal(unknown.status, 400);
  assert.match(unknown.json.message, /Invalid or expired state/);

  const denied = await callback({ error: 'access_denied' });
  assert.equal(denied.status, 400);
  assert.match(denied.json.message, /denied/);
  const other = await callback({ error: 'server_error', error_description: LEAK });
  assert.equal(other.status, 400);
  assert.match(other.json.message, /authorization error/);
  assert.ok(!other.text.includes(LEAK));

  assert.equal(hubspot.calls.length, 0, 'HubSpot is never contacted for these');
  assert.deepEqual(listConnections(), []);
});

test('callback: a state is single use (a replayed callback is refused and HubSpot is called once)', async () => {
  const { state } = await startInstall();
  const first = await callback({ code: CODE, state });
  assert.equal(first.status, 200);
  const second = await callback({ code: CODE, state });
  assert.equal(second.status, 400);
  assert.match(second.json.message, /Invalid or expired state/);
  assert.equal(hubspot.calls.length, 1);
  assert.equal(listConnections().length, 1);
});

test('callback: an expired state (older than 10 minutes) is refused', async () => {
  const { state } = await startInstall();
  const realNow = Date.now;
  Date.now = () => realNow() + 10 * 60 * 1000 + 1000;
  try {
    const res = await callback({ code: CODE, state });
    assert.equal(res.status, 400);
    assert.match(res.json.message, /Invalid or expired state/);
  } finally {
    Date.now = realNow;
  }
  assert.equal(hubspot.calls.length, 0);
});

test('callback: a state is also consumed when HubSpot reports an error', async () => {
  const { state } = await startInstall();
  await callback({ error: 'access_denied', state });
  const res = await callback({ code: CODE, state });
  assert.equal(res.status, 400);
  assert.match(res.json.message, /Invalid or expired state/);
});

test('the old in-memory token variable is gone', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'oauth.js'), 'utf8');
  assert.ok(!/\b(let|var|const)\s+tokenStore\b/.test(source), 'no tokenStore variable may remain in oauth.js');
  assert.ok(!/in server memory only/i.test(source));
});

// ---------------------------------------------------------------------------
// Successful authorization
// ---------------------------------------------------------------------------

test('success with hub_id: tokens are stored encrypted, the response has no tokens', async () => {
  const before = Date.now();
  const { result, logs } = await authorize();
  const after = Date.now();

  assert.equal(result.status, 200);
  assert.deepEqual(result.json, {
    status: 'success',
    message: 'HubSpot account connected. Tokens are stored encrypted.',
    portalId: PORTAL,
  });
  assertNoLeaks(result, logs);
  assert.match(logs, /connected HubSpot portal 4242; tokens stored encrypted/);

  // Exactly one HubSpot request, with the exact form body.
  assert.equal(hubspot.calls.length, 1);
  const call = hubspot.calls[0];
  assert.equal(call.url, TOKEN_URL);
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.headers, { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
  assert.deepEqual(call.form, {
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    code: CODE,
  });
  assert.equal(call.redirect, 'error');
  assert.equal(call.hasSignal, true);

  // The stored connection.
  const c = readConnection(PORTAL);
  assert.equal(c.accessToken, ACCESS);
  assert.equal(c.refreshToken, REFRESH);
  assert.equal(c.status, 'active');
  assert.deepEqual(c.scopes, ['oauth', 'crm.objects.contacts.read']);
  assert.ok(c.accessExpiresAt >= before + 1800 * 1000 && c.accessExpiresAt <= after + 1800 * 1000, 'expiry = arrival time + expires_in');
});

test('success: no plaintext token or key is in the database files', async () => {
  const { result } = await authorize();
  assert.equal(result.status, 200);
  for (const suffix of ['', '-wal', '-shm']) {
    if (!fs.existsSync(dbPath + suffix)) continue;
    const bytes = fs.readFileSync(dbPath + suffix);
    for (const secret of [ACCESS, REFRESH, CLIENT_SECRET, CODE]) assert.ok(!bytes.includes(Buffer.from(secret)));
    assert.ok(!bytes.includes(key));
    assert.ok(!bytes.includes(Buffer.from(key.toString('base64'))));
  }
});

test('success: custom HUBSPOT_SCOPES do not matter for storage; missing response scopes are fine', async () => {
  hubspot.token = () => reply(200, goodTokenBody({ scopes: undefined }));
  const { result } = await authorize();
  assert.equal(result.status, 200);
  assert.deepEqual(readConnection(PORTAL).scopes, []);
});

test('re-authorizing replaces the tokens and recovers a needs_reauth connection', async () => {
  seedConnection();
  const store = createTokenStore(dbPath, { key });
  store.markNeedsReauth(PORTAL, 'INVALID_GRANT');
  assert.equal(store.getStatus(PORTAL).status, 'needs_reauth');
  store.close();

  const { result } = await authorize();
  assert.equal(result.status, 200);
  const c = readConnection(PORTAL);
  assert.equal(c.accessToken, ACCESS);
  assert.equal(c.status, 'active');
  assert.equal(c.lastError, null);
  assert.equal(listConnections().length, 1);
});

test('two HubSpot accounts are stored independently', async () => {
  hubspot.token = () => reply(200, goodTokenBody({ hub_id: 111, access_token: 'access-for-111' }));
  await authorize();
  hubspot.token = () => reply(200, goodTokenBody({ hub_id: 222, access_token: 'access-for-222' }));
  await authorize();
  assert.equal(readConnection(111).accessToken, 'access-for-111');
  assert.equal(readConnection(222).accessToken, 'access-for-222');
  assert.equal(listConnections().length, 2);
});

// ---------------------------------------------------------------------------
// Portal ID fallback (token introspection)
// ---------------------------------------------------------------------------

test('without a usable hub_id the portal is looked up through token introspection', async () => {
  for (const hub_id of [undefined, null, 'abc', '4242', 0, -1, 1.5]) {
    hubspot.calls.length = 0;
    hubspot.token = () => reply(200, goodTokenBody({ hub_id }));
    hubspot.introspect = () => reply(200, { active: true, hub_id: 777, token_use: 'access_token' });

    const { result, logs } = await authorize();
    assert.equal(result.status, 200, `hub_id=${String(hub_id)}`);
    assert.equal(result.json.portalId, 777);
    assertNoLeaks(result, logs);

    assert.equal(hubspot.calls.length, 2);
    const call = hubspot.calls[1];
    assert.equal(call.url, INTROSPECT_URL);
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.headers, { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' });
    assert.deepEqual(call.form, {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      token_type_hint: 'access_token',
      token: ACCESS,
    });
    assert.equal(call.redirect, 'error');
    assert.equal(call.hasSignal, true);
    assert.equal(readConnection(777).accessToken, ACCESS);
  }
});

test('when the portal cannot be determined nothing is stored', async () => {
  hubspot.token = () => reply(200, goodTokenBody({ hub_id: undefined }));
  const unusable = [
    () => reply(200, { active: false, hub_id: PORTAL }),
    () => reply(200, { active: true }),
    () => reply(200, { active: true, hub_id: 'x' }),
    () => reply(200, { active: true, hub_id: 0 }),
    () => reply(200, { hub_id: PORTAL }),
    () => reply(200, 'not json'),
    () => reply(200, [PORTAL]),
    () => reply(401, { message: LEAK }),
    () => reply(500, { message: LEAK }),
    () => {
      throw new TypeError(`fetch failed ${LEAK} ${ACCESS}`);
    },
  ];
  for (const make of unusable) {
    hubspot.introspect = make;
    const { result, logs } = await authorize();
    assert.equal(result.status, 502);
    assert.match(result.json.message, /Could not determine the HubSpot account ID\. No tokens were stored\./);
    assertNoLeaks(result, logs);
    assert.doesNotMatch(logs, /connected HubSpot portal/);
  }
  assert.deepEqual(listConnections(), []);
});

// ---------------------------------------------------------------------------
// HubSpot errors
// ---------------------------------------------------------------------------

test('an invalid or expired authorization code gives a friendly 400', async () => {
  hubspot.token = () => reply(400, { error: 'invalid_grant', error_description: LEAK, message: LEAK });
  const { result, logs } = await authorize();
  assert.equal(result.status, 400);
  assert.equal(result.json.message, 'The authorization code is invalid or expired. Please start again at /oauth/install.');
  assertNoLeaks(result, logs);
  assert.match(logs, /token exchange failed \(HTTP 400, invalid_grant\)/);
  assert.deepEqual(listConnections(), []);
});

test('other HubSpot errors, network failures and timeouts give 502 and store nothing', async () => {
  const failures = [
    () => reply(400, { error: 'invalid_request', message: LEAK }),
    () => reply(400, 'garbage'),
    () => reply(401, { error: 'invalid_client', message: LEAK }),
    () => reply(403, { message: LEAK }),
    () => reply(429, { message: LEAK }),
    () => reply(500, { message: LEAK }),
    () => reply(503, `<html>${LEAK}</html>`),
  ];
  for (const make of failures) {
    hubspot.token = make;
    const { result, logs } = await authorize();
    assert.equal(result.status, 502);
    assert.match(result.json.message, /Token exchange with HubSpot failed/);
    assertNoLeaks(result, logs);
  }
  for (const err of [new TypeError(`fetch failed ${LEAK} ${CLIENT_SECRET}`), Object.assign(new Error('timeout'), { name: 'TimeoutError' })]) {
    hubspot.token = () => {
      throw err;
    };
    const { result, logs } = await authorize();
    assert.equal(result.status, 502);
    assert.equal(result.json.message, 'Could not reach HubSpot to exchange the authorization code.');
    assertNoLeaks(result, logs);
    assert.match(logs, new RegExp(`token exchange request failed \\(${err.name}\\)`));
  }
  assert.deepEqual(listConnections(), []);
});

test('a failed authorization leaves an existing connection untouched', async () => {
  seedConnection();
  hubspot.token = () => reply(500, { message: LEAK });
  const { result } = await authorize();
  assert.equal(result.status, 502);
  const c = readConnection(PORTAL);
  assert.equal(c.accessToken, 'seeded-access-token');
  assert.equal(c.refreshToken, 'seeded-refresh-token');
  assert.equal(c.rowVersion, 1);
});

// ---------------------------------------------------------------------------
// Malformed token responses
// ---------------------------------------------------------------------------

test('malformed token responses are rejected and never replace stored tokens', async () => {
  seedConnection();
  const bad = [
    'not json at all',
    '[]',
    '"string"',
    'null',
    JSON.stringify(goodTokenBody({ access_token: undefined })),
    JSON.stringify(goodTokenBody({ access_token: '' })),
    JSON.stringify(goodTokenBody({ access_token: 'has space' })),
    JSON.stringify(goodTokenBody({ access_token: 12345 })),
    JSON.stringify(goodTokenBody({ access_token: 'x'.repeat(8193) })),
    JSON.stringify(goodTokenBody({ refresh_token: undefined })),
    JSON.stringify(goodTokenBody({ refresh_token: '' })),
    JSON.stringify(goodTokenBody({ refresh_token: null })),
    JSON.stringify(goodTokenBody({ refresh_token: { a: 1 } })),
    JSON.stringify(goodTokenBody({ expires_in: undefined })),
    JSON.stringify(goodTokenBody({ expires_in: '1800' })),
    JSON.stringify(goodTokenBody({ expires_in: 0 })),
    JSON.stringify(goodTokenBody({ expires_in: -1 })),
    JSON.stringify(goodTokenBody({ expires_in: 59 })),
    JSON.stringify(goodTokenBody({ expires_in: 604801 })),
    JSON.stringify(goodTokenBody({ expires_in: 1800.5 })),
  ];
  for (const body of bad) {
    hubspot.calls.length = 0;
    hubspot.token = () => reply(200, body);
    const { result, logs } = await authorize();
    assert.equal(result.status, 502, body.slice(0, 60));
    assert.equal(result.json.message, 'HubSpot returned an unexpected token response. No tokens were stored.');
    assertNoLeaks(result, logs);
    assert.doesNotMatch(logs, /connected HubSpot portal/);
    assert.equal(hubspot.calls.length, 1, 'no introspection for a bad token response');
  }
  const c = readConnection(PORTAL);
  assert.equal(c.accessToken, 'seeded-access-token');
  assert.equal(c.rowVersion, 1);
});

test('logs name the invalid fields but never their values', async () => {
  hubspot.token = () => reply(200, goodTokenBody({ access_token: `bad token ${LEAK}`, expires_in: 'soon' }));
  const { result, logs } = await authorize();
  assert.equal(result.status, 502);
  assert.match(logs, /invalid fields: access_token, expires_in/);
  assertNoLeaks(result, logs);
});

// ---------------------------------------------------------------------------
// Configuration, encryption and storage failures
// ---------------------------------------------------------------------------

test('missing HubSpot app credentials give a configuration error and HubSpot is not called', async () => {
  const { state } = await startInstall();
  delete process.env.HUBSPOT_CLIENT_SECRET;
  const res = await callback({ code: CODE, state });
  assert.equal(res.status, 500);
  assert.match(res.json.message, /OAuth is not configured/);
  assert.equal(hubspot.calls.length, 0);
});

test('a missing or invalid encryption key stops the callback BEFORE the code is used', async () => {
  for (const value of [undefined, '', 'too-short', crypto.randomBytes(16).toString('base64'), Buffer.alloc(32).toString('base64')]) {
    if (value === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = value;
    const { result, logs } = await authorize();
    assert.equal(result.status, 500, String(value));
    assert.match(result.json.message, /token encryption is not configured correctly/);
    assert.match(result.json.message, /NOT connected/);
    assertNoLeaks(result, logs, value ? [value] : []);
    assert.match(logs, /tokens could not be stored \(ENCRYPTION_ERROR|tokens could not be stored \(KEY_/);
    assert.doesNotMatch(logs, /connected HubSpot portal/);
  }
  assert.equal(hubspot.calls.length, 0, 'the one-time authorization code was never sent to HubSpot');
  assert.deepEqual(listConnections(), []);
});

test('if the encryption key disappears during the exchange, success is not reported and nothing is stored', async () => {
  hubspot.token = () => {
    delete process.env.TOKEN_ENCRYPTION_KEY; // simulates a late encryption failure
    return reply(200, goodTokenBody());
  };
  const { result, logs } = await authorize();
  assert.equal(result.status, 500);
  assert.match(result.json.message, /NOT connected/);
  assertNoLeaks(result, logs);
  assert.doesNotMatch(logs, /connected HubSpot portal/);
  assert.equal(hubspot.calls.length, 1);
  assert.deepEqual(listConnections(), []);
});

test('an unusable token database stops the callback BEFORE the code is used', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-cb-dir-'));
  process.env.OAUTH_TOKEN_DB_PATH = dir; // a directory cannot be opened as a database
  try {
    const { result, logs } = await authorize();
    assert.equal(result.status, 503);
    assert.equal(result.json.message, 'Token storage is unavailable. The HubSpot account was NOT connected.');
    assertNoLeaks(result, logs, [dir]);
    assert.match(logs, /tokens could not be stored \(STORAGE_ERROR|tokens could not be stored \(DB_OPEN_FAILED/);
    assert.doesNotMatch(logs, /connected HubSpot portal/);
    assert.equal(hubspot.calls.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('if the database breaks during the exchange, success is not reported', async () => {
  hubspot.token = () => {
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TABLE oauth_connections'); // simulates a late storage failure
    raw.close();
    return reply(200, goodTokenBody());
  };
  const { result, logs } = await authorize();
  assert.equal(result.status, 503);
  assert.match(result.json.message, /Token storage is unavailable/);
  assert.match(result.json.message, /NOT connected/);
  assertNoLeaks(result, logs, ['oauth_connections', 'no such table']);
  assert.doesNotMatch(logs, /connected HubSpot portal/);
  assert.equal(hubspot.calls.length, 1);
});

// ---------------------------------------------------------------------------
// Safe logging
// ---------------------------------------------------------------------------

test('across a whole successful flow and a failed one, logs and responses never contain secrets', async () => {
  const ok = await authorize();
  assertNoLeaks(ok.result, ok.logs);

  hubspot.token = () => reply(500, { error: LEAK, access_token: ACCESS, refresh_token: REFRESH });
  const failed = await authorize();
  assertNoLeaks(failed.result, failed.logs);

  // The log lines are short, fixed messages (plus numbers and codes).
  for (const line of `${ok.logs}\n${failed.logs}`.split('\n').filter(Boolean)) {
    assert.ok(line.length < 200, `unexpectedly long log line: ${line.slice(0, 60)}`);
  }
});

test('the state value is never written to the log', async () => {
  const { state } = await startInstall();
  const { result, logs } = await withLogs(() => callback({ code: CODE, state }));
  assert.equal(result.status, 200);
  assert.ok(!logs.includes(state));
});
