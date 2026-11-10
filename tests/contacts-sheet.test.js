// tests/contacts-sheet.test.js
//
// Tests src/google/contactsSheet.js (Phase 2, step 6).
// The service runs on the REAL sheetsClient.js, but the Google Sheets API underneath is an
// in-memory fake spreadsheet (tests/helpers/fake-sheets-api.js). The real key, the real
// spreadsheet and Google itself are never used, so nothing here can read or change real data.
// All Google settings in the environment are blanked while these tests run.
//
// Run with:  node --test tests/contacts-sheet.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createContactsSheet, getContactsSheet, resetContactsSheet, COLUMNS } = require('../src/google/contactsSheet');
const { createSheetsClient } = require('../src/google/sheetsClient');
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
  resetContactsSheet();
});

const NOW = Date.parse('2026-11-10T09:30:00.000Z');
const NOW_ISO = '2026-11-10T09:30:00.000Z';

const ADA = ['101', 'Ada', 'Lovelace', 'ada@example.com', 'Analytical Engines', '2026-01-01T00:00:00.000Z'];
const GRACE = ['102', 'Grace', 'Hopper', 'grace@example.com', 'Navy', '2026-02-02T00:00:00.000Z'];
const ALAN = ['103', 'Alan', 'Turing', 'alan@example.com', 'Bletchley', '2026-03-03T00:00:00.000Z'];

function setup({ rows = [HEADER, ADA, GRACE, ALAN], tab, clientTab } = {}) {
  const fake = createFakeSheetsApi({ rows, tab });
  const client = createSheetsClient({ api: fake.api, spreadsheetId: fake.spreadsheetId, tab: clientTab || fake.tab });
  const service = createContactsSheet({ client, now: () => NOW });
  return { fake, client, service };
}

function assertSafe(err, extraSecrets = []) {
  const text = [err.message, err.stack || '', JSON.stringify(err)].join('\n');
  for (const secret of [FAKE_SPREADSHEET_ID, 'fake-sa@', 'ya29.', ...extraSecrets]) {
    assert.ok(!text.includes(secret), `error must not contain ${secret}`);
  }
}

