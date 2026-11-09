// tests/hubspot-token-client.test.js
//
// Tests src/oauth/hubspotTokenClient.js (Phase 3, step 3).
// fetch is ALWAYS a stub: no real HubSpot request is made. Credentials and tokens
// are fake values passed through a fake "env" object; .env is never read.
//
// Run with:  node --test tests/hubspot-token-client.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createHubspotTokenClient,
  HubspotTokenError,
  HUBSPOT_TOKEN_URL,
} = require('../src/oauth/hubspotTokenClient');

const CLIENT_ID = 'fake-client-id-1234';
const CLIENT_SECRET = 'fake-client-secret-SECRET-5678';
const OLD_REFRESH = 'fake-old-refresh-token-OLD';
const NEW_ACCESS = 'fake-new-access-token-NEW';
const NEW_REFRESH = 'fake-new-refresh-token-ROTATED';
const ENV = { HUBSPOT_CLIENT_ID: CLIENT_ID, HUBSPOT_CLIENT_SECRET: CLIENT_SECRET };
const NOW = 1_700_000_000_000;

// A fake fetch Response. "body" may be an object (sent as JSON) or a raw string.
function fakeResponse({ status = 200, body = {}, headers = {}, textError } = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => {
      if (textError) throw textError;
      return raw;
    },
  };
}

// A fake fetch that records every call and answers with `answer` (a response or a function).
function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return typeof answer === 'function' ? answer(url, init) : answer;
  };
  fn.calls = calls;
  return fn;
}

const goodBody = (extra = {}) => ({
  token_type: 'bearer',
  access_token: NEW_ACCESS,
  refresh_token: NEW_REFRESH,
  expires_in: 1800,
  ...extra,
});

function makeClient(fetchImpl, options = {}) {
  return createHubspotTokenClient({ fetchImpl, env: ENV, now: () => NOW, ...options });
}

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  assert.fail('expected the call to fail');
  return null;
}

async function assertFails(promise, code, expected = {}) {
  const err = await failure(promise);
  assert.ok(err instanceof HubspotTokenError, `expected HubspotTokenError, got ${err && err.name}`);
  assert.equal(err.name, 'HubspotTokenError');
  assert.equal(err.code, code);
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(err[k], v, k);
  return err;
}

function captureConsole() {
  const names = ['log', 'info', 'warn', 'error', 'debug'];
  const orig = {};
  const lines = [];
  for (const n of names) {
    orig[n] = console[n];
    console[n] = (...a) => lines.push(a.join(' '));
  }
  return {
    lines,
    restore() {
      for (const n of names) console[n] = orig[n];
    },
  };
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

test('a successful refresh returns normalized token data with a calculated expiry', async () => {
  const f = fakeFetch(fakeResponse({ body: goodBody({ scopes: ['oauth', 'crm.objects.contacts.read'], hub_id: 4242, user_id: 7 }) }));
  const result = await makeClient(f).refreshAccessToken(OLD_REFRESH);
  assert.deepEqual(result, {
    accessToken: NEW_ACCESS,
    refreshToken: NEW_REFRESH,
    expiresIn: 1800,
    expiresAt: NOW + 1800 * 1000,
    scopes: ['oauth', 'crm.objects.contacts.read'],
    hubId: 4242,
  });
});

test('optional fields are normalized when missing or invalid (they never cause a failure)', async () => {
  const f = fakeFetch(fakeResponse({ body: goodBody({ scopes: 'not-an-array', hub_id: 'abc' }) }));
  const result = await makeClient(f).refreshAccessToken(OLD_REFRESH);
  assert.deepEqual(result.scopes, []);
  assert.equal(result.hubId, null);
});

test('the request has the exact endpoint, method, headers and form body', async () => {
  const f = fakeFetch(fakeResponse({ body: goodBody() }));
  await makeClient(f).refreshAccessToken(OLD_REFRESH);

  assert.equal(f.calls.length, 1);
  const { url, init } = f.calls[0];
  assert.equal(url, 'https://api.hubapi.com/oauth/v3/token');
  assert.equal(url, HUBSPOT_TOKEN_URL);
  assert.equal(init.method, 'POST');
  assert.deepEqual(init.headers, {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  });
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal && typeof init.signal.aborted === 'boolean', 'an abort signal is passed');

  assert.equal(typeof init.body, 'string');
  const form = new URLSearchParams(init.body);
  assert.deepEqual([...form.keys()].sort(), ['client_id', 'client_secret', 'grant_type', 'refresh_token']);
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('client_id'), CLIENT_ID);
  assert.equal(form.get('client_secret'), CLIENT_SECRET);
  assert.equal(form.get('refresh_token'), OLD_REFRESH);

  // Credentials are only in the body: never in the URL, never an Authorization header.
  for (const secret of [CLIENT_ID, CLIENT_SECRET, OLD_REFRESH]) assert.ok(!url.includes(secret));
  assert.ok(!Object.keys(init.headers).some((h) => /authorization/i.test(h)));
});

