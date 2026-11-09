// tests/token-service.test.js
//
// Tests src/oauth/tokenService.js (Phase 3, step 4).
// The real encrypted tokenStore is used (in-memory or temporary files) with a random
// key and a fake clock. The HubSpot client is ALWAYS a stub: no network request is
// made. Only fake tokens are used. .env is never read.
//
// Run with:  node --test tests/token-service.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  createTokenService,
  TokenServiceError,
  getTokenService,
  closeTokenService,
  getValidAccessToken,
  saveAuthorizedTokens,
} = require('../src/oauth/tokenService');
const { createTokenStore, TokenStoreError } = require('../src/oauth/tokenStore');
const { HubspotTokenError } = require('../src/oauth/hubspotTokenClient');
const { KEY_ENV_VAR } = require('../src/security/tokenCrypto');

const PORTAL = 4242;
const START = 1_800_000_000_000; // fake "now"
const MIN = 60 * 1000;
const ACCESS = 'fake-access-token-AAAA-1111';
const REFRESH = 'fake-refresh-token-RRRR-2222';
const NEW_ACCESS = 'fake-NEW-access-token-3333';
const NEW_REFRESH = 'fake-NEW-refresh-token-4444';

const newKey = () => crypto.randomBytes(32);
const tmpDb = (label) => path.join(os.tmpdir(), `${label}-${crypto.randomBytes(6).toString('hex')}.db`);
const removeDb = (p) => ['', '-wal', '-shm'].forEach((s) => fs.rmSync(p + s, { force: true }));

// A fake clock, a real store, a stub client and the service wired together.
function setup({ expiresIn = 30 * MIN, dbPath = ':memory:', key = newKey(), serviceOptions = {}, seed = true } = {}) {
  const clock = { now: START };
  const now = () => clock.now;
  const store = createTokenStore(dbPath, { key, now });
  const client = {
    calls: [],
    refreshAccessToken: async () => {
      throw new Error('stub client: no behaviour set');
    },
  };
  // Wrap so every call is recorded, whatever behaviour a test installs.
  const behaviour = { fn: null };
  client.refreshAccessToken = async (refreshToken) => {
    client.calls.push(refreshToken);
    return behaviour.fn(refreshToken);
  };
  const service = createTokenService({ store, client, now, ...serviceOptions });
  if (seed) store.save({ portalId: PORTAL, accessToken: ACCESS, refreshToken: REFRESH, expiresAt: START + expiresIn, scopes: ['oauth'] });
  const refreshed = (extra = {}) => ({
    accessToken: NEW_ACCESS,
    refreshToken: NEW_REFRESH,
    expiresIn: 1800,
    expiresAt: clock.now + 1800 * 1000,
    scopes: [],
    hubId: PORTAL,
    ...extra,
  });
  return { clock, store, client, service, behaviour, refreshed, key, now };
}

async function expectError(promise, code, expected = {}) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof TokenServiceError, `expected TokenServiceError, got ${err && err.name}`);
    assert.equal(err.code, code);
    for (const [k, v] of Object.entries(expected)) assert.deepEqual(err[k], v, k);
    return err;
  }
  assert.fail(`expected ${code}`);
  return null;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
// 1. A valid token is returned without a refresh
// ---------------------------------------------------------------------------

