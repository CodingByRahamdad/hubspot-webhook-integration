// tests/sheets-crud-demo.test.js
//
// Tests scripts/sheets-crud-demo.js (Phase 2, step 7).
// The demonstration is NEVER run against Google here. Its service is replaced by the real
// contacts service running on an in-memory fake spreadsheet (tests/helpers/fake-sheets-api.js),
// and the settings are plain objects. The real key, the real spreadsheet and the Contacts_Test
// worksheet are never touched. All Google settings in the environment are blanked while these
// tests run. The two child-process tests only exercise refusals, which happen before any
// Google access (every setting is given explicitly, so a real .env cannot change them).
//
// Run with:  node --test tests/sheets-crud-demo.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runCrudDemo, generateTestContactId, checkSafety } = require('../scripts/sheets-crud-demo');
const { createContactsSheet } = require('../src/google/contactsSheet');
const { createSheetsClient } = require('../src/google/sheetsClient');
const { GoogleSheetsError } = require('../src/google/sheetsErrors');
const { createFakeSheetsApi, googleError, FAKE_SPREADSHEET_ID, HEADER } = require('./helpers/fake-sheets-api');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'sheets-crud-demo.js');

const GOOGLE_VARS = [
  'GOOGLE_SERVICE_ACCOUNT_KEY_FILE',
  'GOOGLE_SHEETS_SPREADSHEET_ID',
  'GOOGLE_SHEETS_CONTACTS_TAB',
  'GOOGLE_SHEETS_ALLOW_TEST_WRITES',
];
const savedEnv = {};
test.before(() => {
  for (const name of GOOGLE_VARS) {
    savedEnv[name] = process.env[name];
    process.env[name] = '';
  }
});
test.after(() => {
  for (const name of GOOGLE_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

const NOW = Date.parse('2026-11-10T09:30:00.000Z');
const NOW_ISO = '2026-11-10T09:30:00.000Z';
const TEST_ID = 'TEST-DEMO-ABC123-0a1b2c3d';

const ADA = ['101', 'Ada', 'Lovelace', 'ada@example.com', 'Analytical Engines', '2026-01-01T00:00:00.000Z'];
const GRACE = ['102', 'Grace', 'Hopper', 'grace@example.com', 'Navy', '2026-02-02T00:00:00.000Z'];
const ORIGINAL = [HEADER, ADA, GRACE];

const safeEnv = (extra = {}) => ({
  GOOGLE_SHEETS_SPREADSHEET_ID: FAKE_SPREADSHEET_ID,
  GOOGLE_SHEETS_CONTACTS_TAB: 'Contacts_Test',
  GOOGLE_SHEETS_ALLOW_TEST_WRITES: 'true',
  ...extra,
});

function setup({ rows = ORIGINAL } = {}) {
  const fake = createFakeSheetsApi({ tab: 'Contacts_Test', rows });
  const client = createSheetsClient({ api: fake.api, spreadsheetId: fake.spreadsheetId, tab: 'Contacts_Test' });
  const service = createContactsSheet({ client, now: () => NOW });
  return { fake, service };
}

// Runs the demo and collects what it printed.
async function run({ env = safeEnv(), service, generateId = () => TEST_ID } = {}) {
  const lines = [];
  let created = 0;
  const result = await runCrudDemo({
    env,
    out: (line) => lines.push(line),
    createService: () => {
      created += 1;
      return service;
    },
    generateId,
    now: () => NOW,
  });
  return { result, lines, text: lines.join('\n'), created: () => created };
}

// A service that behaves like the real one except for the methods you replace.
const wrap = (service, overrides = {}) => ({
  getHeaders: (...a) => service.getHeaders(...a),
  getAllContacts: (...a) => service.getAllContacts(...a),
  findContactById: (...a) => service.findContactById(...a),
  appendContact: (...a) => service.appendContact(...a),
  updateContact: (...a) => service.updateContact(...a),
  deleteContact: (...a) => service.deleteContact(...a),
  ...overrides,
});

function assertSheetUnchanged(fake) {
  assert.deepEqual(fake.snapshot(), ORIGINAL, 'the worksheet is exactly as it was');
}

// Every delete request must target the test row (the first row after the original data) and nothing else.
function assertOnlyTestRowDeleted(fake, expectedDeletes) {
  const deletes = fake.callsOf('spreadsheets.batchUpdate');
  assert.equal(deletes.length, expectedDeletes);
  for (const call of deletes) {
    const range = call.params.requestBody.requests[0].deleteDimension.range;
    assert.equal(range.startIndex, ORIGINAL.length, 'only the test row is targeted');
    assert.equal(range.endIndex, ORIGINAL.length + 1);
  }
}

function assertSafeOutput(text) {
  for (const secret of [FAKE_SPREADSHEET_ID, 'fake-sa@', 'ya29.', 'PRIVATE KEY', 'Bearer', 'ada@example.com', 'grace@example.com', 'Lovelace', 'Hopper']) {
    assert.ok(!text.includes(secret), `output must not contain: ${secret}`);
  }
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

// --- safety: refusals --------------------------------------------------------------

async function assertRefused(env) {
  const { fake, service } = setup();
  const { result, text, created } = await run({ env, service });
  assert.equal(result.exitCode, 2);
  assert.equal(result.ok, false);
  assert.equal(result.refused, true);
  assert.equal(created(), 0, 'the Google service is never even created');
  assert.equal(fake.calls.length, 0, 'not a single request reached the (fake) spreadsheet');
  assert.match(text, /REFUSED/);
  assert.match(text, /Overall status: REFUSED/);
  assert.match(text, /Nothing was sent to Google/);
  assertSafeOutput(text);
  return text;
}

test('refuses when the worksheet is Contacts (the real contact list)', async () => {
  const text = await assertRefused(safeEnv({ GOOGLE_SHEETS_CONTACTS_TAB: 'Contacts' }));
  assert.match(text, /only ever writes to Contacts_Test/);
});

test('refuses when the worksheet setting is missing or empty (it never falls back to a default)', async () => {
  const missing = safeEnv();
  delete missing.GOOGLE_SHEETS_CONTACTS_TAB;
  assert.match(await assertRefused(missing), /is not set/);
  await assertRefused(safeEnv({ GOOGLE_SHEETS_CONTACTS_TAB: '' }));
  await assertRefused(safeEnv({ GOOGLE_SHEETS_CONTACTS_TAB: undefined }));
});

test('refuses any other worksheet name, including look-alikes', async () => {
  for (const tab of ['Other', 'Archive', 'Contacts_Test2', 'Contacts_Tes', 'contacts_test', 'CONTACTS_TEST', ' Contacts_Test', 'Contacts_Test ', 'Contacts_Test\n', 'Contacts Test', 'Contacts_Test/Contacts']) {
    await assertRefused(safeEnv({ GOOGLE_SHEETS_CONTACTS_TAB: tab }));
  }
});

test('refuses when the explicit write opt-in is missing', async () => {
  const env = safeEnv();
  delete env.GOOGLE_SHEETS_ALLOW_TEST_WRITES;
  assert.match(await assertRefused(env), /GOOGLE_SHEETS_ALLOW_TEST_WRITES is not exactly "true"/);
  await assertRefused(safeEnv({ GOOGLE_SHEETS_ALLOW_TEST_WRITES: '' }));
});

test('refuses unless the opt-in is exactly the text true', async () => {
  for (const value of ['false', 'TRUE', 'True', 'tRue', '1', 'yes', 'on', ' true', 'true ', 'true\n', 'truee', true, 1]) {
    await assertRefused(safeEnv({ GOOGLE_SHEETS_ALLOW_TEST_WRITES: value }));
  }
});

test('refuses when the spreadsheet ID is missing or malformed', async () => {
  const missing = safeEnv();
  delete missing.GOOGLE_SHEETS_SPREADSHEET_ID;
  assert.match(await assertRefused(missing), /SPREADSHEET_ID_MISSING/);
  assert.match(await assertRefused(safeEnv({ GOOGLE_SHEETS_SPREADSHEET_ID: '  ' })), /SPREADSHEET_ID_MISSING/);
  assert.match(await assertRefused(safeEnv({ GOOGLE_SHEETS_SPREADSHEET_ID: 'not an id!' })), /SPREADSHEET_ID_INVALID/);
});

test('reports every failed safety check at once', async () => {
  const { text } = await run({
    env: { GOOGLE_SHEETS_CONTACTS_TAB: 'Contacts', GOOGLE_SHEETS_ALLOW_TEST_WRITES: 'no' },
    service: setup().service,
  });
  assert.equal((text.match(/^ {2}- /gm) || []).length, 3);
});

test('refuses with no settings at all, and with a missing environment object', async () => {
  await assertRefused({});
  const { result } = await run({ env: undefined === null ? null : {}, service: setup().service });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(checkSafety(undefined).length, 3);
  assert.deepEqual(checkSafety(null).length, 3);
});

test('the checks also hold when everything looks right except one setting (each alone is enough to refuse)', async () => {
  for (const bad of [{ GOOGLE_SHEETS_CONTACTS_TAB: 'Contacts' }, { GOOGLE_SHEETS_ALLOW_TEST_WRITES: 'false' }, { GOOGLE_SHEETS_SPREADSHEET_ID: '' }]) {
    assert.equal(checkSafety(safeEnv(bad)).length, 1);
  }
  assert.deepEqual(checkSafety(safeEnv()), []);
});

test('with safe settings but no injected service, the demo will not use a service built from a different environment', async () => {
  const lines = [];
  const result = await runCrudDemo({ env: safeEnv(), out: (l) => lines.push(l) }); // env is not process.env
  assert.equal(result.exitCode, 1);
  assert.match(lines.join('\n'), /Could not start the Google Sheets service: INVALID_INPUT/);
  assertSafeOutput(lines.join('\n'));
});

// --- the successful sequence --------------------------------------------------------

test('a successful run performs create, read, update, read, delete, read and leaves the sheet unchanged', async () => {
  const { fake, service } = setup();
  const { result, lines, text } = await run({ service });

  assert.deepEqual(result, { ok: true, refused: false, exitCode: 0, testContactId: TEST_ID });
  assert.equal(lines.filter((l) => /^\[\d+\/10\] .*: OK/.test(l)).length, 10, 'all ten steps reported OK');
  assert.doesNotMatch(text, /FAILED|Cleanup|Stopped/);
  assert.match(text, /Test Contact ID for this run: TEST-DEMO-ABC123-0a1b2c3d/);
  assert.match(text, /Worksheet: Contacts_Test/);
  assert.match(text, /Read the worksheet headers: OK \(Contact ID \| First Name \| Last Name \| Email \| Company \| Created Date\)/);
  assert.match(text, /2 existing contact\(s\)/);
  assert.match(text, /Update: change the Company of the sample: OK/);
  assert.match(text, /Read: verify the updated Company: OK/);
  assert.match(text, /Read: verify the sample is gone: OK/);
  assert.match(text, /identical to the baseline/);
  assert.match(text, /Overall status: SUCCESS/);
  assertSheetUnchanged(fake);
  assertSafeOutput(text);
});

test('the real requests: one append, one update of the same row, one delete of the same row - nothing else', async () => {
  const { fake, service } = setup();
  await run({ service });

  const writes = fake.writeCalls();
  assert.deepEqual(writes.map((c) => c.method), ['values.append', 'values.update', 'spreadsheets.batchUpdate']);

  const [append, update] = [writes[0], writes[1]];
  assert.deepEqual(append.params.requestBody.values, [[TEST_ID, 'Demo', 'Test', `${TEST_ID.toLowerCase()}@example.invalid`, 'Demo Company (test)', NOW_ISO]]);
  assert.equal(update.params.range, "'Contacts_Test'!A4:F4", 'the third data row, i.e. the sample');
  assert.deepEqual(update.params.requestBody.values, [[TEST_ID, 'Demo', 'Test', `${TEST_ID.toLowerCase()}@example.invalid`, 'Demo Company UPDATED (test)', NOW_ISO]]);
  assertOnlyTestRowDeleted(fake, 1);

  // Every request went to the one configured spreadsheet and the Contacts_Test worksheet.
  for (const call of fake.calls) {
    assert.equal(call.params.spreadsheetId, FAKE_SPREADSHEET_ID);
    if (call.params.range) assert.match(call.params.range, /^'Contacts_Test'!/);
  }
  const allowed = new Set(['values.get', 'values.append', 'values.update', 'spreadsheets.get', 'spreadsheets.batchUpdate']);
  assert.ok(fake.calls.every((c) => allowed.has(c.method)));
});

test('the sample record is clearly a test record', async () => {
  const { fake, service } = setup();
  await run({ service });
  const [append] = fake.callsOf('values.append');
  const row = append.params.requestBody.values[0];
  assert.match(row[0], /^TEST-DEMO-/);
  assert.match(row[3], /@example\.invalid$/);
  assert.match(row[4], /\(test\)$/);
});

// --- the unique test Contact ID ------------------------------------------------------

test('generated test IDs are marked, valid for the service, and unique', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i += 1) {
    const id = generateTestContactId();
    assert.match(id, /^TEST-DEMO-[0-9A-Z]+-[0-9a-f]{8}$/);
    assert.ok(id.length <= 64);
    ids.add(id);
  }
  assert.equal(ids.size, 200, 'no collisions');
});

test('ID generation is deterministic when the clock and the random source are injected', () => {
  const id = generateTestContactId({ now: () => 1000, randomBytes: () => Buffer.from('deadbeef', 'hex') });
  assert.equal(id, `TEST-DEMO-${(1000).toString(36).toUpperCase()}-deadbeef`);
  const later = generateTestContactId({ now: () => 2000, randomBytes: () => Buffer.from('deadbeef', 'hex') });
  assert.notEqual(id, later);
});

test('a default-generated ID goes through the whole run and is reported', async () => {
  const { fake, service } = setup();
  const lines = [];
  const result = await runCrudDemo({ env: safeEnv(), out: (l) => lines.push(l), createService: () => service, now: () => NOW });
  assert.equal(result.exitCode, 0);
  assert.match(result.testContactId, /^TEST-DEMO-[0-9A-Z]+-[0-9a-f]{8}$/);
  assert.ok(lines.join('\n').includes(result.testContactId));
  assertSheetUnchanged(fake);
});

test('if the generated ID somehow exists already, the run stops before writing anything', async () => {
  const rows = [HEADER, ADA, [TEST_ID, 'Someone', 'Else']];
  const { fake, service } = setup({ rows });
  const { result, text } = await run({ service });
  assert.equal(result.exitCode, 1);
  assert.match(text, /already exists; nothing was written/);
  assert.equal(fake.writeCalls().length, 0);
  assert.doesNotMatch(text, /Cleanup/, 'nothing was created, so there is nothing to clean up (and the existing row is left alone)');
  assert.deepEqual(fake.snapshot(), rows);
});

// --- verification of update and delete -----------------------------------------------

test('update verification: an update that returns the wrong Company fails the run and is cleaned up', async () => {
  const { fake, service } = setup();
  const lying = wrap(service, { updateContact: async () => ({ contact: { company: 'something else' }, rowNumber: 4 }) });
  const { result, text } = await run({ service: lying });
  assert.equal(result.exitCode, 1);
  assert.match(text, /\[6\/10\] Update: change the Company of the sample: FAILED/);
  assert.match(text, /did not return the new Company value/);
  assert.match(text, /Cleanup: the test record was removed/);
  assert.match(text, /Overall status: FAILED/);
  assertSheetUnchanged(fake);
  assertOnlyTestRowDeleted(fake, 1);
});

test('update verification: an update that claims success but changes nothing is caught when the row is read again', async () => {
  const { fake, service } = setup();
  const silent = wrap(service, { updateContact: async (id, changes) => ({ contact: { contactId: id, ...changes }, rowNumber: 4 }) });
  const { result, text } = await run({ service: silent });
  assert.equal(result.exitCode, 1);
  assert.match(text, /\[7\/10\] Read: verify the updated Company: FAILED/);
  assert.match(text, /does not show the updated Company/);
  assert.match(text, /Cleanup: the test record was removed/);
  assertSheetUnchanged(fake);
});

test('delete verification: a delete that claims success but removes nothing is caught, and cleanup really deletes the row', async () => {
  const { fake, service } = setup();
  let deleteCalls = 0;
  const silentOnce = wrap(service, {
    deleteContact: async (id) => {
      deleteCalls += 1;
      if (deleteCalls === 1) return { deleted: true, contact: { contactId: id }, rowNumber: 4 }; // claims success, does nothing
      return service.deleteContact(id); // cleanup's delete is real
    },
  });
  const { result, text } = await run({ service: silentOnce });
  assert.equal(result.exitCode, 1);
  assert.match(text, /\[9\/10\] Read: verify the sample is gone: FAILED/);
  assert.match(text, /still exists after deleting it/);
  assert.match(text, /Cleanup: the test record was removed/);
  assertSheetUnchanged(fake);
});

test('if deleting never works, cleanup says the test row is still there and asks for a manual removal of that one row', async () => {
  const { fake, service } = setup();
  const neverDeletes = wrap(service, { deleteContact: async (id) => ({ deleted: true, contact: { contactId: id }, rowNumber: 4 }) });
  const { result, text } = await run({ service: neverDeletes });
  assert.equal(result.exitCode, 1);
  assert.match(text, /Cleanup FAILED \(The test record is still there after cleanup\.\)/);
  assert.match(text, new RegExp(`Contact ID ${TEST_ID}`));
  assert.match(text, /Do not touch any other row/);
  assert.deepEqual(fake.snapshot().slice(0, 3), ORIGINAL);
  assert.equal(fake.snapshot().length, 4, 'only the test row remains, for manual removal');
});

test('a changed baseline is detected: if another row differs at the end, the run fails', async () => {
  const { fake, service } = setup();
  // Someone edits Ada's row while the demo runs (simulated right after the delete).
  const meddling = wrap(service, {
    findContactById: async (id) => {
      const result = await service.findContactById(id);
      if (!result.found && id === TEST_ID) fake.state.grid[1][1] = 'Changed';
      return result;
    },
  });
  const { result, text } = await run({ service: meddling });
  assert.equal(result.exitCode, 1);
  assert.match(text, /differs from before the test/);
});

// --- cleanup after failures ----------------------------------------------------------

test('a failure in the middle triggers cleanup of exactly the test record', async () => {
  const { fake, service } = setup();
  // The 4th read of the sheet fails (step 4: read all contacts). Later reads work, so cleanup can finish.
  fake.hooks.beforeValuesGet = (count) => {
    if (count === 4) throw googleError(503);
  };
  const { result, text } = await run({ service });

  assert.equal(result.exitCode, 1);
  assert.match(text, /\[4\/10\] Read: all contacts include the sample: FAILED/);
  assert.match(text, /Stopped: API_UNAVAILABLE/);
  assert.match(text, /Cleanup: removing the test record created by this run/);
  assert.match(text, /Cleanup: the test record was removed/);
  assert.match(text, /Overall status: FAILED/);
  assertSheetUnchanged(fake);
  assertOnlyTestRowDeleted(fake, 1);
  assertSafeOutput(text);
});

test('an append that actually wrote the row but then reported an error is still cleaned up', async () => {
  const { fake, service } = setup();
  const flaky = wrap(service, {
    appendContact: async (contact) => {
      await service.appendContact(contact);
      throw new GoogleSheetsError('API_UNAVAILABLE');
    },
  });
  const { result, text } = await run({ service: flaky });
  assert.equal(result.exitCode, 1);
  assert.match(text, /Create: append the sample contact: FAILED/);
  assert.match(text, /Cleanup: the test record was removed/);
  assertSheetUnchanged(fake);
});

test('an append that failed before writing leaves nothing behind: cleanup finds nothing and deletes nothing', async () => {
  const { fake, service } = setup();
  fake.failNext('values.append', googleError(429));
  const { result, text } = await run({ service });
  assert.equal(result.exitCode, 1);
  assert.match(text, /Stopped: RATE_LIMITED/);
  assert.match(text, /Cleanup: the test record is not in the worksheet \(nothing to remove\)/);
  assert.equal(fake.callsOf('spreadsheets.batchUpdate').length, 0, 'no row was deleted');
  assertSheetUnchanged(fake);
});

test('a failure before anything was written does not start a cleanup', async () => {
  const wrong = setup({ rows: [['Name', 'Email'], ADA] });
  const r1 = await run({ service: wrong.service });
  assert.equal(r1.result.exitCode, 1);
  assert.match(r1.text, /\[1\/10\] Read the worksheet headers: FAILED/);
  assert.match(r1.text, /SHEET_HEADERS_MISMATCH|not the expected six columns/);
  assert.doesNotMatch(r1.text, /Cleanup/);
  assert.equal(wrong.fake.writeCalls().length, 0);

  const unreadable = setup();
  unreadable.fake.failNext('values.get', googleError(403));
  const r2 = await run({ service: unreadable.service });
  assert.equal(r2.result.exitCode, 1);
  assert.match(r2.text, /PERMISSION_DENIED/);
  assert.doesNotMatch(r2.text, /Cleanup/);
  assert.equal(unreadable.fake.writeCalls().length, 0);
});

test('if cleanup itself fails, the run says so, names the test ID, and deletes nothing else', async () => {
  const { fake, service } = setup();
  let appended = false;
  const broken = wrap(service, {
    appendContact: async (contact) => {
      const r = await service.appendContact(contact);
      appended = true;
      return r;
    },
    getAllContacts: async () => {
      if (appended) throw new GoogleSheetsError('API_UNAVAILABLE');
      return service.getAllContacts();
    },
    findContactById: async () => {
      throw new GoogleSheetsError('API_UNAVAILABLE');
    },
  });
  const { result, text } = await run({ service: broken });

  assert.equal(result.exitCode, 1);
  assert.match(text, /Cleanup FAILED \(API_UNAVAILABLE/);
  assert.match(text, new RegExp(`delete the row with Contact ID ${TEST_ID} in the Contacts_Test worksheet by hand`));
  assert.match(text, /Do not touch any other row/);
  assert.match(text, /Overall status: FAILED/);
  assert.equal(fake.callsOf('spreadsheets.batchUpdate').length, 0, 'nothing was deleted');
  assert.deepEqual(fake.snapshot().slice(0, 3), ORIGINAL, 'the original rows are intact');
  assert.equal(fake.snapshot()[3][0], TEST_ID, 'only the test row is left, to be removed by hand');
});

test('cleanup refuses to guess if the test ID appears twice, and deletes nothing', async () => {
  const { fake, service } = setup();
  const duplicating = wrap(service, {
    appendContact: async (contact) => {
      const r = await service.appendContact(contact);
      fake.state.grid.push([...fake.state.grid[fake.state.grid.length - 1]]); // a second row with the same ID
      throw new GoogleSheetsError('API_UNAVAILABLE', { reason: 'ECONNRESET' });
      return r; // eslint-disable-line no-unreachable
    },
  });
  const { result, text } = await run({ service: duplicating });
  assert.equal(result.exitCode, 1);
  assert.match(text, /Cleanup FAILED \(DUPLICATE_CONTACT/);
  assert.match(text, /by hand/);
  assert.equal(fake.callsOf('spreadsheets.batchUpdate').length, 0, 'no row was deleted because it was ambiguous');
  assert.equal(fake.snapshot().filter((row) => row[0] === TEST_ID).length, 2);
  assert.deepEqual(fake.snapshot().slice(0, 3), ORIGINAL);
});

test('no other contact is ever deleted or changed, in any scenario', async () => {
  const scenarios = [
    (f) => {
      f.hooks.beforeValuesGet = (count) => {
        if (count === 5) throw googleError(500);
      };
    },
    (f) => f.failNext('values.update', googleError(503)),
    (f) => f.failNext('spreadsheets.batchUpdate', googleError(503)),
    () => {},
  ];
  for (const arrange of scenarios) {
    const { fake, service } = setup();
    arrange(fake);
    await run({ service });
    for (const call of fake.callsOf('spreadsheets.batchUpdate')) {
      const range = call.params.requestBody.requests[0].deleteDimension.range;
      assert.ok(range.startIndex >= ORIGINAL.length, 'a delete never reaches the original rows');
      assert.equal(range.endIndex - range.startIndex, 1, 'one row at a time');
    }
    for (const call of fake.callsOf('values.update')) assert.match(call.params.range, /^'Contacts_Test'!A4:F4$/);
    assert.deepEqual(fake.snapshot().slice(0, 3), ORIGINAL, 'header and the two existing contacts are intact');
  }
});

// --- safe output ---------------------------------------------------------------------

test('Google errors are shown as a code and a fixed message, never as Google text, and nothing uses console directly', async () => {
  const spy = captureConsole();
  let text;
  try {
    const { fake, service } = setup();
    fake.failNext('values.update', googleError(500)); // message holds the spreadsheet ID, an e-mail and a token
    ({ text } = await run({ service }));
  } finally {
    spy.restore();
  }
  assert.match(text, /Stopped: API_UNAVAILABLE - The Google Sheets API is temporarily unavailable\./);
  assertSafeOutput(text);
  assert.deepEqual(spy.lines, [], 'all output goes through the injected output function');
});

test('an unexpected error type is shown only as "Unexpected error"', async () => {
  const { service } = setup();
  const odd = wrap(service, {
    getAllContacts: async () => {
      throw new TypeError(`internal detail ${FAKE_SPREADSHEET_ID} ya29.fake-token`);
    },
  });
  const { result, text } = await run({ service: odd });
  assert.equal(result.exitCode, 1);
  assert.match(text, /Stopped: Unexpected error/);
  assertSafeOutput(text);
});

// --- running the real script as a program (refusals only) ----------------------------

function runScript(env) {
  const out = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 20000 });
  return { status: out.status, text: `${out.stdout}\n${out.stderr}` };
}

test('as a program: with the wrong worksheet it refuses with exit code 2 and contacts nothing', () => {
  const { status, text } = runScript({
    GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '',
    GOOGLE_SHEETS_SPREADSHEET_ID: FAKE_SPREADSHEET_ID,
    GOOGLE_SHEETS_CONTACTS_TAB: 'Contacts',
    GOOGLE_SHEETS_ALLOW_TEST_WRITES: 'true',
  });
  assert.equal(status, 2);
  assert.match(text, /Overall status: REFUSED/);
  assert.ok(!text.includes(FAKE_SPREADSHEET_ID));
});

test('as a program: without the opt-in it refuses with exit code 2 and contacts nothing', () => {
  const { status, text } = runScript({
    GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '',
    GOOGLE_SHEETS_SPREADSHEET_ID: FAKE_SPREADSHEET_ID,
    GOOGLE_SHEETS_CONTACTS_TAB: 'Contacts_Test',
    GOOGLE_SHEETS_ALLOW_TEST_WRITES: '',
  });
  assert.equal(status, 2);
  assert.match(text, /GOOGLE_SHEETS_ALLOW_TEST_WRITES is not exactly "true"/);
});

// --- boundaries ----------------------------------------------------------------------

test('the demo is wired as an npm script but is not part of npm test', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['sheets:crud-demo'], 'node scripts/sheets-crud-demo.js');
  assert.equal(pkg.scripts.test, 'node --test "tests/*.test.js"');
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name !== 'sheets:crud-demo') assert.ok(!command.includes('crud-demo'), `${name} must not run the demo`);
  }
  for (const name of ['start', 'dev', 'events:failed', 'oauth:status', 'sheets:status']) assert.ok(pkg.scripts[name], name);
});

