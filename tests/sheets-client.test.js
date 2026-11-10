// tests/sheets-client.test.js
//
// Tests src/google/sheetsClient.js (Phase 2, step 6).
// The Google Sheets API is replaced by an in-memory fake (tests/helpers/fake-sheets-api.js)
// and sign-in by a stand-in object. The real key, the real spreadsheet and Google itself are
// never used. All Google settings in the environment are blanked while these tests run, so
// even a mistake could not reach the real spreadsheet.
//
// Run with:  node --test tests/sheets-client.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSheetsClient, getSheetsClient, resetSheetsClient, rangeFor } = require('../src/google/sheetsClient');
const { GoogleSheetsError } = require('../src/google/sheetsErrors');
const { createFakeSheetsApi, googleError, FAKE_SPREADSHEET_ID, HEADER } = require('./helpers/fake-sheets-api');

const GOOGLE_VARS = ['GOOGLE_SERVICE_ACCOUNT_KEY_FILE', 'GOOGLE_SHEETS_SPREADSHEET_ID', 'GOOGLE_SHEETS_CONTACTS_TAB'];
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
  resetSheetsClient();
});

const ROWS = [HEADER, ['1', 'Ada', 'Lovelace', 'ada@example.com', 'Analytical', '2026-01-01T00:00:00.000Z']];

function setup(options = {}) {
  const fake = createFakeSheetsApi({ rows: ROWS, ...options });
  const client = createSheetsClient({ api: fake.api, spreadsheetId: fake.spreadsheetId, tab: options.clientTab || fake.tab });
  return { fake, client };
}

function assertSafe(err) {
  const text = [err.message, err.stack || '', JSON.stringify(err)].join('\n');
  for (const secret of [FAKE_SPREADSHEET_ID, 'fake-sa@', 'ya29.']) assert.ok(!text.includes(secret), `error must not contain ${secret}`);
}

async function assertRejectsCode(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof GoogleSheetsError, 'must be a GoogleSheetsError');
    assert.equal(err.code, code);
    assertSafe(err);
    return true;
  });
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

// --- creating a client --------------------------------------------------------------

test('createSheetsClient validates what it is given', () => {
  const { api } = createFakeSheetsApi();
  const good = { api, spreadsheetId: FAKE_SPREADSHEET_ID, tab: 'Contacts' };
  assert.doesNotThrow(() => createSheetsClient(good));
  for (const bad of [
    {},
    undefined,
    { ...good, api: null },
    { ...good, api: { spreadsheets: {} } },
    { ...good, tab: '' },
    { ...good, tab: '   ' },
    { ...good, tab: 'x'.repeat(101) },
    { ...good, tab: 5 },
    { ...good, timeoutMs: 0 },
    { ...good, timeoutMs: 'soon' },
  ]) {
    assert.throws(() => createSheetsClient(bad), (e) => e instanceof GoogleSheetsError && e.code === 'INVALID_INPUT');
  }
  assert.throws(
    () => createSheetsClient({ ...good, spreadsheetId: '' }),
    (e) => e.code === 'SPREADSHEET_ID_MISSING'
  );
  assert.throws(
    () => createSheetsClient({ ...good, spreadsheetId: 'bad id!' }),
    (e) => e.code === 'SPREADSHEET_ID_INVALID'
  );
});

test('the client is frozen and does not expose the spreadsheet ID', () => {
  const { client } = setup();
  assert.ok(Object.isFrozen(client));
  assert.deepEqual(Object.keys(client).sort(), ['appendValues', 'deleteRow', 'getValues', 'getWorksheetId', 'tab', 'updateValues']);
  assert.ok(!JSON.stringify(Object.keys(client)).includes(FAKE_SPREADSHEET_ID));
  assert.ok(!Object.values(client).some((v) => v === FAKE_SPREADSHEET_ID));
});

// --- A1 ranges ----------------------------------------------------------------------

test('rangeFor quotes the tab name and doubles quotes inside it', () => {
  assert.equal(rangeFor('Contacts', 'A:F'), "'Contacts'!A:F");
  assert.equal(rangeFor("O'Brien's list", 'A1:F1'), "'O''Brien''s list'!A1:F1");
  assert.equal(rangeFor('Tab with spaces', 'A7'), "'Tab with spaces'!A7");
});

