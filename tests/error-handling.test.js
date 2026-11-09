// tests/error-handling.test.js
//
// Tests error handling and retry management (docs/21):
//   - "in progress elsewhere" must not be answered with 200 (lost-event hole)
//   - 4xx framework errors keep their 4xx code instead of becoming 500
//   - permanent vs retryable failures
//   - database migration, failed-event report, extra log details
// All databases are in memory or in temporary files that are deleted afterwards.
//
// Run with:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

process.env.IDEMPOTENCY_DB_PATH = ':memory:'; // before the app is used

const app = require('../src/server');
const { createEventStore, getEventStore, listProblemEvents, buildEventKey } = require('../src/idempotency/eventStore');
const { processBatch } = require('../src/webhooks/processBatch');
const { PermanentEventError } = require('../src/webhooks/errors');
const { decodeHubspotUri, computeSignature } = require('../src/webhooks/verifyHubspotSignature');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Records console output. throwOn: when a log line matches, throw `error` from console.log
// (this makes the REAL event handler fail in a controlled way).
function captureConsole({ throwOn, error } = {}) {
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const lines = [];
  const rec = (...a) => {
    const line = a.join(' ');
    if (throwOn && throwOn.test(line)) throw error || new TypeError('simulated handler failure');
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

let nextId = 20000;
const makeEvent = (subscriptionType = 'contact.creation', extra = {}) => ({
  eventId: (nextId += 1),
  subscriptionId: 100,
  portalId: 777,
  occurredAt: 1730000000000,
  subscriptionType,
  objectId: 555,
  ...extra,
});

function runBatch(events, options) {
  let calls = 0;
  const handler = options.processEvent || (() => true);
  const cap = captureConsole();
  let result;
  let logs;
  try {
    result = processBatch(events, {
      ...options,
      processEvent: (e) => {
        calls += 1;
        return handler(e);
      },
    });
  } finally {
    logs = cap.restore();
  }
  return { ...result, logs, calls };
}

const tmpFile = (label) => path.join(os.tmpdir(), `${label}-${crypto.randomBytes(6).toString('hex')}.db`);
const removeDb = (p) => ['', '-wal', '-shm'].forEach((s) => fs.rmSync(p + s, { force: true }));

// ---------------------------------------------------------------------------
// 1. "In progress elsewhere" must make HubSpot retry (no lost events)
// ---------------------------------------------------------------------------

test('an event being processed elsewhere is reported as inProgress and NOT processed', () => {
  const store = createEventStore(':memory:');
  const event = makeEvent();
  store.claim(buildEventKey(event)); // another request owns it right now
  const r = runBatch([event], { store });
  assert.equal(r.calls, 0);
  assert.equal(r.counts.inProgress, 1);
  assert.equal(r.counts.duplicates, 0);
  assert.match(r.logs, /still being processed elsewhere, HubSpot should retry/);
  store.close();
});

test('counts always add up to the number of received events', () => {
  const store = createEventStore(':memory:');
  const done = makeEvent();
  const busy = makeEvent();
  const permanent = makeEvent();
  const failing = makeEvent();
  runBatch([done], { store });
  store.claim(buildEventKey(busy));
  const r = runBatch([done, busy, permanent, failing, makeEvent(), { foo: 1 }], {
    store,
    processEvent: (e) => {
      if (e.eventId === permanent.eventId) throw new PermanentEventError('bad data');
      if (e.eventId === failing.eventId) throw new Error('temporary');
      return true;
    },
  });
  const c = r.counts;
  assert.deepEqual(c, { received: 6, recognized: 1, unrecognized: 0, duplicates: 1, inProgress: 1, rejected: 1, failed: 1, invalid: 1 });
  assert.equal(c.recognized + c.unrecognized + c.duplicates + c.inProgress + c.rejected + c.failed + c.invalid, c.received);
  store.close();
});

// HTTP: use the server's real shared store and a signed request.
const SECRET = crypto.randomBytes(32).toString('hex');
const HOST = 'err-test.ngrok-free.dev';
const PATH = '/webhooks/simulate';
let server;
let baseUrl;
let port;
let originalSecret;

test.before(async () => {
  originalSecret = process.env.HUBSPOT_CLIENT_SECRET;
  process.env.HUBSPOT_CLIENT_SECRET = SECRET;
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  port = server.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (originalSecret === undefined) delete process.env.HUBSPOT_CLIENT_SECRET;
  else process.env.HUBSPOT_CLIENT_SECRET = originalSecret;
  await new Promise((resolve) => server.close(resolve));
});

async function sendSigned(events, captureOptions) {
  const body = JSON.stringify(events);
  const timestamp = String(Date.now());
  const uri = decodeHubspotUri(`https://${HOST}${PATH}`);
  const headers = {
    'Content-Type': 'application/json',
    'X-Forwarded-Host': HOST,
    'X-HubSpot-Signature-v3': computeSignature({ secret: SECRET, method: 'POST', uri, rawBody: body, timestamp }),
    'X-HubSpot-Request-Timestamp': timestamp,
  };
  const cap = captureConsole(captureOptions);
  let res;
  let json;
  let logs;
  try {
    res = await fetch(`${baseUrl}${PATH}`, { method: 'POST', headers, body });
    json = await res.json();
  } finally {
    logs = cap.restore();
  }
  return { status: res.status, json, logs };
}

test('HTTP: an in-progress event gets 503 (not 200); once it finishes, the retry is a normal 200 duplicate', async () => {
  const event = makeEvent('contact.creation', { objectId: 9001 });
  const key = buildEventKey(event);
  assert.equal(getEventStore().claim(key).claimed, true); // "another request" is working on it

  const during = await sendSigned([event]);
  assert.equal(during.status, 503);
  assert.equal(during.json.inProgress, 1);
  assert.doesNotMatch(during.logs, /New contact created/);

  getEventStore().markProcessed(key); // the other request finished successfully
  const after = await sendSigned([event]);
  assert.equal(after.status, 200);
  assert.equal(after.json.duplicates, 1);
  assert.equal(after.json.inProgress, 0);
});

test('HTTP: if the other attempt FAILS, the next HubSpot retry reclaims and processes it (no lost event)', async () => {
  const event = makeEvent('deal.creation', { objectId: 9002 });
  const key = buildEventKey(event);
  getEventStore().claim(key);

  const during = await sendSigned([event]);
  assert.equal(during.status, 503); // HubSpot will retry

  getEventStore().markFailed(key, 'Error'); // the other attempt failed
  const retry = await sendSigned([event]);
  assert.equal(retry.status, 200);
  assert.equal(retry.json.recognized, 1);
  assert.match(retry.logs, /New deal created \(ID 9002\)/);
  assert.equal(getEventStore().get(key).status, 'processed');
});

// ---------------------------------------------------------------------------
// 2. Framework errors keep their 4xx code
// ---------------------------------------------------------------------------

function rawRequest({ headers = {}, body = '[]' }) {
  const cap = captureConsole();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/webhooks/local-test', method: 'POST', headers },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data, logs: cap.restore() }));
      }
    );
    req.on('error', (err) => {
      cap.restore();
      reject(err);
    });
    req.end(body);
  });
}

