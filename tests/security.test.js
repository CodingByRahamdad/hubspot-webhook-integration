// tests/security.test.js
//
// Tests that the development-only routes (/webhooks/test, /webhooks/local-test)
// are unavailable in production and from non-local callers, and that sensitive
// headers are never printed.
//
// Run with:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const { localOnly, isLocalRequest } = require('../src/security/localOnly');
const { redactHeaders } = require('../src/security/redactHeaders');

const SERVER_PATH = require.resolve('../src/server');
const event = [
  { eventId: 1, subscriptionId: 1, portalId: 1, occurredAt: 1, subscriptionType: 'contact.creation', objectId: 4242 },
];

// Loads a fresh copy of the app with the given NODE_ENV (routes are decided at load time).
async function startApp(nodeEnv) {
  const original = process.env.NODE_ENV;
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  delete require.cache[SERVER_PATH];
  const app = require(SERVER_PATH);
  if (original === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = original;

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return { server, port: server.address().port };
}

const stop = (server) => new Promise((resolve) => server.close(resolve));

// node:http lets us set the Host header (fetch does not). Console output is captured.
function request(port, path, { headers = {}, body = JSON.stringify(event) } = {}) {
  const origLog = console.log;
  const origWarn = console.warn;
  const lines = [];
  const rec = (...a) => lines.push(a.join(' '));
  console.log = rec;
  console.warn = rec;
  const restore = () => {
    console.log = origLog;
    console.warn = origWarn;
  };
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          restore();
          resolve({ status: res.statusCode, body: data, logs: lines.join('\n') });
        });
      }
    );
    req.on('error', (err) => {
      restore();
      reject(err);
    });
    req.end(body);
  });
}

// ---- Production: routes are not registered ----

test('in production /webhooks/local-test and /webhooks/test do not exist', async () => {
  const { server, port } = await startApp('production');
  try {
    for (const path of ['/webhooks/local-test', '/webhooks/test']) {
      const res = await request(port, path);
      assert.equal(res.status, 404, path);
      assert.match(res.body, /Route not found/, path);
      assert.doesNotMatch(res.logs, /Simulated webhook batch|Webhook received|ID 4242/, path);
    }
    // The signed HubSpot route still exists (401/500 unsigned, NOT 404).
    const signed = await request(port, '/webhooks/simulate');
    assert.notEqual(signed.status, 404);
  } finally {
    await stop(server);
    delete require.cache[SERVER_PATH];
  }
});

// ---- Development: only genuine local requests are served ----

test('outside production, local requests reach both dev routes', async () => {
  const { server, port } = await startApp(undefined);
  try {
    const local = await request(port, '/webhooks/local-test');
    assert.equal(local.status, 200);
    assert.match(local.logs, /New contact created \(ID 4242\)/);
    const dbg = await request(port, '/webhooks/test');
    assert.equal(dbg.status, 200);
  } finally {
    await stop(server);
    delete require.cache[SERVER_PATH];
  }
});

test('ngrok-style requests (proxy headers or non-local Host) get 404 and nothing is processed', async () => {
  const { server, port } = await startApp(undefined);
  try {
    const attempts = [
      { 'X-Forwarded-For': '203.0.113.9' },
      { 'X-Forwarded-Host': 'abc.ngrok-free.dev' },
      { 'X-Forwarded-Proto': 'https' },
      { Forwarded: 'for=203.0.113.9' },
      { Host: 'abc.ngrok-free.dev' },
      // ngrok --host-header=rewrite: Host looks local but proxy headers remain
      { Host: 'localhost:3000', 'X-Forwarded-For': '203.0.113.9' },
    ];
    for (const headers of attempts) {
      for (const path of ['/webhooks/local-test', '/webhooks/test']) {
        const res = await request(port, path, { headers });
        assert.equal(res.status, 404, `${path} ${JSON.stringify(headers)}`);
        assert.doesNotMatch(res.logs, /Simulated webhook batch|Webhook received|ID 4242/);
      }
    }
  } finally {
    await stop(server);
    delete require.cache[SERVER_PATH];
  }
});

test('localOnly: loopback addresses pass, others fall through to the 404 route', () => {
  const make = (address, headers = { host: 'localhost:3000' }) => ({ socket: { remoteAddress: address }, headers });
  for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLocalRequest(make(addr)), true, addr);
  }
  for (const addr of ['203.0.113.9', '10.0.0.5', '::ffff:10.0.0.5', undefined]) {
    assert.equal(isLocalRequest(make(addr)), false, String(addr));
  }
  assert.equal(isLocalRequest(make('127.0.0.1', { host: '[::1]:3000' })), true);
  assert.equal(isLocalRequest(make('127.0.0.1', { host: 'localhost.evil.com' })), false);

  let result;
  localOnly(make('203.0.113.9'), {}, (arg) => (result = arg));
  assert.equal(result, 'route');
  localOnly(make('127.0.0.1'), {}, (arg) => (result = arg));
  assert.equal(result, undefined);
});

// ---- Header redaction ----

test('redactHeaders hides sensitive values and keeps harmless ones', () => {
  const out = redactHeaders({
    authorization: 'Bearer abc',
    'proxy-authorization': 'Basic x',
    cookie: 'sid=1',
    'set-cookie': 'sid=2',
    'x-hubspot-signature': 'sig1',
    'x-hubspot-signature-v3': 'sig3',
    'x-hubspot-signature-v4': 'sig4',
    'x-api-key': 'k',
    'x-access-token': 't',
    'x-client-secret': 's',
    'user-agent': 'curl/8',
    'content-type': 'application/json',
    host: 'localhost:3000',
  });
  for (const name of [
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-hubspot-signature',
    'x-hubspot-signature-v3',
    'x-hubspot-signature-v4',
    'x-api-key',
    'x-access-token',
    'x-client-secret',
  ]) {
    assert.equal(out[name], '[REDACTED]', name);
  }
  assert.equal(out['user-agent'], 'curl/8');
  assert.equal(out['content-type'], 'application/json');
  assert.equal(out.host, 'localhost:3000');
  assert.deepEqual(redactHeaders(undefined), {});
});

test('/webhooks/test never prints sensitive header values', async () => {
  const { server, port } = await startApp(undefined);
  const secrets = Array.from({ length: 6 }, () => crypto.randomBytes(8).toString('hex'));
  try {
    const res = await request(port, '/webhooks/test', {
      headers: {
        Authorization: `Bearer ${secrets[0]}`,
        Cookie: `session=${secrets[1]}`,
        'X-HubSpot-Signature-v3': secrets[2],
        'X-HubSpot-Signature': secrets[3],
        'X-API-Key': secrets[4],
        'X-Secret-Token': secrets[5],
        'User-Agent': 'security-test-agent',
      },
    });
    assert.equal(res.status, 200);
    for (const s of secrets) assert.ok(!res.logs.includes(s), 'a sensitive value was logged');
    assert.match(res.logs, /\[REDACTED\]/);
    assert.match(res.logs, /security-test-agent/); // useful debugging info is kept
    assert.match(res.logs, /content-type/i);
  } finally {
    await stop(server);
    delete require.cache[SERVER_PATH];
  }
});