test('special characters in credentials are form-encoded correctly', async () => {
  const f = fakeFetch(fakeResponse({ body: goodBody() }));
  const client = createHubspotTokenClient({
    fetchImpl: f,
    env: { HUBSPOT_CLIENT_ID: 'id&x=1', HUBSPOT_CLIENT_SECRET: 's e+c=ret/%' },
    now: () => NOW,
  });
  await client.refreshAccessToken('refresh&token=1');
  const form = new URLSearchParams(f.calls[0].init.body);
  assert.equal(form.get('client_id'), 'id&x=1');
  assert.equal(form.get('client_secret'), 's e+c=ret/%');
  assert.equal(form.get('refresh_token'), 'refresh&token=1');
  assert.equal([...form.keys()].length, 4);
});

test('the environment is read at call time (a later change is picked up)', async () => {
  const env = { HUBSPOT_CLIENT_ID: '', HUBSPOT_CLIENT_SECRET: '' };
  const f = fakeFetch(fakeResponse({ body: goodBody() }));
  const client = createHubspotTokenClient({ fetchImpl: f, env, now: () => NOW });
  await assertFails(client.refreshAccessToken(OLD_REFRESH), 'CONFIG_MISSING');
  env.HUBSPOT_CLIENT_ID = CLIENT_ID;
  env.HUBSPOT_CLIENT_SECRET = CLIENT_SECRET;
  assert.equal((await client.refreshAccessToken(OLD_REFRESH)).accessToken, NEW_ACCESS);
});

// ---------------------------------------------------------------------------
// Refresh token present / absent
// ---------------------------------------------------------------------------

test('a missing refresh_token in the response is handled safely (null = keep the old one)', async () => {
  for (const mutate of [(b) => delete b.refresh_token, (b) => (b.refresh_token = null)]) {
    const body = goodBody();
    mutate(body);
    const result = await makeClient(fakeFetch(fakeResponse({ body }))).refreshAccessToken(OLD_REFRESH);
    assert.equal(result.refreshToken, null);
    assert.equal(result.accessToken, NEW_ACCESS);
  }
});

test('a rotated refresh token is returned as given', async () => {
  const result = await makeClient(fakeFetch(fakeResponse({ body: goodBody() }))).refreshAccessToken(OLD_REFRESH);
  assert.equal(result.refreshToken, NEW_REFRESH);
});

// ---------------------------------------------------------------------------
// Invalid successful responses
// ---------------------------------------------------------------------------

test('invalid access_token values are rejected', async () => {
  for (const access_token of [undefined, null, '', 123, {}, ['x'], 'has space', 'new\nline', 'tab\tchar', 'é-non-ascii', 'x'.repeat(8193)]) {
    const f = fakeFetch(fakeResponse({ body: goodBody({ access_token }) }));
    await assertFails(makeClient(f).refreshAccessToken(OLD_REFRESH), 'INVALID_RESPONSE', { retryable: true, reauthRequired: false });
  }
});

test('invalid expires_in values are rejected', async () => {
  const bad = [undefined, null, '1800', 0, -1, 59, 604801, 1800.5, Infinity, -Infinity, NaN, true, {}];
  for (const expires_in of bad) {
    const body = goodBody();
    if (expires_in === undefined) delete body.expires_in;
    else body.expires_in = expires_in;
    await assertFails(makeClient(fakeFetch(fakeResponse({ body }))).refreshAccessToken(OLD_REFRESH), 'INVALID_RESPONSE');
  }
  // The boundaries themselves are accepted.
  for (const expires_in of [60, 604800]) {
    const r = await makeClient(fakeFetch(fakeResponse({ body: goodBody({ expires_in }) }))).refreshAccessToken(OLD_REFRESH);
    assert.equal(r.expiresIn, expires_in);
  }
});

test('an invalid refresh_token (present but unusable) is rejected', async () => {
  for (const refresh_token of ['', 42, {}, [], 'has space', 'x'.repeat(8193)]) {
    await assertFails(
      makeClient(fakeFetch(fakeResponse({ body: goodBody({ refresh_token }) }))).refreshAccessToken(OLD_REFRESH),
      'INVALID_RESPONSE'
    );
  }
});