test('a too-large body returns 413 (not 500) and does not log the error object', async () => {
  const big = JSON.stringify([{ pad: 'x'.repeat(200 * 1024) }]);
  const res = await rawRequest({ headers: { 'Content-Type': 'application/json' }, body: big });
  assert.equal(res.status, 413);
  assert.deepEqual(JSON.parse(res.body), { status: 'error', message: 'Payload too large.' });
  assert.match(res.logs, /Request rejected \(HTTP 413, entity\.too\.large\)/);
  assert.doesNotMatch(res.logs, /Unexpected error/);
  assert.ok(!res.logs.includes('xxxxxxxx'));
});

test('an unsupported Content-Encoding returns 415 (not 500)', async () => {
  const res = await rawRequest({ headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'bogus' }, body: '[]' });
  assert.equal(res.status, 415);
  assert.equal(JSON.parse(res.body).status, 'error');
});

test('invalid JSON still returns 400 "Invalid JSON payload."', async () => {
  const res = await rawRequest({ headers: { 'Content-Type': 'application/json' }, body: '[{"bad"' });
  assert.equal(res.status, 400);
  assert.deepEqual(JSON.parse(res.body), { status: 'error', message: 'Invalid JSON payload.' });
});

// ---------------------------------------------------------------------------
// 3. Permanent vs retryable failures
// ---------------------------------------------------------------------------

