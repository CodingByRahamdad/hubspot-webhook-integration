// tests/webhook-events.test.js
//
// SIMULATED tests only. They prove that OUR receiver parses, routes and
// responds correctly. They do NOT prove that HubSpot delivers any event.
//
// No running server, ngrok or HubSpot credentials are needed: the Express app
// is imported and bound to a random free local port for the duration of the
// test run. (Importing it also loads src/oauth.js, which only defines routes.)
//
// Run with:  npm test

const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/server');
const { normalizeEvent } = require('../src/webhooks/normalizeEvent');
const { routeEvent } = require('../src/webhooks/router');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Records console.log / console.warn output until restore() is called, so tests
// can assert on what the receiver logs without printing it.
function captureConsole() {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const lines = [];
  const record = (...args) => lines.push(args.join(' '));
  console.log = record;
  console.warn = record;
  return {
    restore() {
      console.log = originalLog;
      console.warn = originalWarn;
      return lines.join('\n');
    },
  };
}

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0); // port 0 = any free port
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

// POSTs to /webhooks/local-test (the unsigned local route; signed route is tested in webhook-signature.test.js). "body" is JSON-stringified unless raw is true.
async function post(body, { raw = false, headers = {} } = {}) {
  const capture = captureConsole();
  let status;
  let json;
  let logs;
  try {
    const res = await fetch(`${baseUrl}/webhooks/local-test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: raw ? body : JSON.stringify(body),
    });
    status = res.status;
    json = await res.json();
  } finally {
    logs = capture.restore();
  }
  return { status, body: json, logs };
}

// Builds one classic-format event.
function makeEvent(subscriptionType, extra = {}) {
  return {
    eventId: 1,
    subscriptionId: 100,
    portalId: 12345678,
    occurredAt: 1730000000000,
    subscriptionType,
    objectId: 555,
    ...extra,
  };
}

const success = (received, recognized, unrecognized) => ({
  status: 'success',
  message: 'Events routed.',
  received,
  recognized,
  unrecognized,
});

// object prefix -> [label, property, sample value]
const OBJECTS = {
  contact: ['Contact', 'email', 'a@b.com'],
  company: ['Company', 'domain', 'acme.com'],
  deal: ['Deal', 'dealstage', 'closedwon'],
  ticket: ['Ticket', 'hs_pipeline_stage', '2'],
};

// ---------------------------------------------------------------------------
// Unit tests: normalizeEvent
// ---------------------------------------------------------------------------

test('normalizeEvent extracts the common fields', () => {
  const e = normalizeEvent(makeEvent('company.creation', { objectId: 7001 }));
  assert.equal(e.valid, true);
  assert.equal(e.eventId, 1);
  assert.equal(e.subscriptionId, 100);
  assert.equal(e.portalId, 12345678);
  assert.equal(e.subscriptionType, 'company.creation');
  assert.equal(e.occurredAt, 1730000000000);
  assert.equal(e.objectId, 7001);
  assert.equal(e.objectType, 'company');
  assert.equal(e.action, 'creation');
});

test('normalizeEvent includes propertyName/propertyValue only when sent', () => {
  const without = normalizeEvent(makeEvent('deal.creation'));
  assert.equal('propertyName' in without, false);
  assert.equal('propertyValue' in without, false);

  const withProps = normalizeEvent(
    makeEvent('deal.propertyChange', { propertyName: 'amount', propertyValue: '5000' })
  );
  assert.equal(withProps.propertyName, 'amount');
  assert.equal(withProps.propertyValue, '5000');
});

test('normalizeEvent rejects items that are not event objects', () => {
  for (const bad of [null, 'text', 42, [], [1], true, {}, { subscriptionType: 5 }]) {
    assert.equal(normalizeEvent(bad).valid, false, `should be invalid: ${JSON.stringify(bad)}`);
  }
});

test('normalizeEvent marks unsupported types as valid but without an objectType', () => {
  const unsupported = [
    'company.merge',
    'ticket.associationChange',
    'product.creation',
    'object.creation',
    'contact.privacyDeletion',
    'a.b.c',
    'contact.',
    'contact',
    '',
    'constructor.creation', // must not match Object.prototype members
    '__proto__.creation',
  ];
  for (const type of unsupported) {
    const e = normalizeEvent(makeEvent(type));
    assert.equal(e.valid, true, type);
    assert.equal(e.objectType, null, type);
    assert.equal(e.action, null, type);
  }
});

// ---------------------------------------------------------------------------
// Unit tests: routeEvent
// ---------------------------------------------------------------------------

test('routeEvent returns true for supported and false for unsupported/invalid items', () => {
  const capture = captureConsole();
  let results;
  try {
    results = [
      routeEvent(makeEvent('ticket.deletion')),
      routeEvent(makeEvent('ticket.merge')),
      routeEvent(null),
      routeEvent({ foo: 'bar' }),
    ];
  } finally {
    capture.restore();
  }
  assert.deepEqual(results, [true, false, false, false]);
});

// ---------------------------------------------------------------------------
// HTTP tests: every object x every action (12 cases)
// ---------------------------------------------------------------------------

for (const [prefix, [label, prop, value]] of Object.entries(OBJECTS)) {
  test(`${prefix}.creation is recognized`, async () => {
    const res = await post([makeEvent(`${prefix}.creation`, { objectId: 1001 })]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, success(1, 1, 0));
    assert.match(res.logs, new RegExp(`New ${label.toLowerCase()} created \\(ID 1001\\)\\.`));
    assert.match(res.logs, new RegExp(`Event type: +${prefix}\\.creation`));
    assert.match(res.logs, /CRM object ID: +1001/);
    assert.match(res.logs, /Occurred at: +1730000000000/);
    assert.doesNotMatch(res.logs, /Property name:/);
  });

  test(`${prefix}.propertyChange is recognized and exposes the property`, async () => {
    const res = await post([
      makeEvent(`${prefix}.propertyChange`, {
        objectId: 1001,
        propertyName: prop,
        propertyValue: value,
      }),
    ]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, success(1, 1, 0));
    assert.ok(
      res.logs.includes(`${label} 1001 property "${prop}" changed to "${value}".`),
      res.logs
    );
    assert.ok(res.logs.includes(`Property name:   ${prop}`));
    assert.ok(res.logs.includes(`Property value:  ${value}`));
  });

  test(`${prefix}.deletion is recognized`, async () => {
    const res = await post([makeEvent(`${prefix}.deletion`, { objectId: 1001 })]);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, success(1, 1, 0));
    assert.ok(res.logs.includes(`${label} 1001 was deleted.`), res.logs);
  });
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

test('a batch with one event per object is fully recognized', async () => {
  const res = await post([
    makeEvent('contact.creation', { objectId: 1 }),
    makeEvent('company.propertyChange', { objectId: 2, propertyName: 'name', propertyValue: 'Acme' }),
    makeEvent('deal.deletion', { objectId: 3 }),
    makeEvent('ticket.creation', { objectId: 4 }),
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, success(4, 4, 0));
  for (let i = 1; i <= 4; i += 1) {
    assert.ok(res.logs.includes(`Event ${i} of 4`), `missing "Event ${i} of 4"`);
  }
  assert.ok(res.logs.includes('Events in this request: 4'));
});

test('a mixed batch counts recognized and unrecognized items without failing', async () => {
  const res = await post([
    makeEvent('contact.creation'), // recognized
    makeEvent('company.merge'), // supported object, unsupported action
    makeEvent('product.creation'), // unsupported object
    makeEvent('object.creation'), // generic format, not handled
    { foo: 'bar' }, // missing subscriptionType
    'text', // not an object
    null, // not an object
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, success(7, 1, 6));
  assert.ok(res.logs.includes('Unknown event type "company.merge". Ignoring it.'));
  assert.ok(res.logs.includes('Unknown event type "product.creation". Ignoring it.'));
  assert.ok(res.logs.includes('Unknown event type "object.creation". Ignoring it.'));
  assert.ok(res.logs.includes('[WARNING] Skipping event: missing "subscriptionType".'));
  assert.ok(res.logs.includes('[WARNING] Skipping item: it is not a JSON object.'));
});

test('a batch of only unknown events still returns 200', async () => {
  const res = await post([makeEvent('company.merge'), makeEvent('product.deletion')]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, success(2, 0, 2));
});

test('a real-shaped contact.creation payload with extra HubSpot fields is recognized', async () => {
  const res = await post([
    makeEvent('contact.creation', {
      appId: 999,
      attemptNumber: 0,
      changeSource: 'CRM',
      objectId: 123456,
    }),
  ]);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, success(1, 1, 0));
  assert.ok(res.logs.includes('New contact created (ID 123456).'));
});

// ---------------------------------------------------------------------------
// Invalid payloads and malformed JSON
// ---------------------------------------------------------------------------

test('a JSON object (not an array) is rejected with 400', async () => {
  const res = await post({ subscriptionType: 'contact.creation' });
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    status: 'error',
    message: 'Payload must be a JSON array of events.',
  });
});

test('an empty array is rejected with 400', async () => {
  const res = await post([]);
  assert.equal(res.status, 400);
  assert.deepEqual(res.body, {
    status: 'error',
    message: 'Payload must contain at least one event.',
  });
});

// Express's JSON parser runs in strict mode, so a top-level string/number/null
// is refused by the parser itself, before our route runs.
test('a top-level string, number or null is rejected with 400', async () => {
  for (const raw of ['"hello"', '123', 'null']) {
    const res = await post(raw, { raw: true });
    assert.equal(res.status, 400, raw);
    assert.equal(res.body.status, 'error', raw);
  }
});

test('malformed JSON is rejected with 400 "Invalid JSON payload."', async () => {
  for (const raw of ['[{"subscriptionType": "contact.creation"', '{bad json}', '[1,]']) {
    const res = await post(raw, { raw: true });
    assert.equal(res.status, 400, raw);
    assert.deepEqual(res.body, { status: 'error', message: 'Invalid JSON payload.' }, raw);
  }
});

// ---------------------------------------------------------------------------
// Other routes and safety
// ---------------------------------------------------------------------------

test('GET /health returns 200', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    status: 'success',
    message: 'Webhook server is running.',
  });
});

test('an unknown route returns the 404 JSON body', async () => {
  const res = await fetch(`${baseUrl}/nope`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), {
    status: 'error',
    message: 'Route not found: GET /nope',
  });
});

test('credential-like request headers are never logged', async () => {
  const res = await post([makeEvent('contact.creation')], {
    headers: {
      Authorization: 'Bearer super-secret-token-123',
      'X-HubSpot-Signature': 'super-secret-signature-456',
    },
  });
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.logs, /super-secret/);
});
