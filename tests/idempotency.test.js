// tests/idempotency.test.js
//
// Tests duplicate-event protection (docs/20): the SQLite event store, the
// processBatch() function, and the signed POST /webhooks/simulate route.
// Every database is in memory or in a temporary file that is deleted afterwards.
// Secrets are randomly generated for each run; no real credentials are used.
//
// Run with:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// The server's shared store must use a throwaway DB. Set BEFORE the app is used.
process.env.IDEMPOTENCY_DB_PATH = ':memory:';

const app = require('../src/server');
const { createEventStore, getEventStore, buildEventKey } = require('../src/idempotency/eventStore');
const { processBatch } = require('../src/webhooks/processBatch');
const { decodeHubspotUri, computeSignature } = require('../src/webhooks/verifyHubspotSignature');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function captureConsole({ throwOn } = {}) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const rec = (...a) => {
    const line = a.join(' ');
    if (throwOn && throwOn.test(line)) throw new TypeError('simulated handler failure');
    lines.push(line);
  };
  console.log = rec;
  console.warn = rec;
  console.error = rec;
  return {
    restore() {
      Object.assign(console, orig);
      return lines.join('\n');
    },
  };
}

let nextId = 5000;
const uniqueId = () => (nextId += 1);
const makeEvent = (subscriptionType = 'contact.creation', extra = {}) => ({
  eventId: uniqueId(),
  subscriptionId: 100,
  portalId: 12345678,
  occurredAt: 1730000000000,
  subscriptionType,
  objectId: 555,
  ...extra,
});

// Runs processBatch with console output captured; counts how often the
// (fake) handler is called so we can prove duplicates are not processed.
function runBatch(events, store, processEvent) {
  let calls = 0;
  const handler = (e) => {
    calls += 1;
    return processEvent ? processEvent(e) : true;
  };
  const cap = captureConsole();
  let result;
  let logs;
  try {
    result = processBatch(events, { store, processEvent: handler });
  } finally {
    logs = cap.restore();
  }
  return { ...result, logs, calls };
}

// ---------------------------------------------------------------------------
// Event key
// ---------------------------------------------------------------------------