test('rangeFor rejects anything that is not plain A1 notation', () => {
  for (const bad of ['', 'A:F; DROP', "A1'!B2", 'Sheet2!A1', 'a:f', 'A0', 'A1:', ':F', 123, null, undefined, 'A1:F1:G1']) {
    assert.throws(() => rangeFor('Contacts', bad), (e) => e instanceof GoogleSheetsError && e.code === 'INVALID_INPUT', String(bad));
  }
});

// --- getValues ----------------------------------------------------------------------

test('getValues sends the right request and returns rows of text', async () => {
  const { fake, client } = setup();
  const rows = await client.getValues('A:F');

  assert.deepEqual(rows, ROWS);
  const [call] = fake.callsOf('values.get');
  assert.equal(call.params.spreadsheetId, FAKE_SPREADSHEET_ID);
  assert.equal(call.params.range, "'Contacts'!A:F");
  assert.equal(call.params.majorDimension, 'ROWS');
  assert.equal(call.params.valueRenderOption, 'FORMATTED_VALUE');
  assert.ok(call.options.timeout > 0, 'a timeout is set');
});

test('getValues: an empty range gives [], and odd cells become text', async () => {
  const empty = setup({ rows: [[]] });
  assert.deepEqual(await empty.client.getValues('A:F'), []);

  const { api } = createFakeSheetsApi();
  api.spreadsheets.values.get = async () => ({ data: { values: [[1, null, undefined, true, 'x']] } });
  const client = createSheetsClient({ api, spreadsheetId: FAKE_SPREADSHEET_ID, tab: 'Contacts' });
  assert.deepEqual(await client.getValues('A1:E1'), [['1', '', '', 'true', 'x']]);
});

test('getValues rejects badly shaped replies with UNEXPECTED_RESPONSE', async () => {
  for (const reply of [undefined, {}, { data: null }, { data: { values: 'text' } }, { data: { values: ['not a row'] } }, { data: { values: [{}] } }]) {
    const { api } = createFakeSheetsApi();
    api.spreadsheets.values.get = async () => reply;
    const client = createSheetsClient({ api, spreadsheetId: FAKE_SPREADSHEET_ID, tab: 'Contacts' });
    await assertRejectsCode(client.getValues('A:F'), 'UNEXPECTED_RESPONSE');
  }
});

// --- appendValues -------------------------------------------------------------------

test('appendValues uses RAW and INSERT_ROWS, adds the row at the bottom and returns its row number', async () => {
  const { fake, client } = setup();
  const result = await client.appendValues('A:F', [['2', 'Grace', 'Hopper', '=1+1', '', '2026-02-02T00:00:00.000Z']]);

  assert.deepEqual(result, { rowNumber: 3 });
  const [call] = fake.callsOf('values.append');
  assert.equal(call.params.spreadsheetId, FAKE_SPREADSHEET_ID);
  assert.equal(call.params.range, "'Contacts'!A:F");
  assert.equal(call.params.valueInputOption, 'RAW');
  assert.equal(call.params.insertDataOption, 'INSERT_ROWS');
  assert.equal(call.params.requestBody.majorDimension, 'ROWS');
  assert.deepEqual(fake.snapshot()[2], ['2', 'Grace', 'Hopper', '=1+1', '', '2026-02-02T00:00:00.000Z']);
  assert.deepEqual(fake.snapshot()[0], HEADER, 'the header row is untouched');
});

test('appendValues: rowNumber is null when Google does not say where the row went', async () => {
  const { api } = createFakeSheetsApi();
  api.spreadsheets.values.append = async () => ({ data: {} });
  const client = createSheetsClient({ api, spreadsheetId: FAKE_SPREADSHEET_ID, tab: 'Contacts' });
  assert.deepEqual(await client.appendValues('A:F', [['x']]), { rowNumber: null });
});

test('appendValues / updateValues reject unusable rows before any request is made', async () => {
  const { fake, client } = setup();
  const tooMany = Array.from({ length: 101 }, () => ['x']);
  for (const rows of [undefined, [], 'x', [[]], [['ok'], 'bad'], [[{}]], [[NaN]], [[Infinity]], [[() => 1]], [['x'.repeat(50001)]], tooMany]) {
    await assertRejectsCode(client.appendValues('A:F', rows), 'INVALID_INPUT');
    await assertRejectsCode(client.updateValues('A2:F2', rows), 'INVALID_INPUT');
  }
  assert.equal(fake.writeCalls().length, 0);
});