test('a PermanentEventError is stored as rejected, counts as rejected, and is never retried', () => {
  const store = createEventStore(':memory:');
  const event = makeEvent();
  const handler = () => {
    throw new PermanentEventError('this message must not be logged: s3cr3t');
  };
  const first = runBatch([event], { store, processEvent: handler });
  assert.equal(first.counts.rejected, 1);
  assert.equal(first.counts.failed, 0);
  assert.equal(first.storeErrors, 0);
  assert.equal(store.get(buildEventKey(event)).status, 'rejected');
  assert.match(first.logs, /rejected, will not be retried \(PermanentEventError\)/);
  assert.ok(!first.logs.includes('s3cr3t'));

  const second = runBatch([event], { store });
  assert.equal(second.calls, 0);
  assert.equal(second.counts.duplicates, 1);
  assert.match(second.logs, /previously rejected as unprocessable, skipped/);
  store.close();
});

test('a normal Error stays retryable (failed, then reclaimed on the next delivery)', () => {
  const store = createEventStore(':memory:');
  const event = makeEvent();
  const first = runBatch([event], { store, processEvent: () => { throw new Error('temporary'); } });
  assert.equal(first.counts.failed, 1);
  assert.equal(store.get(buildEventKey(event)).status, 'failed');
  const second = runBatch([event], { store });
  assert.equal(second.counts.recognized, 1);
  store.close();
});