test('buildEventKey uses portal, event, type, object and property; rejects unkeyable events', () => {
  assert.deepEqual(
    buildEventKey({ eventId: 9, portalId: 1, subscriptionType: 'deal.propertyChange', objectId: 3, propertyName: 'amount' }),
    { portalId: '1', eventId: '9', subscriptionType: 'deal.propertyChange', objectId: '3', propertyName: 'amount' }
  );
  assert.equal(buildEventKey({ eventId: 9, portalId: 1, subscriptionType: 'x' }).propertyName, '');
  for (const bad of [null, 'x', [], {}, { eventId: 1 }, { portalId: 1, subscriptionType: 'a' }, { eventId: '', portalId: 1, subscriptionType: 'a' }]) {
    assert.equal(buildEventKey(bad), null, JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------
// processBatch with an in-memory store
// ---------------------------------------------------------------------------

test('a new event is processed and recorded as processed', () => {
  const store = createEventStore(':memory:');
  const event = makeEvent();
  const r = runBatch([event], store);
  assert.equal(r.calls, 1);
  assert.deepEqual(r.counts, { received: 1, recognized: 1, unrecognized: 0, duplicates: 0, inProgress: 0, rejected: 0, failed: 0, invalid: 0 });
  assert.match(r.logs, new RegExp(`New event ${event.eventId}: processing`));
  const row = store.get(buildEventKey(event));
  assert.equal(row.status, 'processed');
  store.close();
});

test('the same event twice in one batch is processed once', () => {
  const store = createEventStore(':memory:');
  const event = makeEvent();
  const r = runBatch([event, { ...event }], store);
  assert.equal(r.calls, 1);
  assert.equal(r.counts.recognized, 1);
  assert.equal(r.counts.duplicates, 1);
  assert.match(r.logs, new RegExp(`Duplicate event ${event.eventId}: skipped`));
  store.close();
});

test('the same event in a later request is skipped', () => {
  const store = createEventStore(':memory:');
  const event = makeEvent();
  assert.equal(runBatch([event], store).calls, 1);
  const again = runBatch([event], store);
  assert.equal(again.calls, 0);
  assert.equal(again.counts.duplicates, 1);
  assert.match(again.logs, new RegExp(`Duplicate event ${event.eventId}: skipped`));
  store.close();
});

test('different event IDs are all processed; same eventId on a different object/type is distinct', () => {
  const store = createEventStore(':memory:');
  const a = makeEvent();
  const b = makeEvent();
  assert.equal(runBatch([a, b], store).calls, 2);

  const shared = uniqueId();
  const r = runBatch(
    [
      makeEvent('contact.creation', { eventId: shared, objectId: 1 }),
      makeEvent('contact.creation', { eventId: shared, objectId: 2 }),
      makeEvent('deal.creation', { eventId: shared, objectId: 1 }),
      makeEvent('deal.propertyChange', { eventId: shared, objectId: 1, propertyName: 'amount' }),
      makeEvent('deal.propertyChange', { eventId: shared, objectId: 1, propertyName: 'dealstage' }),
    ],
    store
  );
  assert.equal(r.calls, 5);
  assert.equal(r.counts.duplicates, 0);
  store.close();
});

test('a mixed batch processes the new events and skips only the duplicates', () => {
  const store = createEventStore(':memory:');
  const old1 = makeEvent();
  const old2 = makeEvent('company.deletion');
  runBatch([old1, old2], store);

  const fresh1 = makeEvent('ticket.creation');
  const fresh2 = makeEvent('deal.deletion');
  const processed = [];
  const r = runBatch([fresh1, old1, fresh2, old2, { foo: 'bar' }], store, (e) => {
    processed.push(e.eventId);
    return true;
  });
  assert.deepEqual(processed, [fresh1.eventId, fresh2.eventId]);
  assert.deepEqual(r.counts, { received: 5, recognized: 2, unrecognized: 0, duplicates: 2, inProgress: 0, rejected: 0, failed: 0, invalid: 1 });
  store.close();
});

test('events without eventId or portalId are invalid: not processed, not stored', () => {
  const store = createEventStore(':memory:');
  const r = runBatch([{ subscriptionType: 'contact.creation', portalId: 1 }, { eventId: 3, subscriptionType: 'contact.creation' }], store);
  assert.equal(r.calls, 0);
  assert.equal(r.counts.invalid, 2);
  store.close();
});

test('claim: unsupported (unrecognized) events are still recorded so retries are skipped', () => {
  const store = createEventStore(':memory:');
  const event = makeEvent('company.merge');
  const first = runBatch([event], store, () => false);
  assert.equal(first.counts.unrecognized, 1);
  assert.equal(runBatch([event], store).calls, 0);
  store.close();
});

// ---------------------------------------------------------------------------
// Failures and retries
// ---------------------------------------------------------------------------

test('a processing failure is marked failed, other events still run, and a retry succeeds', () => {
  const store = createEventStore(':memory:');
  const bad = makeEvent();
  const good = makeEvent('deal.creation');

  let failOnce = true;
  const handler = (e) => {
    if (e.eventId === bad.eventId && failOnce) throw new RangeError('boom with a secret-looking message abc123');
    return true;
  };

  const first = runBatch([bad, good], store, handler);
  assert.equal(first.counts.failed, 1);
  assert.equal(first.counts.recognized, 1); // the good event was not discarded
  assert.equal(first.storeErrors, 0);
  assert.match(first.logs, new RegExp(`Event ${bad.eventId}: processing failed \\(RangeError\\)`));
  assert.ok(!first.logs.includes('abc123'), 'error message must not be logged');
  assert.equal(store.get(buildEventKey(bad)).status, 'failed');
  assert.equal(store.get(buildEventKey(good)).status, 'processed');

  // HubSpot re-sends the whole batch: good is a duplicate, bad is retried.
  failOnce = false;
  const retry = runBatch([bad, good], store, handler);
  assert.deepEqual(retry.counts, { received: 2, recognized: 1, unrecognized: 0, duplicates: 1, inProgress: 0, rejected: 0, failed: 0, invalid: 0 });
  assert.match(retry.logs, new RegExp(`Retry of event ${bad.eventId}: processing`));
  const row = store.get(buildEventKey(bad));
  assert.equal(row.status, 'processed');
  assert.equal(row.attempts, 2);

  // A third delivery is a plain duplicate.
  assert.equal(runBatch([bad], store).calls, 0);
  store.close();
});

test('an event is NOT marked processed before its processing succeeds', () => {
  const store = createEventStore(':memory:');
  const event = makeEvent();
  let statusDuringProcessing;
  runBatch([event], store, (e) => {
    statusDuringProcessing = store.get(buildEventKey(e)).status;
    return true;
  });
  assert.equal(statusDuringProcessing, 'processing');
  store.close();
});

test('an in-progress claim blocks others until its lease expires', () => {
  let clock = 1_000_000;
  const store = createEventStore(':memory:', { leaseMs: 60_000, now: () => clock });
  const key = buildEventKey(makeEvent());
  assert.deepEqual(store.claim(key), { claimed: true, retry: false });
  clock += 10_000;
  assert.deepEqual(store.claim(key), { claimed: false, status: 'processing' });
  clock += 60_000; // lease expired: e.g. the first server crashed mid-event
  assert.deepEqual(store.claim(key), { claimed: true, retry: true });
  store.markProcessed(key);
  clock += 10 * 60_000;
  assert.deepEqual(store.claim(key), { claimed: false, status: 'processed' });
  store.close();
});

test('database errors: the event is not processed and the batch reports a storage error', () => {
  const store = createEventStore(':memory:');
  store.close(); // every call now throws
  const r = runBatch([makeEvent(), makeEvent()], store);
  assert.equal(r.calls, 0);
  assert.equal(r.counts.failed, 2);
  assert.equal(r.storeErrors, 2);
  assert.match(r.logs, /not processed \(storage error/);
});

test('a database failure on one event does not stop the others being protected', () => {
  const real = createEventStore(':memory:');
  const flaky = makeEvent();
  const other = makeEvent('ticket.deletion');
  const store = {
    ...real,
    claim(key) {
      if (key.eventId === String(flaky.eventId)) throw new Error('disk I/O error');
      return real.claim(key);
    },
  };
  const r = runBatch([flaky, other], store);
  assert.equal(r.calls, 1);
  assert.equal(r.storeErrors, 1);
  assert.equal(real.get(buildEventKey(other)).status, 'processed');
  real.close();
});

test('if recording "processed" fails, the batch reports a failure so HubSpot retries', () => {
  const real = createEventStore(':memory:');
  const store = {
    ...real,
    markProcessed() {
      throw new Error('disk full');
    },
  };
  const r = runBatch([makeEvent()], store);
  assert.equal(r.calls, 1);
  assert.equal(r.counts.failed, 1);
  assert.equal(r.storeErrors, 1);
  real.close();
});

test('the database stores no headers, signatures, secrets or bodies', () => {
  const store = createEventStore(':memory:');
  const event = makeEvent('contact.propertyChange', { propertyName: 'email', propertyValue: 'private@example.com' });
  runBatch([event], store, () => {
    throw new Error('x');
  });
  const columns = Object.keys(store.get(buildEventKey(event)));
  assert.deepEqual(columns.sort(), ['attempts', 'status']); // get() only selects these two
  store.close();

  const dbPath = path.join(os.tmpdir(), `idem-schema-${crypto.randomBytes(6).toString('hex')}.db`);
  const file = createEventStore(dbPath);
  runBatch([event], file, () => true);
  file.close();
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(dbPath);
  const names = raw.prepare('PRAGMA table_info(webhook_events)').all().map((c) => c.name);
  const dump = JSON.stringify(raw.prepare('SELECT * FROM webhook_events').all());
  raw.close();
  for (const n of names) assert.doesNotMatch(n, /signature|secret|token|header|body|value/i, n);
  assert.ok(!dump.includes('private@example.com'));
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
});

// ---------------------------------------------------------------------------
// Real concurrency: several OS processes race on one database file
// ---------------------------------------------------------------------------

test('processes racing on the same event: exactly one wins the claim', async () => {
  const dbPath = path.join(os.tmpdir(), `idem-race-${crypto.randomBytes(6).toString('hex')}.db`);
  createEventStore(dbPath).close(); // create the schema once

  const storeModule = require.resolve('../src/idempotency/eventStore');
  const script = `
    const { createEventStore } = require(${JSON.stringify(storeModule)});
    const store = createEventStore(${JSON.stringify(dbPath)});
    const key = { portalId: '1', eventId: '42', subscriptionType: 'contact.creation', objectId: '7', propertyName: '' };
    const r = store.claim(key);
    console.log(r.claimed ? 'WON' : 'LOST');
    store.close();
  `;
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(err))));
    });

  try {
    const results = await Promise.all(Array.from({ length: 8 }, run));
    assert.equal(results.filter((r) => r === 'WON').length, 1, results.join(','));
    assert.equal(results.filter((r) => r === 'LOST').length, 7, results.join(','));
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbPath + suffix, { force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTP: the signed route /webhooks/simulate
// ---------------------------------------------------------------------------

const SECRET = crypto.randomBytes(32).toString('hex');
const HOST = 'idem-test.ngrok-free.dev';
const PATH = '/webhooks/simulate';
let server;
let baseUrl;
let originalSecret;

test.before(async () => {
  originalSecret = process.env.HUBSPOT_CLIENT_SECRET;
  process.env.HUBSPOT_CLIENT_SECRET = SECRET;
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (originalSecret === undefined) delete process.env.HUBSPOT_CLIENT_SECRET;
  else process.env.HUBSPOT_CLIENT_SECRET = originalSecret;
  await new Promise((resolve) => server.close(resolve));
});

function signedHeaders(body, secret = SECRET) {
  const timestamp = String(Date.now());
  const uri = decodeHubspotUri(`https://${HOST}${PATH}`);
  return {
    'Content-Type': 'application/json',
    'X-Forwarded-Host': HOST,
    'X-HubSpot-Signature-v3': computeSignature({ secret, method: 'POST', uri, rawBody: body, timestamp }),
    'X-HubSpot-Request-Timestamp': timestamp,
  };
}

// Sends a signed batch. Console is NOT captured here, so callers can capture
// around several parallel calls.
async function sendSigned(events, { sign = true } = {}) {
  const body = JSON.stringify(events);
  const headers = sign ? signedHeaders(body) : { 'Content-Type': 'application/json', 'X-Forwarded-Host': HOST };
  const res = await fetch(`${baseUrl}${PATH}`, { method: 'POST', headers, body });
  return { status: res.status, json: await res.json() };
}

async function sendCaptured(events, options, captureOptions) {
  const cap = captureConsole(captureOptions);
  let res;
  let logs;
  try {
    res = await sendSigned(events, options);
  } finally {
    logs = cap.restore();
  }
  return { ...res, logs };
}

test('HTTP: a new signed event is processed, a re-sent one is skipped, a later one is processed', async () => {
  const event = makeEvent('contact.creation', { objectId: 8101 });
  const first = await sendCaptured([event]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, {
    status: 'success', message: 'Events routed.', received: 1, recognized: 1, unrecognized: 0, duplicates: 0, inProgress: 0, rejected: 0, failed: 0, invalid: 0,
  });
  assert.match(first.logs, /New contact created \(ID 8101\)/);

  const second = await sendCaptured([event]);
  assert.equal(second.status, 200);
  assert.equal(second.json.duplicates, 1);
  assert.equal(second.json.recognized, 0);
  assert.doesNotMatch(second.logs, /New contact created/);
  assert.match(second.logs, new RegExp(`Duplicate event ${event.eventId}: skipped`));

  const third = await sendCaptured([makeEvent('contact.creation', { objectId: 8102 })]);
  assert.match(third.logs, /New contact created \(ID 8102\)/);
});

test('HTTP: all four CRM object types x three actions still work (12 events)', async () => {
  const events = [];
  for (const obj of ['contact', 'company', 'deal', 'ticket']) {
    events.push(makeEvent(`${obj}.creation`));
    events.push(makeEvent(`${obj}.propertyChange`, { propertyName: 'p', propertyValue: 'v' }));
    events.push(makeEvent(`${obj}.deletion`));
  }
  const res = await sendCaptured(events);
  assert.equal(res.status, 200);
  assert.equal(res.json.recognized, 12);
  assert.equal(res.json.duplicates, 0);
});

test('HTTP: signature validation still runs first and leaves the database untouched', async () => {
  const event = makeEvent('contact.creation', { objectId: 8201 });
  const unsigned = await sendCaptured([event], { sign: false });
  assert.equal(unsigned.status, 401);

  const body = JSON.stringify([event]);
  const wrong = await fetch(`${baseUrl}${PATH}`, { method: 'POST', headers: signedHeaders(body, 'not-the-secret'), body });
  assert.equal(wrong.status, 401);

  assert.equal(getEventStore().get(buildEventKey(event)), undefined, 'rejected request must not be recorded');
  const ok = await sendCaptured([event]);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.recognized, 1); // still new: the rejected attempts did not "use up" the event
});

test('HTTP: 20 identical concurrent deliveries process the event exactly once', async () => {
  const event = makeEvent('deal.deletion', { objectId: 8301 });
  const cap = captureConsole();
  let results;
  let logs;
  try {
    results = await Promise.all(Array.from({ length: 20 }, () => sendSigned([event])));
  } finally {
    logs = cap.restore();
  }
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(results.reduce((n, r) => n + r.json.recognized, 0), 1);
  assert.equal(results.reduce((n, r) => n + r.json.duplicates, 0), 19);
  assert.equal(logs.split('Deal 8301 was deleted.').length - 1, 1);
});

test('HTTP: a failing event returns 500, then HubSpot retries the batch and it succeeds', async () => {
  const bad = makeEvent('ticket.creation', { objectId: 8401 });
  const good = makeEvent('company.creation', { objectId: 8402 });

  // Make the real handler throw for ticket 8401 only (its detail log line throws).
  const first = await sendCaptured([bad, good], {}, { throwOn: /CRM object ID: +8401/ });
  assert.equal(first.status, 500);
  assert.equal(first.json.failed, 1);
  assert.equal(first.json.recognized, 1); // the good event was still processed
  assert.equal(getEventStore().get(buildEventKey(bad)).status, 'failed');

  const retry = await sendCaptured([bad, good]);
  assert.equal(retry.status, 200);
  assert.equal(retry.json.recognized, 1); // bad now succeeds
  assert.equal(retry.json.duplicates, 1); // good is skipped
  assert.match(retry.logs, /New ticket created \(ID 8401\)/);
  assert.doesNotMatch(retry.logs, /New company created/);
  assert.equal(getEventStore().get(buildEventKey(bad)).status, 'processed');
});

test('HTTP: /webhooks/local-test stays stateless (the same event can be re-sent)', async () => {
  const event = makeEvent('contact.creation', { objectId: 8501 });
  for (let i = 0; i < 2; i += 1) {
    const cap = captureConsole();
    let res;
    let logs;
    try {
      res = await fetch(`${baseUrl}/webhooks/local-test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([event]),
      });
    } finally {
      logs = cap.restore();
    }
    assert.equal(res.status, 200);
    assert.match(logs, /New contact created \(ID 8501\)/);
  }
});

// Keep this LAST: it closes the shared database to simulate a storage outage.
test('HTTP: when the database is unavailable nothing is processed and the response is 503', async () => {
  getEventStore().close();
  const event = makeEvent('contact.creation', { objectId: 8601 });
  const res = await sendCaptured([event]);
  assert.equal(res.status, 503);
  assert.equal(res.json.status, 'error');
  assert.doesNotMatch(res.logs, /New contact created/);
  assert.match(res.logs, /not processed \(storage error/);
  assert.ok(!res.logs.includes(SECRET));
});