test('a token with more than 5 minutes left is returned without calling HubSpot', async () => {
  const t = setup({ expiresIn: 5 * MIN + 1 });
  assert.equal(await t.service.getValidAccessToken(PORTAL), ACCESS);
  assert.equal(t.client.calls.length, 0);
  t.clock.now += 1; // now exactly 5 minutes left: that is "within 5 minutes"
  t.behaviour.fn = async () => t.refreshed();
  assert.equal(await t.service.getValidAccessToken(PORTAL), NEW_ACCESS);
  assert.equal(t.client.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 2. Refresh of expiring / expired tokens
// ---------------------------------------------------------------------------

test('an expiring token (under 5 minutes) is refreshed and the new token is stored', async () => {
  const t = setup({ expiresIn: 4 * MIN });
  t.behaviour.fn = async () => t.refreshed();
  assert.equal(await t.service.getValidAccessToken(PORTAL), NEW_ACCESS);
  assert.deepEqual(t.client.calls, [REFRESH]); // the stored refresh token was sent

  const c = t.store.get(PORTAL);
  assert.equal(c.accessToken, NEW_ACCESS);
  assert.equal(c.accessExpiresAt, START + 1800 * 1000);
  assert.equal(c.rowVersion, 2);
  assert.equal(c.status, 'active');

  // The next call needs no refresh any more.
  assert.equal(await t.service.getValidAccessToken(PORTAL), NEW_ACCESS);
  assert.equal(t.client.calls.length, 1);
});

test('an already expired token is refreshed', async () => {
  const t = setup({ expiresIn: -10 * MIN });
  t.behaviour.fn = async () => t.refreshed();
  assert.equal(await t.service.getValidAccessToken(PORTAL), NEW_ACCESS);
  assert.equal(t.client.calls.length, 1);
});

test('time passing makes a valid token expiring, which triggers exactly one refresh', async () => {
  const t = setup({ expiresIn: 30 * MIN });
  t.behaviour.fn = async () => t.refreshed();
  assert.equal(await t.service.getValidAccessToken(PORTAL), ACCESS);
  t.clock.now += 26 * MIN; // 4 minutes left
  assert.equal(await t.service.getValidAccessToken(PORTAL), NEW_ACCESS);
  assert.equal(await t.service.getValidAccessToken(PORTAL), NEW_ACCESS);
  assert.equal(t.client.calls.length, 1);
});

// ---------------------------------------------------------------------------
// 3. Refresh token preservation / rotation
// ---------------------------------------------------------------------------

test('the stored refresh token is kept when HubSpot sends no new one', async () => {
  const t = setup({ expiresIn: 1 * MIN });
  t.behaviour.fn = async () => t.refreshed({ refreshToken: null });
  await t.service.getValidAccessToken(PORTAL);
  assert.equal(t.store.get(PORTAL).refreshToken, REFRESH);

  // ...and it is the old one that is used for the next refresh.
  t.clock.now += 40 * MIN;
  await t.service.getValidAccessToken(PORTAL);
  assert.deepEqual(t.client.calls, [REFRESH, REFRESH]);
});

test('a rotated refresh token replaces the old one and is used next time', async () => {
  const t = setup({ expiresIn: 1 * MIN });
  t.behaviour.fn = async () => t.refreshed();
  await t.service.getValidAccessToken(PORTAL);
  assert.equal(t.store.get(PORTAL).refreshToken, NEW_REFRESH);

  t.clock.now += 40 * MIN;
  t.behaviour.fn = async () => t.refreshed({ accessToken: 'fake-access-5555', refreshToken: 'fake-refresh-6666' });
  await t.service.getValidAccessToken(PORTAL);
  assert.deepEqual(t.client.calls, [REFRESH, NEW_REFRESH]);
  assert.equal(t.store.get(PORTAL).refreshToken, 'fake-refresh-6666');
});

test('scopes are kept when HubSpot sends none, and updated when it does', async () => {
  const t = setup({ expiresIn: 1 * MIN });
  t.behaviour.fn = async () => t.refreshed({ scopes: [] });
  await t.service.getValidAccessToken(PORTAL);
  assert.deepEqual(t.store.get(PORTAL).scopes, ['oauth']);

  t.clock.now += 40 * MIN;
  t.behaviour.fn = async () => t.refreshed({ scopes: ['oauth', 'crm.objects.contacts.read'] });
  await t.service.getValidAccessToken(PORTAL);
  assert.deepEqual(t.store.get(PORTAL).scopes, ['oauth', 'crm.objects.contacts.read']);
});

// ---------------------------------------------------------------------------
// 4. Concurrent callers share one refresh
// ---------------------------------------------------------------------------

test('20 concurrent callers share ONE refresh: one HubSpot call, one store write', async () => {
  const t = setup({ expiresIn: 1 * MIN });
  const gate = deferred();
  t.behaviour.fn = () => gate.promise;

  const callers = Array.from({ length: 20 }, () => t.service.getValidAccessToken(PORTAL));
  await tick();
  assert.equal(t.client.calls.length, 1, 'only one request while the refresh is in flight');
  gate.resolve(t.refreshed());

  const tokens = await Promise.all(callers);
  assert.deepEqual([...new Set(tokens)], [NEW_ACCESS]);
  assert.equal(t.client.calls.length, 1);
  assert.equal(t.store.get(PORTAL).rowVersion, 2); // written once

  // Afterwards a later expiry starts a fresh, separate refresh.
  t.clock.now += 40 * MIN;
  t.behaviour.fn = async () => t.refreshed({ accessToken: 'fake-access-7777' });
  assert.equal(await t.service.getValidAccessToken(PORTAL), 'fake-access-7777');
  assert.equal(t.client.calls.length, 2);
});

test('a failed shared refresh fails every waiting caller the same way and then clears', async () => {
  const t = setup({ expiresIn: -1 * MIN });
  const gate = deferred();
  t.behaviour.fn = () => gate.promise;
  const callers = Array.from({ length: 5 }, () => t.service.getValidAccessToken(PORTAL).then(() => 'ok', (e) => e));
  await tick();
  gate.reject(new HubspotTokenError('SERVER_ERROR', { httpStatus: 503 }));
  const results = await Promise.all(callers);
  for (const r of results) {
    assert.ok(r instanceof TokenServiceError);
    assert.equal(r.code, 'REFRESH_FAILED');
  }
  assert.equal(t.client.calls.length, 1);
});

test('different portals refresh independently', async () => {
  const t = setup({ expiresIn: 1 * MIN });
  t.store.save({ portalId: 999, accessToken: 'fake-access-999', refreshToken: 'fake-refresh-999', expiresAt: START + 1 * MIN });
  t.behaviour.fn = async (refreshToken) =>
    t.refreshed({ accessToken: `new-for-${refreshToken}`, refreshToken: null });
  const [a, b] = await Promise.all([t.service.getValidAccessToken(PORTAL), t.service.getValidAccessToken('999')]);
  assert.equal(a, `new-for-${REFRESH}`);
  assert.equal(b, 'new-for-fake-refresh-999');
  assert.equal(t.client.calls.length, 2);
});

// ---------------------------------------------------------------------------
// 5. Stale versions / concurrent processes
// ---------------------------------------------------------------------------

test('another process refreshed first: our stale result is discarded and its token is used', async () => {
  const dbPath = tmpDb('svc-conflict');
  const key = newKey();
  const t = setup({ expiresIn: 1 * MIN, dbPath, key });
  const other = createTokenStore(dbPath, { key, now: t.now });
  try {
    t.behaviour.fn = async () => {
      // While our request is "in flight", a second process stores a fresh pair.
      const v = other.get(PORTAL).rowVersion;
      assert.equal(other.update(PORTAL, v, { accessToken: 'winner-access', refreshToken: 'winner-refresh', expiresAt: START + 30 * MIN }).updated, true);
      return t.refreshed({ accessToken: 'loser-access', refreshToken: 'loser-refresh' });
    };
    assert.equal(await t.service.getValidAccessToken(PORTAL), 'winner-access');
    assert.equal(t.client.calls.length, 1, 'no second HubSpot call is needed');
    const c = t.store.get(PORTAL);
    assert.equal(c.accessToken, 'winner-access');
    assert.equal(c.refreshToken, 'winner-refresh'); // the loser never overwrote it
  } finally {
    t.store.close();
    other.close();
    removeDb(dbPath);
  }
});

test('if the winner is also expiring, a second attempt refreshes again; endless conflicts end in REFRESH_CONFLICT', async () => {
  const dbPath = tmpDb('svc-conflict2');
  const key = newKey();
  const t = setup({ expiresIn: 1 * MIN, dbPath, key });
  const other = createTokenStore(dbPath, { key, now: t.now });
  try {
    let calls = 0;
    t.behaviour.fn = async () => {
      calls += 1;
      if (calls === 1) {
        other.update(PORTAL, other.get(PORTAL).rowVersion, { accessToken: 'winner-1', expiresAt: START + 2 * MIN });
        return t.refreshed({ accessToken: 'loser-1' });
      }
      return t.refreshed({ accessToken: 'second-attempt' });
    };
    assert.equal(await t.service.getValidAccessToken(PORTAL), 'second-attempt');
    assert.equal(calls, 2);

    // Now somebody changes the row during EVERY attempt.
    t.clock.now += 40 * MIN;
    t.behaviour.fn = async () => {
      other.update(PORTAL, other.get(PORTAL).rowVersion, { accessToken: 'winner-again', expiresAt: t.clock.now + 1 * MIN });
      return t.refreshed({ accessToken: 'never-stored' });
    };
    const before = t.client.calls.length;
    const err = await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_CONFLICT', { retryable: true });
    assert.ok(err);
    assert.equal(t.client.calls.length - before, 2, 'bounded to two attempts');
    assert.notEqual(t.store.get(PORTAL).accessToken, 'never-stored');
  } finally {
    t.store.close();
    other.close();
    removeDb(dbPath);
  }
});

test('a new authorization saved during a refresh wins; the older refresh result is discarded', async () => {
  const t = setup({ expiresIn: 1 * MIN });
  const gate = deferred();
  t.behaviour.fn = () => gate.promise;
  const pending = t.service.getValidAccessToken(PORTAL);
  await tick();

  await t.service.saveAuthorizedTokens({ portalId: PORTAL, accessToken: 'reauthorized-access', refreshToken: 'reauthorized-refresh', expiresIn: 1800 });
  gate.resolve(t.refreshed({ accessToken: 'late-access', refreshToken: 'late-refresh' }));

  assert.equal(await pending, 'reauthorized-access');
  const c = t.store.get(PORTAL);
  assert.equal(c.accessToken, 'reauthorized-access');
  assert.equal(c.refreshToken, 'reauthorized-refresh');
});

// ---------------------------------------------------------------------------
// 6. Permanent invalid refresh token
// ---------------------------------------------------------------------------

test('a rejected refresh token marks the connection needs_reauth and keeps the tokens', async () => {
  const t = setup({ expiresIn: -1 * MIN });
  t.behaviour.fn = async () => {
    throw new HubspotTokenError('INVALID_GRANT', { httpStatus: 400 });
  };
  const err = await expectError(t.service.getValidAccessToken(PORTAL), 'REAUTH_REQUIRED', { reauthRequired: true, retryable: false, reason: 'INVALID_GRANT' });
  assert.ok(err);

  const s = t.store.getStatus(PORTAL);
  assert.equal(s.status, 'needs_reauth');
  assert.equal(s.lastError, 'INVALID_GRANT');
  assert.equal(t.store.get(PORTAL).refreshToken, REFRESH); // not deleted

  // No further HubSpot calls, even long afterwards.
  t.clock.now += 24 * 60 * MIN;
  await expectError(t.service.getValidAccessToken(PORTAL), 'REAUTH_REQUIRED');
  assert.equal(t.client.calls.length, 1);
});

test('a still-valid access token is not handed out once the connection needs re-authorization', async () => {
  const t = setup({ expiresIn: 60 * MIN });
  t.store.markNeedsReauth(PORTAL, 'INVALID_GRANT');
  await expectError(t.service.getValidAccessToken(PORTAL), 'REAUTH_REQUIRED');
  assert.equal(t.client.calls.length, 0);
});

test('authorizing again recovers a needs_reauth connection', async () => {
  const t = setup({ expiresIn: -1 * MIN });
  t.behaviour.fn = async () => {
    throw new HubspotTokenError('INVALID_GRANT', { httpStatus: 400 });
  };
  await expectError(t.service.getValidAccessToken(PORTAL), 'REAUTH_REQUIRED');

  const saved = await t.service.saveAuthorizedTokens({ portalId: PORTAL, accessToken: 'again-access', refreshToken: 'again-refresh', expiresIn: 1800, scopes: ['oauth'] });
  assert.deepEqual(Object.keys(saved).sort(), ['portalId', 'rowVersion']);
  assert.equal(await t.service.getValidAccessToken(PORTAL), 'again-access');
  assert.equal(t.store.getStatus(PORTAL).status, 'active');
});

test('needs_reauth is only recorded if the row is still the one we tried to refresh', async () => {
  const dbPath = tmpDb('svc-reauth-cas');
  const key = newKey();
  const t = setup({ expiresIn: 1 * MIN, dbPath, key });
  const other = createTokenStore(dbPath, { key, now: t.now });
  try {
    t.behaviour.fn = async () => {
      // A new authorization lands while HubSpot is rejecting the old refresh token.
      other.save({ portalId: PORTAL, accessToken: 'brand-new-access', refreshToken: 'brand-new-refresh', expiresAt: START + 30 * MIN });
      throw new HubspotTokenError('INVALID_GRANT', { httpStatus: 400 });
    };
    assert.equal(await t.service.getValidAccessToken(PORTAL), 'brand-new-access');
    assert.equal(t.store.getStatus(PORTAL).status, 'active');
  } finally {
    t.store.close();
    other.close();
    removeDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 7. Temporary failures
// ---------------------------------------------------------------------------

const TEMPORARY = [
  ['NETWORK_ERROR', {}],
  ['TIMEOUT', {}],
  ['RATE_LIMITED', { httpStatus: 429 }],
  ['RATE_LIMITED', { httpStatus: 429, retryAfterMs: 20_000 }],
  ['SERVER_ERROR', { httpStatus: 500 }],
  ['SERVER_ERROR', { httpStatus: 503 }],
  ['INVALID_JSON', { httpStatus: 200 }],
  ['INVALID_RESPONSE', { httpStatus: 200 }],
];

test('temporary failures never destroy stored tokens', async () => {
  for (const [code, opts] of TEMPORARY) {
    const t = setup({ expiresIn: -1 * MIN });
    t.behaviour.fn = async () => {
      throw new HubspotTokenError(code, opts);
    };
    const err = await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_FAILED', { retryable: true, reauthRequired: false, reason: code });
    assert.ok(Number.isInteger(err.retryAfterMs) && err.retryAfterMs >= 1000);

    const c = t.store.get(PORTAL);
    assert.equal(c.accessToken, ACCESS);
    assert.equal(c.refreshToken, REFRESH);
    assert.equal(c.status, 'active');
    assert.equal(c.rowVersion, 1);
  }
});

test('an EXPIRED access token is never returned after a failed refresh', async () => {
  for (const [code, opts] of TEMPORARY) {
    const t = setup({ expiresIn: -1 });
    t.behaviour.fn = async () => {
      throw new HubspotTokenError(code, opts);
    };
    await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_FAILED');
  }
  // Also not when the token has less than the 30 second safety margin left.
  const t = setup({ expiresIn: 29_000 });
  t.behaviour.fn = async () => {
    throw new HubspotTokenError('NETWORK_ERROR');
  };
  await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_FAILED');
});

test('a token that is not expired yet is still returned when the refresh fails temporarily', async () => {
  for (const [code, opts] of TEMPORARY) {
    const t = setup({ expiresIn: 4 * MIN }); // inside the 5 minute window, but still valid
    t.behaviour.fn = async () => {
      throw new HubspotTokenError(code, opts);
    };
    assert.equal(await t.service.getValidAccessToken(PORTAL), ACCESS);
    assert.equal(t.store.get(PORTAL).rowVersion, 1);
  }
});

// ---------------------------------------------------------------------------
// 8. Cooldown and recovery
// ---------------------------------------------------------------------------

test('after a temporary failure HubSpot is not called again until the cooldown ends', async () => {
  const t = setup({ expiresIn: -1 * MIN });
  t.behaviour.fn = async () => {
    throw new HubspotTokenError('SERVER_ERROR', { httpStatus: 503 });
  };
  const first = await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_FAILED', { retryAfterMs: 30_000 });
  assert.ok(first);
  assert.equal(t.client.calls.length, 1);
  assert.equal(t.service.getConnectionStatus(PORTAL).refreshCooldownUntil, START + 30_000);

  t.clock.now += 29_000;
  const cooling = await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_COOLDOWN', { retryable: true, retryAfterMs: 1000 });
  assert.ok(cooling);
  assert.equal(t.client.calls.length, 1, 'no HubSpot call during the cooldown');

  t.clock.now += 2_000; // cooldown over
  await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_FAILED');
  assert.equal(t.client.calls.length, 2);
});

test('during the cooldown a still-valid token keeps being served without HubSpot calls', async () => {
  const t = setup({ expiresIn: 4 * MIN });
  t.behaviour.fn = async () => {
    // HubSpot asks us to wait 5 minutes (the maximum), so the cooldown outlasts the token.
    throw new HubspotTokenError('RATE_LIMITED', { httpStatus: 429, retryAfterMs: 300_000 });
  };
  assert.equal(await t.service.getValidAccessToken(PORTAL), ACCESS);
  t.clock.now += 10_000;
  assert.equal(await t.service.getValidAccessToken(PORTAL), ACCESS);
  assert.equal(t.client.calls.length, 1);
  // ...but not once it has nearly expired.
  t.clock.now += 4 * MIN - 10_000 - 20_000; // 20 s left (< 30 s margin)
  await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_COOLDOWN');
});

test('the cooldown doubles with consecutive failures and is capped', async () => {
  const t = setup({ expiresIn: -10 * MIN });
  t.behaviour.fn = async () => {
    throw new HubspotTokenError('NETWORK_ERROR');
  };
  const delays = [];
  for (let i = 0; i < 7; i += 1) {
    const err = await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_FAILED');
    delays.push(err.retryAfterMs);
    t.clock.now += err.retryAfterMs + 1;
  }
  assert.deepEqual(delays, [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
});

test('Retry-After from HubSpot is honoured but always bounded', async () => {
  const cases = [
    [20_000, 20_000], // honoured
    [90_000, 90_000],
    [3_600_000, 300_000], // capped at 5 minutes
    [0, 1000], // floored at 1 second
    [5, 1000],
  ];
  for (const [retryAfterMs, expected] of cases) {
    const t = setup({ expiresIn: -1 * MIN });
    t.behaviour.fn = async () => {
      throw new HubspotTokenError('RATE_LIMITED', { httpStatus: 429, retryAfterMs });
    };
    await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_FAILED', { retryAfterMs: expected, reason: 'RATE_LIMITED' });
  }
});

test('recovery: after the cooldown a successful refresh resets the backoff', async () => {
  const t = setup({ expiresIn: -10 * MIN });
  t.behaviour.fn = async () => {
    throw new HubspotTokenError('NETWORK_ERROR');
  };
  const e1 = await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_FAILED');
  t.clock.now += e1.retryAfterMs + 1;
  const e2 = await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_FAILED');
  assert.equal(e2.retryAfterMs, 60_000);
  t.clock.now += e2.retryAfterMs + 1;

  t.behaviour.fn = async () => t.refreshed();
  assert.equal(await t.service.getValidAccessToken(PORTAL), NEW_ACCESS);
  assert.equal(t.service.getConnectionStatus(PORTAL).refreshCooldownUntil, null);

  // Fails again later: the pause starts from the beginning (30 s), not from 120 s.
  t.clock.now += 40 * MIN;
  t.behaviour.fn = async () => {
    throw new HubspotTokenError('NETWORK_ERROR');
  };
  await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_FAILED', { retryAfterMs: 30_000 });
});

test('a new authorization clears a running cooldown', async () => {
  const t = setup({ expiresIn: -1 * MIN });
  t.behaviour.fn = async () => {
    throw new HubspotTokenError('NETWORK_ERROR');
  };
  await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_FAILED');
  assert.ok(t.service.getConnectionStatus(PORTAL).refreshCooldownUntil);
  await t.service.saveAuthorizedTokens({ portalId: PORTAL, accessToken: 'fresh-access', refreshToken: 'fresh-refresh', expiresAt: START + 30 * MIN });
  assert.equal(t.service.getConnectionStatus(PORTAL).refreshCooldownUntil, null);
  assert.equal(await t.service.getValidAccessToken(PORTAL), 'fresh-access');
});

// ---------------------------------------------------------------------------
// 9. Other error mapping
// ---------------------------------------------------------------------------

test('rejected requests and misconfiguration are not retryable and never mark re-authorization', async () => {
  for (const [code, expected] of [
    ['REQUEST_REJECTED', 'REFRESH_REJECTED'],
    ['INVALID_CLIENT', 'REFRESH_REJECTED'],
    ['CONFIG_MISSING', 'REFRESH_MISCONFIGURED'],
  ]) {
    const t = setup({ expiresIn: -1 * MIN });
    t.behaviour.fn = async () => {
      throw new HubspotTokenError(code, { httpStatus: 400 });
    };
    await expectError(t.service.getValidAccessToken(PORTAL), expected, { retryable: false, reauthRequired: false, reason: code });
    assert.equal(t.store.getStatus(PORTAL).status, 'active');
    assert.equal(t.store.get(PORTAL).accessToken, ACCESS);
  }
});

test('a rejected request also pauses further HubSpot calls', async () => {
  const t = setup({ expiresIn: -1 * MIN });
  t.behaviour.fn = async () => {
    throw new HubspotTokenError('REQUEST_REJECTED', { httpStatus: 400 });
  };
  await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_REJECTED');
  await expectError(t.service.getValidAccessToken(PORTAL), 'REFRESH_COOLDOWN');
  assert.equal(t.client.calls.length, 1);
});

test('encryption problems (wrong or missing key) are reported safely', async () => {
  const dbPath = tmpDb('svc-key');
  try {
    const writer = createTokenStore(dbPath, { key: newKey() });
    writer.save({ portalId: PORTAL, accessToken: ACCESS, refreshToken: REFRESH, expiresAt: START + 30 * MIN });
    writer.close();

    const wrong = createTokenStore(dbPath, { key: newKey() });
    const client = { refreshAccessToken: async () => assert.fail('must not be called') };
    const service = createTokenService({ store: wrong, client, now: () => START });
    await expectError(service.getValidAccessToken(PORTAL), 'ENCRYPTION_ERROR', { retryable: false, reason: 'DECRYPT_FAILED' });
    assert.equal(wrong.getStatus(PORTAL).status, 'active', 'a wrong key must not flip the connection to needs_reauth');
    wrong.close();

    const saved = process.env[KEY_ENV_VAR];
    delete process.env[KEY_ENV_VAR];
    const keyless = createTokenStore(dbPath); // key read from the environment, which has none
    try {
      const svc = createTokenService({ store: keyless, client, now: () => START });
      await expectError(svc.getValidAccessToken(PORTAL), 'ENCRYPTION_ERROR', { reason: 'KEY_MISSING' });
      await expectError(
        svc.saveAuthorizedTokens({ portalId: PORTAL, accessToken: 'a', refreshToken: 'b', expiresIn: 1800 }),
        'ENCRYPTION_ERROR',
        { reason: 'KEY_MISSING' }
      );
    } finally {
      keyless.close();
      if (saved !== undefined) process.env[KEY_ENV_VAR] = saved;
    }
  } finally {
    removeDb(dbPath);
  }
});

test('database problems are reported as STORAGE_ERROR without details', async () => {
  const dbPath = tmpDb('svc-db');
  const t = setup({ expiresIn: 1 * MIN, dbPath });
  try {
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP TABLE oauth_connections');
    raw.close();
    const err = await expectError(t.service.getValidAccessToken(PORTAL), 'STORAGE_ERROR', { retryable: true, reason: 'DB_ERROR' });
    const text = [err.message, err.stack, JSON.stringify(err)].join('\n');
    assert.ok(!text.includes('oauth_connections') && !text.includes('no such table'));
    assert.throws(() => t.service.getConnectionStatus(PORTAL), (e) => e instanceof TokenServiceError && e.code === 'STORAGE_ERROR');
  } finally {
    t.store.close();
    removeDb(dbPath);
  }
});

test('a failure while saving the refreshed tokens is a STORAGE_ERROR', async () => {
  const t = setup({ expiresIn: -1 * MIN });
  t.behaviour.fn = async () => t.refreshed();
  const realUpdate = t.store.update;
  t.store.update = () => {
    throw new TokenStoreError('DB_ERROR');
  };
  await expectError(t.service.getValidAccessToken(PORTAL), 'STORAGE_ERROR', { reason: 'DB_ERROR' });
  t.store.update = realUpdate;
});

test('unexpected errors from the client become a generic INTERNAL_ERROR', async () => {
  const t = setup({ expiresIn: -1 * MIN });
  t.behaviour.fn = async () => {
    throw new TypeError(`secret detail ${REFRESH}`);
  };
  const err = await expectError(t.service.getValidAccessToken(PORTAL), 'INTERNAL_ERROR', { reason: null });
  assert.ok(!`${err.message}${err.stack}${JSON.stringify(err)}`.includes(REFRESH));
});

// ---------------------------------------------------------------------------
// 10. Missing connections and invalid input
// ---------------------------------------------------------------------------

test('an unknown portal is NOT_CONNECTED and never calls HubSpot', async () => {
  const t = setup();
  await expectError(t.service.getValidAccessToken(777), 'NOT_CONNECTED', { retryable: false, reauthRequired: false });
  assert.equal(t.client.calls.length, 0);
  assert.equal(t.service.getConnectionStatus(777), null);
});

test('invalid portal IDs are rejected', async () => {
  const t = setup();
  for (const portalId of [undefined, null, '', 0, -1, 1.5, NaN, {}, [], true, 'x'.repeat(65)]) {
    await expectError(t.service.getValidAccessToken(portalId), 'INVALID_INPUT');
    assert.throws(() => t.service.getConnectionStatus(portalId), (e) => e instanceof TokenServiceError && e.code === 'INVALID_INPUT');
  }
  assert.equal(t.client.calls.length, 0);
});

test('"4242" and 4242 are the same portal', async () => {
  const t = setup();
  assert.equal(await t.service.getValidAccessToken('4242'), ACCESS);
  assert.equal(await t.service.getValidAccessToken(4242), ACCESS);
});

test('saveAuthorizedTokens validates its input and stores nothing when invalid', async () => {
  const t = setup({ seed: false });
  const base = { portalId: PORTAL, accessToken: 'a-token', refreshToken: 'r-token', expiresIn: 1800 };
  const bad = [
    { portalId: undefined },
    { portalId: 0 },
    { accessToken: '' },
    { accessToken: undefined },
    { refreshToken: '' },
    { refreshToken: 5 },
    { expiresIn: undefined }, // neither expiresIn nor expiresAt
    { expiresIn: 0 },
    { expiresIn: -5 },
    { expiresIn: 1.5 },
    { expiresIn: '1800' },
    { expiresIn: 7 * 24 * 3600 + 1 },
    { expiresAt: START + 1000 }, // both given
  ];
  for (const change of bad) {
    await expectError(t.service.saveAuthorizedTokens({ ...base, ...change }), 'INVALID_INPUT');
  }
  await expectError(t.service.saveAuthorizedTokens(), 'INVALID_INPUT');
  assert.equal(t.store.list().length, 0);

  // Valid forms: expiresIn (seconds) and expiresAt (ms).
  const { expiresIn, ...withoutIn } = base;
  assert.ok(expiresIn);
  await t.service.saveAuthorizedTokens(base);
  assert.equal(t.store.get(PORTAL).accessExpiresAt, START + 1800 * 1000);
  await t.service.saveAuthorizedTokens({ ...withoutIn, portalId: 5, expiresAt: START + 99_000 });
  assert.equal(t.store.get(5).accessExpiresAt, START + 99_000);
});

test('the service cannot be built with missing or invalid parts', () => {
  const store = createTokenStore(':memory:', { key: newKey() });
  const client = { refreshAccessToken: async () => ({}) };
  for (const options of [
    {},
    { store },
    { client },
    { store: {}, client },
    { store, client: {} },
    { store, client, now: 'not a function' },
    { store, client, skewMs: 0 },
    { store, client, minUsableMs: -1 },
    { store, client, cooldownMs: 1.5 },
    { store, client, maxCooldownMs: 500 },
  ]) {
    assert.throws(() => createTokenService(options), (e) => e instanceof TokenServiceError && e.code === 'INVALID_INPUT');
  }
  assert.doesNotThrow(() => createTokenService({ store, client }));
  store.close();
});

// ---------------------------------------------------------------------------
// 11. No secret leakage
// ---------------------------------------------------------------------------

test('no error, status or console output ever contains tokens, keys, ciphertext or response bodies', async () => {
  const LEAK = 'LEAKY-RESPONSE-BODY-do-not-show';
  const key = newKey();
  const secrets = [ACCESS, REFRESH, NEW_ACCESS, NEW_REFRESH, LEAK, key.toString('base64'), key.toString('hex'), 'client_secret', 'grant_type'];

  const cap = captureConsole();
  const errors = [];
  let status;
  try {
    const scenarios = [
      ['INVALID_GRANT', 400],
      ['NETWORK_ERROR'],
      ['RATE_LIMITED', 429],
      ['SERVER_ERROR', 500],
      ['REQUEST_REJECTED', 400],
      ['INVALID_CLIENT', 401],
      ['CONFIG_MISSING'],
    ];
    for (const [code, httpStatus] of scenarios) {
      const t = setup({ expiresIn: -1 * MIN, key });
      t.behaviour.fn = async () => {
        throw new HubspotTokenError(code, { httpStatus: httpStatus ?? null });
      };
      try {
        await t.service.getValidAccessToken(PORTAL);
        assert.fail('expected a failure');
      } catch (err) {
        errors.push(err);
      }
      status = t.service.getConnectionStatus(PORTAL);
    }
    const t = setup({ expiresIn: -1 * MIN, key });
    t.behaviour.fn = async () => {
      throw new Error(`${LEAK} ${REFRESH} ${NEW_ACCESS}`);
    };
    errors.push(await t.service.getValidAccessToken(PORTAL).catch((e) => e));
    errors.push(await t.service.getValidAccessToken(null).catch((e) => e));
    errors.push(await t.service.getValidAccessToken(1234567).catch((e) => e));
    // And a fully successful refresh stays silent as well.
    const ok = setup({ expiresIn: -1 * MIN, key });
    ok.behaviour.fn = async () => ok.refreshed();
    await ok.service.getValidAccessToken(PORTAL);
  } finally {
    cap.restore();
  }

  assert.deepEqual(cap.lines, [], 'nothing may be written to the console');
  assert.ok(errors.length >= 10);
  for (const err of errors) {
    assert.ok(err instanceof TokenServiceError);
    assert.equal(err.cause, undefined);
    const text = [err.message, err.stack, JSON.stringify(err), String(err), Object.keys(err).join(',')].join('\n');
    for (const secret of secrets) assert.ok(!text.includes(secret), `error text leaked "${secret}"`);
  }
  const statusText = JSON.stringify(status);
  for (const secret of secrets) assert.ok(!statusText.includes(secret));
  assert.ok(!('accessToken' in status) && !('refreshToken' in status));
});

test('saveAuthorizedTokens returns no tokens', async () => {
  const t = setup({ seed: false });
  const result = await t.service.saveAuthorizedTokens({ portalId: PORTAL, accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 1800 });
  assert.equal(JSON.stringify(result).includes(ACCESS), false);
  assert.equal(JSON.stringify(result).includes(REFRESH), false);
});

// ---------------------------------------------------------------------------
// 12. The shared application instance
// ---------------------------------------------------------------------------

test('the shared instance is created lazily, uses OAUTH_TOKEN_DB_PATH and needs no network for a valid token', async () => {
  const dbPath = tmpDb('svc-default');
  const savedPath = process.env.OAUTH_TOKEN_DB_PATH;
  const savedKey = process.env[KEY_ENV_VAR];
  process.env.OAUTH_TOKEN_DB_PATH = dbPath;
  process.env[KEY_ENV_VAR] = newKey().toString('base64');
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('no network allowed in this test');
  };
  try {
    closeTokenService();
    assert.equal(fs.existsSync(dbPath), false, 'nothing is opened before first use');

    await saveAuthorizedTokens({ portalId: 31337, accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 1800 });
    assert.equal(fs.existsSync(dbPath), true);
    assert.equal(await getValidAccessToken(31337), ACCESS);
    assert.equal(getTokenService(), getTokenService()); // one shared instance
    await expectError(getValidAccessToken(1), 'NOT_CONNECTED');

    closeTokenService();
    closeTokenService(); // closing twice is harmless
    assert.equal(await getValidAccessToken(31337), ACCESS); // reopened from the same file
  } finally {
    closeTokenService();
    globalThis.fetch = realFetch;
    if (savedPath === undefined) delete process.env.OAUTH_TOKEN_DB_PATH;
    else process.env.OAUTH_TOKEN_DB_PATH = savedPath;
    if (savedKey === undefined) delete process.env[KEY_ENV_VAR];
    else process.env[KEY_ENV_VAR] = savedKey;
    removeDb(dbPath);
  }
});