// --- updateValues -------------------------------------------------------------------

test('updateValues overwrites only the given range, with RAW', async () => {
  const { fake, client } = setup();
  const result = await client.updateValues('A2:F2', [['1', 'Augusta', 'King', 'a@example.com', 'X', '2026-01-01T00:00:00.000Z']]);

  assert.deepEqual(result, { updatedCells: 6 });
  const [call] = fake.callsOf('values.update');
  assert.equal(call.params.range, "'Contacts'!A2:F2");
  assert.equal(call.params.valueInputOption, 'RAW');
  assert.equal(fake.snapshot()[1][1], 'Augusta');
  assert.deepEqual(fake.snapshot()[0], HEADER);
});

// --- getWorksheetId -----------------------------------------------------------------

test('getWorksheetId asks for tab metadata only and finds the tab', async () => {
  const { fake, client } = setup();
  assert.equal(await client.getWorksheetId(), fake.sheetId);
  const [call] = fake.callsOf('spreadsheets.get');
  assert.equal(call.params.fields, 'sheets.properties(sheetId,title)');
  assert.equal(call.params.includeGridData, false);
  assert.equal(fake.callsOf('values.get').length, 0, 'no cell data was requested');
});

test('getWorksheetId: a missing tab is WORKSHEET_NOT_FOUND (the exact name is required)', async () => {
  const { client } = setup({ clientTab: 'Nope' });
  await assertRejectsCode(client.getWorksheetId(), 'WORKSHEET_NOT_FOUND');
  const lower = setup({ clientTab: 'contacts' });
  await assertRejectsCode(lower.client.getWorksheetId(), 'WORKSHEET_NOT_FOUND');
});

test('getWorksheetId rejects unexpected replies', async () => {
  for (const reply of [{}, { data: {} }, { data: { sheets: 'x' } }, { data: { sheets: [{ properties: { title: 'Contacts', sheetId: 'abc' } }] } }]) {
    const { api } = createFakeSheetsApi();
    api.spreadsheets.get = async () => reply;
    const client = createSheetsClient({ api, spreadsheetId: FAKE_SPREADSHEET_ID, tab: 'Contacts' });
    await assertRejectsCode(client.getWorksheetId(), 'UNEXPECTED_RESPONSE');
  }
});

// --- missing worksheet --------------------------------------------------------------

test('a missing worksheet is reported as WORKSHEET_NOT_FOUND by every range call (and is never created)', async () => {
  const { fake, client } = setup({ clientTab: 'Nope' });
  await assertRejectsCode(client.getValues('A:F'), 'WORKSHEET_NOT_FOUND');
  await assertRejectsCode(client.appendValues('A:F', [['x']]), 'WORKSHEET_NOT_FOUND');
  await assertRejectsCode(client.updateValues('A2:F2', [['x']]), 'WORKSHEET_NOT_FOUND');
  await assertRejectsCode(client.deleteRow(2), 'WORKSHEET_NOT_FOUND');
  assert.equal(fake.callsOf('spreadsheets.create').length, 0);
  assert.deepEqual(fake.snapshot(), ROWS);
});

test('a 400 for an existing tab stays INVALID_INPUT (it is not mistaken for a missing tab)', async () => {
  const { fake, client } = setup();
  fake.failNext('values.get', googleError(400));
  await assertRejectsCode(client.getValues('A:F'), 'INVALID_INPUT');
});

// --- deleteRow ----------------------------------------------------------------------

test('deleteRow removes exactly one row with a deleteDimension request', async () => {
  const rows = [HEADER, ['1', 'A'], ['2', 'B'], ['3', 'C']];
  const { fake, client } = setup({ rows });

  assert.deepEqual(await client.deleteRow(3), { deleted: true });

  const [call] = fake.callsOf('spreadsheets.batchUpdate');
  assert.equal(call.params.spreadsheetId, FAKE_SPREADSHEET_ID);
  assert.deepEqual(call.params.requestBody, {
    requests: [{ deleteDimension: { range: { sheetId: fake.sheetId, dimension: 'ROWS', startIndex: 2, endIndex: 3 } } }],
  });
  assert.deepEqual(fake.snapshot(), [HEADER, ['1', 'A'], ['3', 'C']]);
});

