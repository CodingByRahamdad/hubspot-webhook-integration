// tests/webhook-signature.test.js
//
// Tests HubSpot Signature v3 validation on POST /webhooks/simulate.
// A random secret is generated for every run; your real secret is never used.
//
// Run with:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// /webhooks/simulate now records events in a database (docs/20). Use a throwaway
// in-memory one so tests never touch real data. Must be set BEFORE the app is used.
process.env.IDEMPOTENCY_DB_PATH = ':memory:';

const app = require('../src/server');
const {
  decodeHubspotUri,
  computeSignature,
  safeEqual,
} = require('../src/webhooks/verifyHubspotSignature');

const SECRET = crypto.randomBytes(32).toString('hex');
const PUBLIC_HOST = 'test-host.ngrok-free.dev'; // pretend external host
const PATH = '/webhooks/simulate';

let server;
let baseUrl;
let originalSecret;
let originalBase;

test.before(async () => {
  originalSecret = process.env.HUBSPOT_CLIENT_SECRET;
  originalBase = process.env.PUBLIC_BASE_URL;
  process.env.HUBSPOT_CLIENT_SECRET = SECRET;
  delete process.env.PUBLIC_BASE_URL;
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  const restore = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('HUBSPOT_CLIENT_SECRET', originalSecret);
  restore('PUBLIC_BASE_URL', originalBase);
  await new Promise((resolve) => server.close(resolve));
});

// Every call returns an event with a NEW eventId, so earlier tests are never
// mistaken for duplicates by the idempotency check.
let nextEventId = 1000;
function newBatch() {
  nextEventId += 1;
  return [
    { eventId: nextEventId, subscriptionId: 100, portalId: 1, occurredAt: 1730000000000, subscriptionType: 'contact.creation', objectId: 555 },
  ];
}

// Builds signature headers the way HubSpot would.
function sign(body, { method = 'POST', path = PATH, host = PUBLIC_HOST, timestamp = String(Date.now()), secret = SECRET } = {}) {
  const uri = decodeHubspotUri(`https://${host}${path}`);
  return {
    'X-HubSpot-Signature-v3': computeSignature({ secret, method, uri, rawBody: body, timestamp }),
    'X-HubSpot-Request-Timestamp': timestamp,
  };
}

// Sends to the signed route, capturing console output.
async function send(body, headers = {}, { path = PATH, forwarded = true } = {}) {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const lines = [];
  const rec = (...a) => lines.push(a.join(' '));
  console.log = rec;
  console.warn = rec;
  console.error = rec;
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(forwarded ? { 'X-Forwarded-Host': PUBLIC_HOST } : {}),
        ...headers,
      },
      body,
    });
    return { status: res.status, json: await res.json(), logs: lines.join('\n') };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
}

const PROCESSED = /Simulated webhook batch received|Event 1 of/;

test('valid signature is accepted and the batch is processed', async () => {
  const body = JSON.stringify(newBatch());
  const res = await send(body, sign(body));
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, {
    status: 'success',
    message: 'Events routed.',
    received: 1,
    recognized: 1,
    unrecognized: 0,
    duplicates: 0,
    inProgress: 0,
    rejected: 0,
    failed: 0,
    invalid: 0,
  });
  assert.match(res.logs, /New contact created \(ID 555\)/);
});

test('signature is computed over the exact raw body (whitespace preserved)', async () => {
  const body = '[ {"eventId":777001,  "subscriptionId":100,"portalId":1,"occurredAt":1,"subscriptionType":"deal.deletion","objectId":9} ]';
  const res = await send(body, sign(body));
  assert.equal(res.status, 200);
  assert.match(res.logs, /Deal 9 was deleted/);
});

test('invalid signature is rejected with 401 and no event is processed', async () => {
  const body = JSON.stringify(newBatch());
  const headers = sign(body, { secret: crypto.randomBytes(16).toString('hex') });
  const res = await send(body, headers);
  assert.equal(res.status, 401);
  assert.equal(res.json.status, 'error');
  assert.doesNotMatch(res.logs, PROCESSED);
  assert.doesNotMatch(res.logs, /New contact created/);
});

test('missing signature header is rejected', async () => {
  const body = JSON.stringify(newBatch());
  const { 'X-HubSpot-Request-Timestamp': ts } = sign(body);
  const res = await send(body, { 'X-HubSpot-Request-Timestamp': ts });
  assert.equal(res.status, 401);
  assert.doesNotMatch(res.logs, PROCESSED);
});