test('bodies that are not JSON objects are rejected', async () => {
  for (const body of ['[]', '"just a string"', 'null', '42', '[{"access_token":"a"}]']) {
    const code = 'INVALID_RESPONSE';
    await assertFails(makeClient(fakeFetch(fakeResponse({ body }))).refreshAccessToken(OLD_REFRESH), code);
  }
});

test('invalid JSON, empty and oversized bodies on success are rejected as INVALID_JSON', async () => {
  for (const body of ['not json at all', '{"access_token": ', '', '<html>oops</html>', 'x'.repeat(100_001)]) {
    await assertFails(makeClient(fakeFetch(fakeResponse({ body }))).refreshAccessToken(OLD_REFRESH), 'INVALID_JSON', {
      retryable: true,
      httpStatus: 200,
    });
  }
});

test('an unreadable success body or a response without status/text is handled', async () => {
  await assertFails(
    makeClient(fakeFetch(fakeResponse({ textError: new Error('socket hang up') }))).refreshAccessToken(OLD_REFRESH),
    'NETWORK_ERROR'
  );
  for (const weird of [undefined, null, {}, { status: '200' }, { status: 200 }]) {
    await assertFails(makeClient(fakeFetch(weird)).refreshAccessToken(OLD_REFRESH), 'INVALID_RESPONSE');
  }
  // 3xx (redirects are refused by fetch itself; a stub could still return one).
  await assertFails(makeClient(fakeFetch(fakeResponse({ status: 302 }))).refreshAccessToken(OLD_REFRESH), 'INVALID_RESPONSE');
});

// ---------------------------------------------------------------------------
// HTTP errors
// ---------------------------------------------------------------------------

test('HTTP 400 and 401 with invalid_grant (or BAD_REFRESH_TOKEN) mean "authorize again"', async () => {
  for (const status of [400, 401]) {
    for (const body of [{ error: 'invalid_grant' }, { status: 'BAD_REFRESH_TOKEN', message: 'missing or unknown refresh token' }]) {
      const err = await assertFails(makeClient(fakeFetch(fakeResponse({ status, body }))).refreshAccessToken(OLD_REFRESH), 'INVALID_GRANT', {
        httpStatus: status,
        retryable: false,
        reauthRequired: true,
      });
      assert.equal(err.retryAfterMs, null);
    }
  }
});

test('HTTP 400 and 401 with invalid_client mean the app credentials are wrong (no re-authorization)', async () => {
  for (const status of [400, 401]) {
    for (const error of ['invalid_client', 'unauthorized_client']) {
      await assertFails(makeClient(fakeFetch(fakeResponse({ status, body: { error } }))).refreshAccessToken(OLD_REFRESH), 'INVALID_CLIENT', {
        httpStatus: status,
        retryable: false,
        reauthRequired: false,
      });
    }
  }
});

test('other 4xx responses (and unreadable error bodies) are REQUEST_REJECTED and never ask for re-authorization', async () => {
  const cases = [
    [400, { error: 'invalid_request' }],
    [400, 'garbage'],
    [400, ''],
    [401, { message: 'something' }],
    [403, { error: 'invalid_grant' }], // only 400/401 are treated as grant errors
    [404, {}],
    [410, 'x'],
  ];
  for (const [status, body] of cases) {
    await assertFails(makeClient(fakeFetch(fakeResponse({ status, body }))).refreshAccessToken(OLD_REFRESH), 'REQUEST_REJECTED', {
      httpStatus: status,
      retryable: false,
      reauthRequired: false,
    });
  }
  // The error body cannot even be read.
  await assertFails(
    makeClient(fakeFetch(fakeResponse({ status: 400, textError: new Error('boom') }))).refreshAccessToken(OLD_REFRESH),
    'REQUEST_REJECTED'
  );
});

test('HTTP 429 is retryable and exposes a safe Retry-After', async () => {
  const withHeader = await assertFails(
    makeClient(fakeFetch(fakeResponse({ status: 429, headers: { 'retry-after': '30' } }))).refreshAccessToken(OLD_REFRESH),
    'RATE_LIMITED',
    { httpStatus: 429, retryable: true, reauthRequired: false, retryAfterMs: 30_000 }
  );
  assert.ok(withHeader);
  for (const hostile of [undefined, '', 'abc', '-5', '1.5', '3601', '99999', 'Wed, 21 Oct 2026 07:28:00 GMT', '30; DROP']) {
    const headers = hostile === undefined ? {} : { 'retry-after': hostile };
    await assertFails(makeClient(fakeFetch(fakeResponse({ status: 429, headers }))).refreshAccessToken(OLD_REFRESH), 'RATE_LIMITED', {
      retryAfterMs: null,
    });
  }
});