test('HTTP: a permanent failure answers 200 (HubSpot stops retrying) and the other events still run', async () => {
  const bad = makeEvent('ticket.creation', { objectId: 9101 });
  const good = makeEvent('company.creation', { objectId: 9102 });
  const res = await sendSigned([bad, good], {
    throwOn: /CRM object ID: +9101/,
    error: new PermanentEventError('unusable'),
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.rejected, 1);
  assert.equal(res.json.recognized, 1);
  assert.equal(getEventStore().get(buildEventKey(bad)).status, 'rejected');
});

// ---------------------------------------------------------------------------
// 4. Database migration (older databases lack the 'rejected' status)
// ---------------------------------------------------------------------------

test('an old-format database is upgraded without losing rows', () => {
  const dbPath = tmpFile('err-migrate');
  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE webhook_events (
      portal_id TEXT NOT NULL, event_id TEXT NOT NULL, subscription_type TEXT NOT NULL,
      object_id TEXT NOT NULL, property_name TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'failed')),
      attempts INTEGER NOT NULL, first_received_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      processed_at INTEGER, lease_expires_at INTEGER, last_error TEXT,
      PRIMARY KEY (portal_id, event_id, subscription_type, object_id, property_name)
    )`);
  old.exec(`INSERT INTO webhook_events VALUES ('1','10','contact.creation','5','','processed',1,1000,2000,2000,NULL,NULL)`);
  old.exec(`INSERT INTO webhook_events VALUES ('1','11','deal.deletion','6','','failed',3,1000,3000,NULL,NULL,'TypeError')`);
  old.close();

  const store = createEventStore(dbPath);
  try {
    const key = (id, type, obj) => ({ portalId: '1', eventId: id, subscriptionType: type, objectId: obj, propertyName: '' });
    assert.deepEqual({ ...store.get(key('10', 'contact.creation', '5')) }, { status: 'processed', attempts: 1 });
    assert.deepEqual({ ...store.get(key('11', 'deal.deletion', '6')) }, { status: 'failed', attempts: 3 });
    // The new status now works: reclaim the failed row, then reject it.
    const k = key('11', 'deal.deletion', '6');
    assert.equal(store.claim(k).claimed, true);
    store.markRejected(k, 'PermanentEventError');
    assert.equal(store.get(k).status, 'rejected');
  } finally {
    store.close();
    removeDb(dbPath);
  }
  // Opening a current-format database again changes nothing and does not fail.
  const again = createEventStore(dbPath);
  again.close();
  removeDb(dbPath);
});

// ---------------------------------------------------------------------------
// 5. Failed-event report
// ---------------------------------------------------------------------------

test('listProblemEvents returns failed and expired-processing events only, with no payload data', () => {
  const dbPath = tmpFile('err-report');
  let clock = Date.now() - 10 * 60_000; // real time, so the script (which uses the real clock) agrees
  const store = createEventStore(dbPath, { leaseMs: 60_000, now: () => clock });
  const failed = makeEvent('contact.propertyChange', { propertyName: 'email', propertyValue: 'private@example.com' });
  const stuck = makeEvent('deal.creation');
  const fresh = makeEvent('ticket.creation');
  const done = makeEvent('company.creation');
  const rejected = makeEvent('deal.deletion');

  for (const [e, finish] of [
    [failed, (k) => store.markFailed(k, 'TypeError')],
    [stuck, () => {}],
    [fresh, () => {}],
    [done, (k) => store.markProcessed(k)],
    [rejected, (k) => store.markRejected(k, 'PermanentEventError')],
  ]) {
    if (e === fresh) clock = Date.now(); // everything above is now older than its lease; this one is current
    const k = buildEventKey(e);
    store.claim(k);
    finish(k);
  }
  store.close();

  try {
    const rows = listProblemEvents(dbPath, { now: clock });
    const ids = rows.map((r) => r.event_id).sort();
    assert.deepEqual(ids, [String(failed.eventId), String(stuck.eventId)].sort());
    assert.equal(rows.find((r) => r.event_id === String(failed.eventId)).last_error, 'TypeError');
    assert.ok(!JSON.stringify(rows).includes('private@example.com'));
    assert.equal(listProblemEvents(tmpFile('err-missing')).length, 0); // missing file: empty, nothing created

    // The npm script prints the same thing and does not modify the database.
    const before = fs.statSync(dbPath).mtimeMs;
    const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'list-failed-events.js')], {
      env: { ...process.env, IDEMPOTENCY_DB_PATH: dbPath },
      encoding: 'utf8',
    });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /2 event\(s\) need attention/);
    assert.ok(out.stdout.includes(String(failed.eventId)));
    assert.ok(!out.stdout.includes('private@example.com'));
    if (process.env.HUBSPOT_CLIENT_SECRET) assert.ok(!out.stdout.includes(process.env.HUBSPOT_CLIENT_SECRET));
    assert.equal(fs.statSync(dbPath).mtimeMs, before);
  } finally {
    removeDb(dbPath);
  }
});

// ---------------------------------------------------------------------------
// 6. Extra log details
// ---------------------------------------------------------------------------

test('HubSpot retries (attemptNumber >= 1) are shown in the log; first deliveries and junk values are not', () => {
  const store = createEventStore(':memory:');
  const retry = runBatch([makeEvent('contact.creation', { attemptNumber: 2 })], { store });
  assert.match(retry.logs, /New event \d+ \(HubSpot attemptNumber 2\): processing/);
  for (const value of [0, -1, 1.5, '3', null, undefined]) {
    const r = runBatch([makeEvent('contact.creation', { attemptNumber: value })], { store });
    assert.doesNotMatch(r.logs, /attemptNumber/, String(value));
  }
  store.close();
});

test('a batch that takes too long logs a warning about HubSpot\'s 5 second limit', () => {
  const store = createEventStore(':memory:');
  let clock = 0;
  const slow = runBatch([makeEvent()], { store, now: () => (clock += 4000) });
  assert.match(slow.logs, /\[WARNING\] Batch took 4\.0s; HubSpot times out after 5s\./);
  assert.ok(slow.durationMs >= 4000);

  clock = 0;
  const fast = runBatch([makeEvent()], { store, now: () => (clock += 10) });
  assert.doesNotMatch(fast.logs, /Batch took/);
  store.close();
});

test('failure logs include a safe error code but never the error message', () => {
  const store = createEventStore(':memory:');
  const withCode = Object.assign(new Error('token=abc123 leaked?'), { code: 'ECONNRESET' });
  const r1 = runBatch([makeEvent()], { store, processEvent: () => { throw withCode; } });
  assert.match(r1.logs, /processing failed \(Error, ECONNRESET\)/);
  assert.ok(!r1.logs.includes('abc123'));

  const weird = Object.assign(new Error('x'), { code: 'not a safe code!' });
  const r2 = runBatch([makeEvent()], { store, processEvent: () => { throw weird; } });
  assert.match(r2.logs, /processing failed \(Error\)/);
  store.close();
});