test('deleteRow refuses the header row and bad row numbers without calling Google', async () => {
  const { fake, client } = setup();
  for (const bad of [1, 0, -1, 1.5, '3', null, undefined, NaN]) {
    await assertRejectsCode(client.deleteRow(bad), 'INVALID_INPUT');
  }
  assert.equal(fake.calls.length, 0);
});

// --- Google errors ------------------------------------------------------------------

test('Google errors become safe GoogleSheetsError codes for every method', async () => {
  const table = [
    [403, 'PERMISSION_DENIED', false],
    [404, 'SPREADSHEET_NOT_FOUND', false],
    [401, 'AUTH_FAILED', false],
    [429, 'RATE_LIMITED', true],
    [500, 'API_UNAVAILABLE', true],
    [503, 'API_UNAVAILABLE', true],
  ];
  const methods = [
    ['values.get', (c) => c.getValues('A:F')],
    ['values.append', (c) => c.appendValues('A:F', [['x']])],
    ['values.update', (c) => c.updateValues('A2:F2', [['x']])],
    ['spreadsheets.get', (c) => c.getWorksheetId()],
    ['spreadsheets.batchUpdate', (c) => c.deleteRow(2)],
  ];
  for (const [method, run] of methods) {
    for (const [status, code, retryable] of table) {
      const { fake, client } = setup();
      fake.failNext(method, googleError(status));
      await assert.rejects(run(client), (err) => {
        assert.ok(err instanceof GoogleSheetsError);
        assert.equal(err.code, code, `${method} ${status}`);
        assert.equal(err.retryable, retryable);
        assertSafe(err);
        return true;
      });
    }
  }
});

test('network failures become API_UNAVAILABLE (retryable) and keep none of the original text', async () => {
  for (const code of ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT']) {
    const { fake, client } = setup();
    fake.failNext('values.get', Object.assign(new Error(`${code} for ${FAKE_SPREADSHEET_ID} ya29.fake-token`), { code }));
    await assert.rejects(client.getValues('A:F'), (err) => {
      assert.equal(err.code, 'API_UNAVAILABLE');
      assert.equal(err.retryable, true);
      assertSafe(err);
      return true;
    });
  }
});

test('a failed write leaves the sheet unchanged', async () => {
  const { fake, client } = setup();
  fake.failNext('values.append', googleError(429));
  await assertRejectsCode(client.appendValues('A:F', [['9']]), 'RATE_LIMITED');
  fake.failNext('spreadsheets.batchUpdate', googleError(503));
  await assertRejectsCode(client.deleteRow(2), 'API_UNAVAILABLE');
  assert.deepEqual(fake.snapshot(), ROWS);
});

test('a non-HTTP failure is INTERNAL_ERROR, never the original error', async () => {
  const { fake, client } = setup();
  fake.failNext('values.get', new TypeError(`boom ${FAKE_SPREADSHEET_ID}`));
  await assertRejectsCode(client.getValues('A:F'), 'INTERNAL_ERROR');
});

// --- the shared client --------------------------------------------------------------

function makeInit({ env, authError, apiError } = {}) {
  const fake = createFakeSheetsApi({ rows: ROWS });
  const counters = { auth: 0, api: 0, authArgs: [] };
  return {
    fake,
    counters,
    options: {
      env: env || { GOOGLE_SHEETS_SPREADSHEET_ID: fake.spreadsheetId, GOOGLE_SHEETS_CONTACTS_TAB: 'Contacts' },
      getAuth: () => {
        counters.auth += 1;
        if (authError) throw authError;
        return { fakeAuth: true };
      },
      createApi: (auth) => {
        counters.api += 1;
        counters.authArgs.push(auth);
        if (apiError) throw apiError;
        return fake.api;
      },
    },
  };
}