test('the source reuses the contacts service only: no HubSpot, no direct Google calls, no hardcoded IDs or paths', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /require\(['"]\.\.\/src\/(oauth|security|webhooks|idempotency)/, 'no HubSpot code');
  assert.doesNotMatch(source, /hubapi|api\.hubspot|hubspot\.com/i, 'no HubSpot API');
  assert.doesNotMatch(source, /@googleapis|googleapis|sheetsClient|\.spreadsheets\.|\.values\b/, 'no direct Google calls');
  assert.doesNotMatch(source, /Google-Credentials|nifty-stage|BEGIN (RSA )?PRIVATE KEY|[A-Za-z]:\\\\/, 'no hardcoded path or key');
  assert.doesNotMatch(source, /1[A-Za-z0-9_-]{43}/, 'no spreadsheet ID literal');
  assert.doesNotMatch(source, /console\.(log|info|warn|debug)\s*\(/, 'prints only through the output function');
});

test('.env is loaded only when the script is run directly, never when it is imported', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  const loadAt = source.indexOf("require('dotenv')");
  assert.ok(loadAt > 0);
  assert.ok(loadAt > source.indexOf('if (require.main === module)'));
  assert.equal(source.split("require('dotenv')").length - 1, 1);
});

test('no test file starts the demo with real settings (the only spawned runs are the two refusals above)', () => {
  const testsDir = __dirname;
  for (const name of fs.readdirSync(testsDir).filter((f) => f.endsWith('.test.js'))) {
    const source = fs.readFileSync(path.join(testsDir, name), 'utf8');
    if (name === 'sheets-crud-demo.test.js') continue;
    // Mentioning the file name (for example in an allowlist) is fine; running or importing it is not.
    assert.doesNotMatch(source, /(spawn|exec|fork)\w*\([^)]*sheets-crud-demo|require\([^)]*sheets-crud-demo|sheets:crud-demo/, `${name} must not run the demo`);
  }
});