test('HTTP 5xx and 408 are retryable server errors', async () => {
  for (const status of [500, 502, 503, 504, 599, 408]) {
    await assertFails(
      makeClient(fakeFetch(fakeResponse({ status, body: { message: 'internal detail' } }))).refreshAccessToken(OLD_REFRESH),
      'SERVER_ERROR',
      { httpStatus: status, retryable: true, reauthRequired: false }
    );
  }
});

// ---------------------------------------------------------------------------
// Network failures and timeouts
// ---------------------------------------------------------------------------

test('network failures are retryable NETWORK_ERRORs, whatever fetch throws', async () => {
  const failures = [
    async () => {
      throw new TypeError('fetch failed');
    },
    () => Promise.reject(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })),
    () => {
      throw new Error('synchronous failure');
    },
    () => Promise.reject('a plain string'),
    () => Promise.reject(undefined),
  ];
  for (const fn of failures) {
    await assertFails(makeClient(fn).refreshAccessToken(OLD_REFRESH), 'NETWORK_ERROR', { retryable: true, reauthRequired: false, httpStatus: null });
  }
});

test('a refused redirect (fetch throws) is a NETWORK_ERROR', async () => {
  const f = async () => {
    throw new TypeError('fetch failed: unexpected redirect');
  };
  await assertFails(makeClient(f).refreshAccessToken(OLD_REFRESH), 'NETWORK_ERROR');
});

test('a request that never answers times out (fetch honours the abort signal)', async () => {
  let aborted = false;
  const f = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        aborted = true;
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      });
    });
  const started = Date.now();
  await assertFails(makeClient(f, { timeoutMs: 30 }).refreshAccessToken(OLD_REFRESH), 'TIMEOUT', { retryable: true, reauthRequired: false });
  assert.ok(Date.now() - started < 2000, 'must not wait for the default timeout');
  assert.equal(aborted, true);
});

test('a fetch that ignores the abort signal still times out', async () => {
  const f = () => new Promise(() => {}); // never settles
  await assertFails(makeClient(f, { timeoutMs: 30 }).refreshAccessToken(OLD_REFRESH), 'TIMEOUT');
});

test('a body that stalls while being read times out', async () => {
  const f = fakeFetch({
    status: 200,
    headers: { get: () => null },
    text: () => new Promise(() => {}),
  });
  await assertFails(makeClient(f, { timeoutMs: 30 }).refreshAccessToken(OLD_REFRESH), 'TIMEOUT');
});

test('a fast response is not affected by the timeout and the timer is cleaned up', async () => {
  const result = await makeClient(fakeFetch(fakeResponse({ body: goodBody() })), { timeoutMs: 50 }).refreshAccessToken(OLD_REFRESH);
  assert.equal(result.accessToken, NEW_ACCESS);
  await new Promise((resolve) => setTimeout(resolve, 120)); // a leftover timer would fire here and fail the process
});

test('the timeout setting is validated', () => {
  for (const timeoutMs of [0, -1, 1.5, '100', NaN, Infinity, 60_001]) {
    assert.throws(() => makeClient(fakeFetch(fakeResponse()), { timeoutMs }), (err) => err instanceof HubspotTokenError && err.code === 'INVALID_INPUT');
  }
  assert.doesNotThrow(() => makeClient(fakeFetch(fakeResponse()), { timeoutMs: 1 }));
  assert.doesNotThrow(() => makeClient(fakeFetch(fakeResponse()), { timeoutMs: 60_000 }));
});

// ---------------------------------------------------------------------------
// Configuration / input errors: no request is made
// ---------------------------------------------------------------------------