async function assertRejects(promise, code, field) {
  await assert.rejects(promise, (err) => {
    assert.ok(err instanceof GoogleSheetsError, `must be a GoogleSheetsError, got ${err && err.name}`);
    assert.equal(err.code, code);
    if (field !== undefined) assert.equal(err.field, field);
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

// --- basics -------------------------------------------------------------------------

test('the columns are exactly the existing sheet order', () => {
  assert.deepEqual([...COLUMNS], ['Contact ID', 'First Name', 'Last Name', 'Email', 'Company', 'Created Date']);
  assert.deepEqual([...COLUMNS], HEADER);
  assert.ok(Object.isFrozen(COLUMNS));
});

test('createContactsSheet needs a usable client', () => {
  for (const bad of [undefined, {}, { client: null }, { client: { getValues() {} } }, { client: setup().client, now: 'later' }]) {
    assert.throws(() => createContactsSheet(bad), (e) => e instanceof GoogleSheetsError && e.code === 'INVALID_INPUT');
  }
});

// --- getHeaders ---------------------------------------------------------------------

test('getHeaders returns the header row and asks only for row 1', async () => {
  const { fake, service } = setup();
  assert.deepEqual(await service.getHeaders(), HEADER);
  assert.equal(fake.callsOf('values.get')[0].params.range, "'Contacts'!A1:F1");
});

test('getHeaders shows what is there even when it is wrong, and [] for an empty sheet', async () => {
  assert.deepEqual(await setup({ rows: [['Name', 'Mail']] }).service.getHeaders(), ['Name', 'Mail']);
  assert.deepEqual(await setup({ rows: [[]] }).service.getHeaders(), []);
});

// --- getAllContacts -----------------------------------------------------------------

test('getAllContacts returns every contact with its row number', async () => {
  const { service } = setup();
  const contacts = await service.getAllContacts();
  assert.equal(contacts.length, 3);
  assert.deepEqual(contacts[0], {
    contactId: '101',
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    company: 'Analytical Engines',
    createdDate: '2026-01-01T00:00:00.000Z',
    rowNumber: 2,
  });
  assert.deepEqual(contacts.map((c) => c.rowNumber), [2, 3, 4]);
});

test('getAllContacts: empty rows are skipped but numbering stays correct; short rows are padded; cells are trimmed', async () => {
  const rows = [HEADER, ADA, [], ['  104  ', ' Only ID '], [], GRACE];
  const contacts = await setup({ rows }).service.getAllContacts();
  assert.deepEqual(contacts.map((c) => [c.contactId, c.rowNumber]), [['101', 2], ['104', 4], ['102', 6]]);
  assert.deepEqual(contacts[1], {
    contactId: '104',
    firstName: 'Only ID',
    lastName: '',
    email: '',
    company: '',
    createdDate: '',
    rowNumber: 4,
  });
});

test('getAllContacts on a sheet with only headers gives []', async () => {
  assert.deepEqual(await setup({ rows: [HEADER] }).service.getAllContacts(), []);
});

// --- findContactById ----------------------------------------------------------------

test('findContactById returns the matching contact and its row', async () => {
  const { service } = setup();
  const result = await service.findContactById('102');
  assert.equal(result.found, true);
  assert.equal(result.rowNumber, 3);
  assert.equal(result.contact.firstName, 'Grace');
  assert.equal(result.contact.email, 'grace@example.com');
});

test('findContactById returns a clear not-found result (it does not throw)', async () => {
  assert.deepEqual(await setup().service.findContactById('999'), { found: false, contact: null, rowNumber: null });
});

test('IDs are compared as trimmed text: 102, "102" and " 102 " are the same contact', async () => {
  const { service } = setup();
  for (const id of [102, '102', ' 102 ']) {
    const result = await service.findContactById(id);
    assert.equal(result.found, true, String(id));
    assert.equal(result.rowNumber, 3);
  }
});

test('findContactById rejects unusable IDs without asking Google', async () => {
  const { fake, service } = setup();
  for (const bad of [undefined, null, '', '   ', {}, [], 1.5, -1, NaN, 'a b', "x'y", '1'.repeat(65), 'a/b', true]) {
    await assertRejects(service.findContactById(bad), 'CONTACT_INVALID', 'contactId');
  }
  assert.equal(fake.calls.length, 0);
});

// --- appendContact ------------------------------------------------------------------

test('appendContact writes the row in the sheet column order, below the data', async () => {
  const { fake, service } = setup();
  const result = await service.appendContact({
    contactId: '201',
    firstName: 'Katherine',
    lastName: 'Johnson',
    email: 'kj@example.com',
    company: 'NASA',
    createdDate: '2026-05-05T10:00:00.000Z',
  });

  assert.deepEqual(result, {
    contact: {
      contactId: '201',
      firstName: 'Katherine',
      lastName: 'Johnson',
      email: 'kj@example.com',
      company: 'NASA',
      createdDate: '2026-05-05T10:00:00.000Z',
    },
    rowNumber: 5,
  });
  const sheet = fake.snapshot();
  assert.deepEqual(sheet[4], ['201', 'Katherine', 'Johnson', 'kj@example.com', 'NASA', '2026-05-05T10:00:00.000Z']);
  assert.deepEqual(sheet.slice(0, 4), [HEADER, ADA, GRACE, ALAN], 'header and old rows are untouched');
});

test('appendContact sends RAW data with INSERT_ROWS in one write', async () => {
  const { fake, service } = setup();
  await service.appendContact({ contactId: '201' });
  assert.equal(fake.writeCalls().length, 1);
  const [call] = fake.callsOf('values.append');
  assert.equal(call.params.valueInputOption, 'RAW');
  assert.equal(call.params.insertDataOption, 'INSERT_ROWS');
  assert.equal(call.params.range, "'Contacts'!A:F");
  assert.equal(call.params.requestBody.values.length, 1);
  assert.equal(call.params.requestBody.values[0].length, 6);
});

test('appendContact: only the Contact ID is required; the Created Date defaults to now; text is trimmed', async () => {
  const { fake, service } = setup();
  const { contact } = await service.appendContact({ contactId: 202, firstName: '  Ann  ' });
  assert.deepEqual(contact, { contactId: '202', firstName: 'Ann', lastName: '', email: '', company: '', createdDate: NOW_ISO });
  assert.deepEqual(fake.snapshot()[4], ['202', 'Ann', '', '', '', NOW_ISO]);
});

test('appendContact normalises dates (Date objects, date text and timestamps) to ISO-8601', async () => {
  const { service } = setup();
  const a = await service.appendContact({ contactId: '301', createdDate: new Date('2026-06-06T06:06:06.000Z') });
  const b = await service.appendContact({ contactId: '302', createdDate: '2026-07-07' });
  const c = await service.appendContact({ contactId: '303', createdDate: Date.parse('2026-08-08T08:08:08.000Z') });
  assert.equal(a.contact.createdDate, '2026-06-06T06:06:06.000Z');
  assert.equal(b.contact.createdDate, '2026-07-07T00:00:00.000Z');
  assert.equal(c.contact.createdDate, '2026-08-08T08:08:08.000Z');
});

test('values that look like formulas are stored as plain text, exactly as given', async () => {
  const { fake, service } = setup();
  await service.appendContact({ contactId: '401', company: '=HYPERLINK("http://example.invalid","x")', firstName: '+1234', lastName: '@name' });
  assert.deepEqual(fake.snapshot()[4].slice(1, 5), ['+1234', '@name', '', '=HYPERLINK("http://example.invalid","x")']);
  assert.equal(fake.callsOf('values.append')[0].params.valueInputOption, 'RAW', 'RAW means Google never evaluates it');
});

test('appendContact refuses a Contact ID that is already there and writes nothing', async () => {
  const { fake, service } = setup();
  for (const id of ['102', 102, ' 102 ']) {
    await assertRejects(service.appendContact({ contactId: id, firstName: 'Copy' }), 'DUPLICATE_CONTACT');
  }
  assert.equal(fake.writeCalls().length, 0);
  assert.equal(fake.snapshot().length, 4);
});

test('appendContact validates every field and writes nothing when something is wrong', async () => {
  const { fake, service } = setup();
  const cases = [
    [{}, 'contactId'],
    [{ contactId: '' }, 'contactId'],
    [{ contactId: 'has space' }, 'contactId'],
    [{ contactId: '1'.repeat(65) }, 'contactId'],
    [{ contactId: '5', firstName: 42 }, 'firstName'],
    [{ contactId: '5', lastName: {} }, 'lastName'],
    [{ contactId: '5', company: ['x'] }, 'company'],
    [{ contactId: '5', firstName: 'x'.repeat(1001) }, 'firstName'],
    [{ contactId: '5', company: 'two\nlines' }, 'company'],
    [{ contactId: '5', lastName: 'tab\there' }, 'lastName'],
    [{ contactId: '5', company: 'nul\u0000char' }, 'company'],
    [{ contactId: '5', email: 'not-an-email' }, 'email'],
    [{ contactId: '5', email: 'a@b' }, 'email'],
    [{ contactId: '5', email: `${'x'.repeat(250)}@example.com` }, 'email'],
    [{ contactId: '5', createdDate: 'not a date' }, 'createdDate'],
    [{ contactId: '5', createdDate: new Date('nope') }, 'createdDate'],
    [{ contactId: '5', createdDate: {} }, 'createdDate'],
    [{ contactId: '5', surprise: 'x' }, 'surprise'],
  ];
  for (const [input, field] of cases) {
    await assertRejects(service.appendContact(input), 'CONTACT_INVALID', field);
  }
  for (const bad of [undefined, null, 'text', 42, [], [['101']]]) {
    await assertRejects(service.appendContact(bad), 'CONTACT_INVALID');
  }
  assert.equal(fake.calls.length, 0, 'no request at all was sent for invalid data');
});

test('an invalid-data error names the field but never repeats the value', async () => {
  const { service } = setup();
  await assert.rejects(service.appendContact({ contactId: '5', email: 'not-an-email-SECRETVALUE' }), (err) => {
    assert.equal(err.field, 'email');
    assertSafe(err, ['SECRETVALUE']);
    return true;
  });
  await assert.rejects(service.appendContact({ contactId: 'bad id SECRETID' }), (err) => {
    assertSafe(err, ['SECRETID']);
    return true;
  });
});

// --- updateContact ------------------------------------------------------------------

test('updateContact changes only the given fields of that one row', async () => {
  const { fake, service } = setup();
  const result = await service.updateContact('102', { email: 'new@example.com', company: 'Yale' });

  assert.deepEqual(result, {
    contact: { contactId: '102', firstName: 'Grace', lastName: 'Hopper', email: 'new@example.com', company: 'Yale', createdDate: '2026-02-02T00:00:00.000Z' },
    rowNumber: 3,
  });
  assert.deepEqual(fake.snapshot(), [HEADER, ADA, ['102', 'Grace', 'Hopper', 'new@example.com', 'Yale', '2026-02-02T00:00:00.000Z'], ALAN]);
  const [call] = fake.callsOf('values.update');
  assert.equal(call.params.range, "'Contacts'!A3:F3", 'only that row is written');
  assert.equal(call.params.valueInputOption, 'RAW');
  assert.equal(fake.writeCalls().length, 1);
});

test('updateContact keeps the Created Date unless a new one is given, and never changes the Contact ID', async () => {
  const { fake, service } = setup();
  await service.updateContact('101', { firstName: 'Augusta', contactId: 101 }); // same ID is allowed
  assert.equal(fake.snapshot()[1][5], '2026-01-01T00:00:00.000Z');
  assert.equal(fake.snapshot()[1][0], '101');

  await service.updateContact('101', { createdDate: '2026-09-09T09:09:09.000Z' });
  assert.equal(fake.snapshot()[1][5], '2026-09-09T09:09:09.000Z');

  await assertRejects(service.updateContact('101', { contactId: '999', firstName: 'x' }), 'CONTACT_INVALID', 'contactId');
  assert.equal(fake.snapshot()[1][0], '101');
});

test('updateContact can empty a text field with "" or null', async () => {
  const { fake, service } = setup();
  await service.updateContact('103', { company: '', lastName: null });
  assert.deepEqual(fake.snapshot()[3], ['103', 'Alan', '', 'alan@example.com', '', '2026-03-03T00:00:00.000Z']);
});

test('updateContact never touches the header row or other contacts', async () => {
  const { fake, service } = setup();
  await service.updateContact('101', { firstName: 'Changed' });
  const sheet = fake.snapshot();
  assert.deepEqual(sheet[0], HEADER);
  assert.deepEqual(sheet[2], GRACE);
  assert.deepEqual(sheet[3], ALAN);
});

test('updateContact validates the changes before sending anything', async () => {
  const { fake, service } = setup();
  const cases = [
    [{}, null],
    [{ email: 'nope' }, 'email'],
    [{ firstName: 7 }, 'firstName'],
    [{ createdDate: null }, 'createdDate'],
    [{ createdDate: '' }, 'createdDate'],
    [{ createdDate: 'garbage' }, 'createdDate'],
    [{ surprise: 1 }, 'surprise'],
    [{ contactId: 'zzz' }, 'contactId'],
  ];
  for (const [changes, field] of cases) {
    await assertRejects(service.updateContact('101', changes), 'CONTACT_INVALID', field);
  }
  for (const bad of [undefined, null, 'x', [], 5]) {
    await assertRejects(service.updateContact('101', bad), 'CONTACT_INVALID');
  }
  await assertRejects(service.updateContact('', { firstName: 'x' }), 'CONTACT_INVALID', 'contactId');
  assert.equal(fake.calls.length, 0);
});

test('updateContact on a missing contact: CONTACT_NOT_FOUND and nothing is written', async () => {
  const { fake, service } = setup();
  await assertRejects(service.updateContact('999', { firstName: 'Ghost' }), 'CONTACT_NOT_FOUND');
  assert.equal(fake.writeCalls().length, 0);
});

test('updateContact refuses an ambiguous Contact ID (found twice) and changes nothing', async () => {
  const { fake, service } = setup({ rows: [HEADER, ADA, ['101', 'Second', 'Ada'], GRACE] });
  await assertRejects(service.updateContact('101', { firstName: 'x' }), 'DUPLICATE_CONTACT');
  assert.equal(fake.writeCalls().length, 0);
});

// --- deleteContact ------------------------------------------------------------------

test('deleteContact removes only the matching row; the rows below move up', async () => {
  const { fake, service } = setup();
  const result = await service.deleteContact('102');

  assert.deepEqual(result, {
    deleted: true,
    contact: { contactId: '102', firstName: 'Grace', lastName: 'Hopper', email: 'grace@example.com', company: 'Navy', createdDate: '2026-02-02T00:00:00.000Z' },
    rowNumber: 3,
  });
  assert.deepEqual(fake.snapshot(), [HEADER, ADA, ALAN]);
  const [call] = fake.callsOf('spreadsheets.batchUpdate');
  assert.deepEqual(call.params.requestBody.requests, [
    { deleteDimension: { range: { sheetId: fake.sheetId, dimension: 'ROWS', startIndex: 2, endIndex: 3 } } },
  ]);
  assert.equal(fake.writeCalls().length, 1);
});

test('deleteContact can remove the first and the last contact, but never the header', async () => {
  const { fake, service } = setup();
  await service.deleteContact('101');
  await service.deleteContact('103');
  assert.deepEqual(fake.snapshot(), [HEADER, GRACE]);
  for (const call of fake.callsOf('spreadsheets.batchUpdate')) {
    assert.ok(call.params.requestBody.requests[0].deleteDimension.range.startIndex >= 1, 'row 1 (index 0) is never deleted');
  }
});

test('deleteContact on a missing contact: CONTACT_NOT_FOUND and nothing is deleted', async () => {
  const { fake, service } = setup();
  await assertRejects(service.deleteContact('999'), 'CONTACT_NOT_FOUND');
  assert.equal(fake.writeCalls().length, 0);
  assert.equal(fake.snapshot().length, 4);
});

test('deleteContact refuses an ambiguous Contact ID (found twice) and deletes nothing', async () => {
  const { fake, service } = setup({ rows: [HEADER, ADA, ['101', 'Second'], GRACE] });
  await assertRejects(service.deleteContact('101'), 'DUPLICATE_CONTACT');
  assert.equal(fake.writeCalls().length, 0);
  assert.equal(fake.snapshot().length, 4);
});

test('deleteContact validates the ID', async () => {
  const { fake, service } = setup();
  for (const bad of [undefined, '', '1 2', {}, 1.5]) await assertRejects(service.deleteContact(bad), 'CONTACT_INVALID', 'contactId');
  assert.equal(fake.calls.length, 0);
});

// --- the header row is a safety check ------------------------------------------------

test('a wrong, reordered or missing header row stops every operation before any write', async () => {
  const badSheets = [
    [[]],
    [['Name', 'Email'], ADA],
    [[...HEADER].reverse().concat([]), ADA],
    [['contact id', 'First Name', 'Last Name', 'Email', 'Company', 'Created Date'], ADA], // capitals matter
    [ADA], // data where the header should be: it must NOT be overwritten or treated as a header
  ];
  for (const rows of badSheets) {
    const { fake, service } = setup({ rows });
    const before = fake.snapshot();
    await assertRejects(service.getAllContacts(), 'SHEET_HEADERS_MISMATCH');
    await assertRejects(service.findContactById('101'), 'SHEET_HEADERS_MISMATCH');
    await assertRejects(service.appendContact({ contactId: '777' }), 'SHEET_HEADERS_MISMATCH');
    await assertRejects(service.updateContact('101', { firstName: 'x' }), 'SHEET_HEADERS_MISMATCH');
    await assertRejects(service.deleteContact('101'), 'SHEET_HEADERS_MISMATCH');
    assert.equal(fake.writeCalls().length, 0);
    assert.deepEqual(fake.snapshot(), before, 'the sheet was not changed');
  }
});

test('extra spaces around header names are tolerated', async () => {
  const rows = [HEADER.map((h) => ` ${h} `), ADA];
  assert.equal((await setup({ rows }).service.getAllContacts()).length, 1);
});

// --- missing worksheet --------------------------------------------------------------

test('a missing worksheet is reported as WORKSHEET_NOT_FOUND and is never created', async () => {
  const { fake, service } = setup({ clientTab: 'DoesNotExist' });
  await assertRejects(service.getHeaders(), 'WORKSHEET_NOT_FOUND');
  await assertRejects(service.getAllContacts(), 'WORKSHEET_NOT_FOUND');
  await assertRejects(service.findContactById('101'), 'WORKSHEET_NOT_FOUND');
  await assertRejects(service.appendContact({ contactId: '1' }), 'WORKSHEET_NOT_FOUND');
  await assertRejects(service.updateContact('101', { firstName: 'x' }), 'WORKSHEET_NOT_FOUND');
  await assertRejects(service.deleteContact('101'), 'WORKSHEET_NOT_FOUND');
  assert.equal(fake.writeCalls().length, 0);
  assert.equal(fake.callsOf('spreadsheets.create').length, 0);
});

// --- Google errors and odd replies --------------------------------------------------

test('Google errors come through as safe codes for every operation', async () => {
  const table = [
    [403, 'PERMISSION_DENIED', false],
    [404, 'SPREADSHEET_NOT_FOUND', false],
    [429, 'RATE_LIMITED', true],
    [503, 'API_UNAVAILABLE', true],
  ];
  const operations = [
    (s) => s.getHeaders(),
    (s) => s.getAllContacts(),
    (s) => s.findContactById('101'),
    (s) => s.appendContact({ contactId: '700' }),
    (s) => s.updateContact('101', { firstName: 'x' }),
    (s) => s.deleteContact('101'),
  ];
  for (const run of operations) {
    for (const [status, code, retryable] of table) {
      const { fake, service } = setup();
      fake.failNext('values.get', googleError(status));
      await assert.rejects(run(service), (err) => {
        assert.ok(err instanceof GoogleSheetsError);
        assert.equal(err.code, code);
        assert.equal(err.retryable, retryable);
        assertSafe(err);
        return true;
      });
      assert.equal(fake.writeCalls().length, 0);
    }
  }
});

test('network errors are API_UNAVAILABLE (retryable) and the sheet stays as it was', async () => {
  const { fake, service } = setup();
  fake.failNext('values.update', Object.assign(new Error('socket hang up ya29.fake-token'), { code: 'ECONNRESET' }));
  await assert.rejects(service.updateContact('101', { firstName: 'x' }), (err) => {
    assert.equal(err.code, 'API_UNAVAILABLE');
    assert.equal(err.retryable, true);
    assertSafe(err);
    return true;
  });
  fake.failNext('values.append', googleError(429));
  await assertRejects(service.appendContact({ contactId: '800' }), 'RATE_LIMITED');
  fake.failNext('spreadsheets.batchUpdate', googleError(500));
  await assertRejects(service.deleteContact('102'), 'API_UNAVAILABLE');
  assert.deepEqual(fake.snapshot(), [HEADER, ADA, GRACE, ALAN]);
});

test('a failed operation does not block the next one', async () => {
  const { fake, service } = setup();
  fake.failNext('values.append', googleError(503));
  await assertRejects(service.appendContact({ contactId: '900' }), 'API_UNAVAILABLE');
  await service.appendContact({ contactId: '900' });
  assert.equal(fake.snapshot()[4][0], '900');
});

test('unexpected Google replies become UNEXPECTED_RESPONSE', async () => {
  for (const reply of [{ data: { values: 'text' } }, { data: { values: ['x'] } }, undefined]) {
    const fake = createFakeSheetsApi();
    fake.api.spreadsheets.values.get = async () => reply;
    const client = createSheetsClient({ api: fake.api, spreadsheetId: fake.spreadsheetId, tab: 'Contacts' });
    const service = createContactsSheet({ client });
    await assertRejects(service.getAllContacts(), 'UNEXPECTED_RESPONSE');
  }
});

// --- safety of changes: ordering and moved rows --------------------------------------

test('two appends of the same new Contact ID at the same time: exactly one succeeds', async () => {
  const { fake, service } = setup();
  const results = await Promise.allSettled([
    service.appendContact({ contactId: '555', firstName: 'First' }),
    service.appendContact({ contactId: '555', firstName: 'Second' }),
  ]);
  const ok = results.filter((r) => r.status === 'fulfilled');
  const failed = results.filter((r) => r.status === 'rejected');
  assert.equal(ok.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.code, 'DUPLICATE_CONTACT');
  assert.equal(fake.snapshot().filter((row) => row[0] === '555').length, 1);
});

test('several different appends at once all succeed, each on its own row', async () => {
  const { fake, service } = setup();
  await Promise.all(['601', '602', '603', '604'].map((id) => service.appendContact({ contactId: id })));
  const ids = fake.snapshot().slice(4).map((row) => row[0]);
  assert.deepEqual(ids.sort(), ['601', '602', '603', '604']);
});

test('concurrent update and delete of different contacts both apply correctly', async () => {
  const { fake, service } = setup();
  await Promise.all([service.updateContact('103', { company: 'Changed' }), service.deleteContact('101')]);
  assert.deepEqual(fake.snapshot(), [HEADER, GRACE, ['103', 'Alan', 'Turing', 'alan@example.com', 'Changed', '2026-03-03T00:00:00.000Z']]);
});

test('if the row moved while we worked, the change is NOT applied to the wrong row', async () => {
  // update: someone deletes row 2 after we read the table but before we write.
  const u = setup();
  u.fake.hooks.beforeValuesGet = (count, state) => {
    if (count === 2) state.grid.splice(1, 1); // the "re-check" read: the sheet changed under us
  };
  await assertRejects(u.service.updateContact('103', { firstName: 'Wrong' }), 'CONTACT_NOT_FOUND');
  assert.equal(u.fake.writeCalls().length, 0);

  // delete: same situation. Without the re-check, the row that moved up (Alan) would be removed.
  const d = setup();
  d.fake.hooks.beforeValuesGet = (count, state) => {
    if (count === 2) state.grid.splice(1, 1);
  };
  await assertRejects(d.service.deleteContact('102'), 'CONTACT_NOT_FOUND');
  assert.equal(d.fake.writeCalls().length, 0);
  assert.deepEqual(d.fake.snapshot(), [HEADER, GRACE, ALAN]);
});

// --- the shared instance ------------------------------------------------------------

test('getContactsSheet builds the service once and reuses it; reset makes a new one', () => {
  resetContactsSheet();
  const { client } = setup();
  let built = 0;
  const getClient = () => {
    built += 1;
    return client;
  };
  const first = getContactsSheet({ getClient });
  const second = getContactsSheet({ getClient });
  assert.equal(first, second);
  assert.equal(built, 1);
  resetContactsSheet();
  assert.notEqual(getContactsSheet({ getClient }), first);
  assert.equal(built, 2);
  resetContactsSheet();
});

test('a failed start of the shared service is not remembered', () => {
  resetContactsSheet();
  const { client } = setup();
  assert.throws(() => getContactsSheet({ getClient: () => { throw new GoogleSheetsError('CONFIG_MISSING'); } }), (e) => e.code === 'CONFIG_MISSING');
  assert.ok(getContactsSheet({ getClient: () => client }));
  resetContactsSheet();
});

test('without injected fakes the shared service fails closed (blanked settings never reach Google)', () => {
  resetContactsSheet();
  assert.throws(() => getContactsSheet(), (e) => e instanceof GoogleSheetsError && e.code === 'SPREADSHEET_ID_MISSING');
});

// --- logging, secrets, boundaries ---------------------------------------------------

test('nothing is logged by any operation, successful or failed', async () => {
  const spy = captureConsole();
  try {
    const { fake, service } = setup();
    await service.getHeaders();
    await service.getAllContacts();
    await service.findContactById('101');
    await service.appendContact({ contactId: '1001' });
    await service.updateContact('1001', { firstName: 'x' });
    await service.deleteContact('1001');
    await service.deleteContact('nope-404').catch(() => {});
    await service.appendContact({}).catch(() => {});
    fake.failNext('values.get', googleError(403));
    await service.getAllContacts().catch(() => {});
  } finally {
    spy.restore();
  }
  assert.deepEqual(spy.lines, []);
});

test('the source has no HubSpot code, no hardcoded IDs or paths, no logging, and only RAW writes', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'google', 'contactsSheet.js'), 'utf8');
  assert.doesNotMatch(source, /require\(['"]\.\.\/(oauth|security|webhooks|idempotency)/, 'no HubSpot code');
  assert.doesNotMatch(source, /require\(['"]\.\/oauth/, 'no HubSpot OAuth');
  assert.doesNotMatch(source, /hubapi|api\.hubspot|hubspot\.com/i, 'no HubSpot API');
  assert.doesNotMatch(source, /console\.(log|info|warn|error|debug)\s*\(/, 'never logs');
  assert.doesNotMatch(source, /USER_ENTERED/);
  assert.doesNotMatch(source, /Google-Credentials|nifty-stage|BEGIN (RSA )?PRIVATE KEY|[A-Za-z]:\\\\/, 'no hardcoded path or key');
  assert.doesNotMatch(source, /1[A-Za-z0-9_-]{43}/, 'no spreadsheet ID literal');
});

test('nothing outside src/google, the tests and the docs imports the new Google modules (not connected to webhooks)', () => {
  const root = path.join(__dirname, '..');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'data' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) {
        const rel = path.relative(root, full).replace(/\\/g, '/');
        // The manual scripts may use the Google modules; nothing else (webhooks, OAuth, server) may.
        if (rel.startsWith('src/google/') || rel.startsWith('tests/') || rel === 'scripts/sheets-status.js' || rel === 'scripts/sheets-crud-demo.js') continue;
        if (/require\([^)]*google\/(contactsSheet|sheetsClient)/.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
      }
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