test('missing timestamp header is rejected', async () => {
  const body = JSON.stringify(newBatch());
  const { 'X-HubSpot-Signature-v3': sig } = sign(body);
  const res = await send(body, { 'X-HubSpot-Signature-v3': sig });
  assert.equal(res.status, 401);
  assert.doesNotMatch(res.logs, PROCESSED);
});

test('expired timestamp (even with a correct signature) is rejected', async () => {
  const body = JSON.stringify(newBatch());
  const old = String(Date.now() - 6 * 60 * 1000);
  const res = await send(body, sign(body, { timestamp: old }));
  assert.equal(res.status, 401);
  assert.match(res.json.message, /expired/i);
  assert.doesNotMatch(res.logs, PROCESSED);
});

test('invalid (non-numeric) timestamp is rejected', async () => {
  const body = JSON.stringify(newBatch());
  for (const ts of ['abc', '12.5', '-1', '1e12']) {
    const res = await send(body, sign(body, { timestamp: ts }));
    assert.equal(res.status, 401, ts);
    assert.doesNotMatch(res.logs, PROCESSED, ts);
  }
});

test('a timestamp far in the future is rejected', async () => {
  const body = JSON.stringify(newBatch());
  const res = await send(body, sign(body, { timestamp: String(Date.now() + 10 * 60 * 1000) }));
  assert.equal(res.status, 401);
});

test('modified body is rejected', async () => {
  const body = JSON.stringify(newBatch());
  const headers = sign(body);
  const tampered = JSON.stringify([{ ...JSON.parse(body)[0], objectId: 999 }]);
  const res = await send(tampered, headers);
  assert.equal(res.status, 401);
  assert.doesNotMatch(res.logs, /ID 999/);
  assert.doesNotMatch(res.logs, PROCESSED);
});

test('signature for a different host, path or method is rejected', async () => {
  const body = JSON.stringify(newBatch());
  for (const opts of [{ host: 'evil.example.com' }, { path: '/webhooks/other' }, { method: 'GET' }]) {
    const res = await send(body, sign(body, opts));
    assert.equal(res.status, 401, JSON.stringify(opts));
    assert.doesNotMatch(res.logs, PROCESSED);
  }
});

test('query string is part of the signed URI', async () => {
  const body = JSON.stringify(newBatch());
  const path = `${PATH}?a=1&b=x%3Dy`;
  const ok = await send(body, sign(body, { path }), { path });
  assert.equal(ok.status, 200);
  const bad = await send(body, sign(body, { path: `${PATH}?a=2` }), { path });
  assert.equal(bad.status, 401);
});

test('an unsigned request to the signed route is rejected, local-test still works unsigned', async () => {
  const body = JSON.stringify(newBatch());
  const unsigned = await send(body);
  assert.equal(unsigned.status, 401);
  const local = await send(body, {}, { path: '/webhooks/local-test', forwarded: false });
  assert.equal(local.status, 200);
});

test('malformed JSON is rejected before any event processing', async () => {
  const body = '[{"bad"';
  const res = await send(body, sign(body));
  assert.equal(res.status, 400);
  assert.doesNotMatch(res.logs, PROCESSED);
});

test('missing server secret fails closed with 500', async () => {
  const body = JSON.stringify(newBatch());
  const headers = sign(body);
  delete process.env.HUBSPOT_CLIENT_SECRET;
  try {
    const res = await send(body, headers);
    assert.equal(res.status, 500);
    assert.doesNotMatch(res.logs, PROCESSED);
  } finally {
    process.env.HUBSPOT_CLIENT_SECRET = SECRET;
  }
});

test('secret, signature and body are never logged', async () => {
  const body = JSON.stringify(newBatch());
  const headers = sign(body, { secret: 'wrong-secret-for-log-test' });
  const res = await send(body, headers);
  assert.equal(res.status, 401);
  assert.ok(!res.logs.includes(SECRET));
  assert.ok(!res.logs.includes(headers['X-HubSpot-Signature-v3']));
  assert.ok(!res.logs.includes('contact.creation'));
});

// ---- Unit tests for helpers ----

test('decodeHubspotUri decodes only the documented characters', () => {
  assert.equal(
    decodeHubspotUri('https://h/p?a=%3A%2F%3f%40%21%24%27%28%29%2A%2C%3B'),
    "https://h/p?a=:/?@!$'()*,;"
  );
  // %3D and others stay encoded
  assert.equal(decodeHubspotUri('https://h/p?a%3Db%20c%25'), 'https://h/p?a%3Db%20c%25');
});

test('safeEqual handles different lengths without throwing', () => {
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual('', 'a'), false);
  assert.equal(safeEqual('same', 'same'), true);
  assert.equal(safeEqual('same', 'sbme'), false);
});