test('getSheetsClient builds the client once from the existing auth + settings and reuses it', async () => {
  resetSheetsClient();
  const { counters, options, fake } = makeInit();

  const first = getSheetsClient(options);
  const second = getSheetsClient(options);

  assert.equal(first, second, 'the same client object is returned');
  assert.equal(counters.auth, 1, 'sign-in object created once');
  assert.equal(counters.api, 1, 'Sheets API object created once');
  assert.deepEqual(counters.authArgs, [{ fakeAuth: true }], 'the API is built from the sign-in object');
  assert.equal(first.tab, 'Contacts');
  assert.deepEqual(await first.getValues('A:F'), ROWS);
  assert.equal(fake.callsOf('values.get')[0].params.spreadsheetId, fake.spreadsheetId);
  resetSheetsClient();
});

test('resetSheetsClient makes the next call build a fresh client', () => {
  resetSheetsClient();
  const { counters, options } = makeInit();
  const first = getSheetsClient(options);
  resetSheetsClient();
  const second = getSheetsClient(options);
  assert.notEqual(first, second);
  assert.equal(counters.api, 2);
  resetSheetsClient();
});

test('the worksheet name comes from the settings', () => {
  resetSheetsClient();
  const { options, fake } = makeInit();
  options.env = { GOOGLE_SHEETS_SPREADSHEET_ID: fake.spreadsheetId, GOOGLE_SHEETS_CONTACTS_TAB: 'Archive' };
  assert.equal(getSheetsClient(options).tab, 'Archive');
  resetSheetsClient();
});

test('start-up problems are GoogleSheetsErrors and a failed start is NOT remembered', () => {
  resetSheetsClient();
  const good = makeInit();

  // No spreadsheet ID in the settings.
  assert.throws(() => getSheetsClient({ ...good.options, env: {} }), (e) => e.code === 'SPREADSHEET_ID_MISSING');
  // No key file.
  assert.throws(
    () => getSheetsClient({ ...good.options, getAuth: () => { throw new GoogleSheetsError('CONFIG_MISSING'); } }),
    (e) => e.code === 'CONFIG_MISSING'
  );
  // The API object cannot be built: the original error is hidden.
  assert.throws(
    () => getSheetsClient({ ...good.options, createApi: () => { throw new Error('boom ya29.fake-token'); } }),
    (e) => {
      assert.equal(e.code, 'INTERNAL_ERROR');
      assertSafe(e);
      return true;
    }
  );
  // After all those failures a correct start still works.
  assert.ok(getSheetsClient(good.options));
  resetSheetsClient();
});

test('without injected fakes the shared client fails closed (the blanked settings never reach Google)', () => {
  resetSheetsClient();
  assert.throws(() => getSheetsClient(), (e) => e instanceof GoogleSheetsError && e.code === 'SPREADSHEET_ID_MISSING');
});

// --- logging and source -------------------------------------------------------------

test('nothing is ever logged, on success or failure', async () => {
  const spy = captureConsole();
  try {
    const { fake, client } = setup();
    await client.getValues('A:F');
    await client.appendValues('A:F', [['5']]);
    await client.updateValues('A2:F2', [['1']]);
    await client.deleteRow(2);
    fake.failNext('values.get', googleError(403));
    await client.getValues('A:F').catch(() => {});
    resetSheetsClient();
    try {
      getSheetsClient({ env: {} });
    } catch {
      // expected
    }
  } finally {
    spy.restore();
  }
  assert.deepEqual(spy.lines, []);
});

test('the source requests RAW only, has no HubSpot imports and no hardcoded IDs, paths or keys', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'google', 'sheetsClient.js'), 'utf8');
  assert.doesNotMatch(source, /USER_ENTERED/);
  assert.match(source, /valueInputOption: 'RAW'/);
  assert.doesNotMatch(source, /require\(['"]\.\.\/(oauth|security|webhooks|idempotency)/, 'no HubSpot code');
  assert.doesNotMatch(source, /require\(['"]\.\/oauth/, 'no HubSpot OAuth');
  assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)\s*\(/, 'never logs');
  assert.doesNotMatch(source, /Google-Credentials|nifty-stage|BEGIN (RSA )?PRIVATE KEY|[A-Za-z]:\\\\/, 'no hardcoded path or key');
  assert.doesNotMatch(source, /1[A-Za-z0-9_-]{43}/, 'no spreadsheet ID literal');
  assert.doesNotMatch(source, /\.(clear|batchClear|create)\(/, 'no clear/create calls');
});