test('missing credentials or refresh token fail before any request is made', async () => {
  const f = fakeFetch(fakeResponse({ body: goodBody() }));
  for (const env of [{}, { HUBSPOT_CLIENT_ID: CLIENT_ID }, { HUBSPOT_CLIENT_SECRET: CLIENT_SECRET }, { HUBSPOT_CLIENT_ID: '', HUBSPOT_CLIENT_SECRET: '' }, { HUBSPOT_CLIENT_ID: 5, HUBSPOT_CLIENT_SECRET: {} }, null]) {
    const client = createHubspotTokenClient({ fetchImpl: f, env, now: () => NOW });
    await assertFails(client.refreshAccessToken(OLD_REFRESH), 'CONFIG_MISSING', { retryable: false, reauthRequired: false, httpStatus: null });
  }
  for (const token of ['', undefined, null, 42, {}, []]) {
    await assertFails(makeClient(f).refreshAccessToken(token), 'INVALID_INPUT', { retryable: false });
  }
  assert.equal(f.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Nothing sensitive leaks
// ---------------------------------------------------------------------------

test('errors never contain credentials, tokens, response bodies or raw fetch messages', async () => {
  const LEAK_BODY = 'LEAKY-RESPONSE-BODY-do-not-show';
  const LEAK_FETCH = 'LEAKY-FETCH-MESSAGE-do-not-show';
  const secrets = [CLIENT_ID, CLIENT_SECRET, OLD_REFRESH, NEW_ACCESS, NEW_REFRESH, LEAK_BODY, LEAK_FETCH, 'grant_type', 'client_secret=', 'api.hubapi.com'];

  const scenarios = [
    fakeFetch(fakeResponse({ status: 400, body: { error: 'invalid_grant', error_description: LEAK_BODY, refresh_token: OLD_REFRESH } })),
    fakeFetch(fakeResponse({ status: 401, body: { error: 'invalid_client', message: LEAK_BODY } })),
    fakeFetch(fakeResponse({ status: 403, body: { message: LEAK_BODY, access_token: NEW_ACCESS } })),
    fakeFetch(fakeResponse({ status: 429, body: { message: LEAK_BODY } })),
    fakeFetch(fakeResponse({ status: 500, body: { message: LEAK_BODY } })),
    fakeFetch(fakeResponse({ status: 200, body: `${LEAK_BODY} ${NEW_ACCESS} not json` })),
    fakeFetch(fakeResponse({ status: 200, body: { access_token: NEW_ACCESS, expires_in: 'soon', message: LEAK_BODY } })),
    async () => {
      throw Object.assign(new Error(`${LEAK_FETCH} ${CLIENT_SECRET} ${OLD_REFRESH}`), { code: 'ECONNRESET' });
    },
    fakeFetch(fakeResponse({ textError: new Error(`${LEAK_FETCH} ${NEW_ACCESS}`) })),
  ];

  const cap = captureConsole();
  let errors;
  try {
    errors = [];
    for (const f of scenarios) errors.push(await failure(makeClient(f).refreshAccessToken(OLD_REFRESH)));
    // A timeout whose abort error carries secrets.
    errors.push(
      await failure(
        makeClient(
          (url, init) =>
            new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error(`${LEAK_FETCH} ${CLIENT_SECRET}`)))),
          { timeoutMs: 20 }
        ).refreshAccessToken(OLD_REFRESH)
      )
    );
    // Also a successful call must stay silent.
    await makeClient(fakeFetch(fakeResponse({ body: goodBody() }))).refreshAccessToken(OLD_REFRESH);
  } finally {
    cap.restore();
  }

  assert.deepEqual(cap.lines, [], 'nothing may be written to the console');
  assert.equal(errors.length, 10);
  for (const err of errors) {
    assert.ok(err instanceof HubspotTokenError);
    assert.equal(err.cause, undefined);
    const text = [err.message, err.stack, JSON.stringify(err), String(err), err.code, Object.keys(err).join(',')].join('\n');
    for (const secret of secrets) assert.ok(!text.includes(secret), `error text leaked "${secret}"`);
  }
});

test('error messages are fixed per code', async () => {
  const a = await failure(makeClient(fakeFetch(fakeResponse({ status: 500, body: { message: 'first' } }))).refreshAccessToken(OLD_REFRESH));
  const b = await failure(makeClient(fakeFetch(fakeResponse({ status: 503, body: { message: 'second' } }))).refreshAccessToken(OLD_REFRESH));
  assert.equal(a.message, b.message);
  assert.equal(a.code, 'SERVER_ERROR');
});

test('the client never uses the real network when a stub is given', async () => {
  const realFetch = globalThis.fetch;
  let realCalls = 0;
  globalThis.fetch = () => {
    realCalls += 1;
    throw new Error('real fetch must not be used');
  };
  try {
    await makeClient(fakeFetch(fakeResponse({ body: goodBody() }))).refreshAccessToken(OLD_REFRESH);
    assert.equal(realCalls, 0);
    // Without a stub it would use globalThis.fetch (here replaced, so still no network).
    const defaultClient = createHubspotTokenClient({ env: ENV, now: () => NOW });
    await assertFails(defaultClient.refreshAccessToken(OLD_REFRESH), 'NETWORK_ERROR');
    assert.equal(realCalls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
