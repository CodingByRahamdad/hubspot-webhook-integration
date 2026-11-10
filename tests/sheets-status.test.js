// tests/sheets-status.test.js
//
// Tests scripts/sheets-status.js and src/google/sheetsConfig.js (Phase 2, step 5).
// The real service-account key and the real spreadsheet are never used: sign-in and the
// Sheets API are replaced by fakes, and the environment is passed in as a plain object.
// No request is made to Google. The two child-process tests set BOTH Google variables
// explicitly (to "") so a real .env can never influence them, and they stop before any
// network access.
//
// Run with:  node --test tests/sheets-status.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { runSheetsStatus, METADATA_FIELDS } = require('../scripts/sheets-status');
const { GoogleSheetsError } = require('../src/google/sheetsErrors');
const { getSpreadsheetId, getContactsTab, DEFAULT_CONTACTS_TAB } = require('../src/google/sheetsConfig');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'sheets-status.js');

const FAKE_ID = 'FAKEspreadsheetID_0123456789abcdefghij';
const FAKE_KEY_PATH = '/fake/secret/place/fake-key-file.json';
const FAKE_EMAIL = 'fake-sa@fake-project.iam.gserviceaccount.com';
const FAKE_KEY_TEXT = '-----BEGIN PRIVATE KEY-----FAKEFAKEFAKE-----END PRIVATE KEY-----';
const FAKE_TOKEN = 'ya29.fake-access-token';

const goodEnv = (extra = {}) => ({
  GOOGLE_SERVICE_ACCOUNT_KEY_FILE: FAKE_KEY_PATH,
  GOOGLE_SHEETS_SPREADSHEET_ID: FAKE_ID,
  GOOGLE_SHEETS_CONTACTS_TAB: 'Contacts',
  ...extra,
});

// A Sheets API fake. Only spreadsheets.get exists; anything else a script might try
// (values, batchUpdate, create ...) throws, so a write attempt would fail the test.
function makeFakeApi({ response, error } = {}) {
  const requests = [];
  const forbidden = (name) => () => {
    throw new Error(`forbidden call in a read-only check: ${name}`);
  };
  const api = {
    spreadsheets: {
      async get(params, options) {
        requests.push({ params, options });
        if (error) throw error;
        return (
          response || {
            data: { properties: { title: 'HubSpot CRM Database' }, sheets: [{ properties: { title: 'Contacts' } }, { properties: { title: 'Archive' } }] },
          }
        );
      },
      batchUpdate: forbidden('batchUpdate'),
      create: forbidden('create'),
      values: new Proxy({}, { get: (_, name) => forbidden(`values.${String(name)}`) }),
    },
  };
  return { api, requests };
}

// Runs the check with fakes and returns what it printed.
async function run({ env = goodEnv(), api = makeFakeApi(), createAuth, authenticateFn } = {}) {
  const printed = [];
  const authCalls = [];
  const result = await runSheetsStatus({
    env,
    out: (line) => printed.push(line),
    createAuth:
      createAuth ||
      ((options) => {
        authCalls.push(options);
        return { fakeAuthClient: true };
      }),
    authenticateFn: authenticateFn || (async () => true),
    createApi: (client) => {
      api.receivedAuthClient = client;
      return api.api;
    },
  });
  return { result, text: printed.join('\n'), printed, authCalls, api };
}

// The report may contain titles, codes and fixed text, but never any of these.
function assertNoSecrets(text) {
  for (const secret of [FAKE_ID, FAKE_KEY_PATH, FAKE_EMAIL, FAKE_KEY_TEXT, FAKE_TOKEN, 'PRIVATE KEY', 'Bearer', 'access_token']) {
    assert.ok(!text.includes(secret), `output must not contain: ${secret}`);
  }
}

const throwing = (error) => async () => {
  throw error;
};
const apiError = (status, extra = {}) =>
  Object.assign(new Error(`Request failed for ${FAKE_ID} ${FAKE_EMAIL} ${FAKE_KEY_TEXT} ${FAKE_TOKEN}`), { response: { status }, ...extra });

// --- success ------------------------------------------------------------------------

test('successful connection prints the full report and exits 0', async () => {
  const { result, text, printed } = await run();

  assert.deepEqual(result, { ok: true, exitCode: 0, code: null });
  assert.equal(printed[0], 'Google Sheets Connection Status');
  assert.match(text, /^Settings: SUCCESS$/m);
  assert.match(text, /^Service account authentication: SUCCESS$/m);
  assert.match(text, /^Spreadsheet access: SUCCESS$/m);
  assert.match(text, /^Spreadsheet: HubSpot CRM Database$/m);
  assert.match(text, /^Worksheets found: Contacts, Archive$/m);
  assert.match(text, /^Worksheet: Contacts$/m);
  assert.match(text, /^Worksheet exists: YES$/m);
  assert.match(text, /^Overall status: SUCCESS$/m);
  assert.doesNotMatch(text, /FAILED|Problem:|How to fix/);
  assertNoSecrets(text);
});

test('the configured spreadsheet ID and the restricted field list are sent, as a metadata-only request', async () => {
  const { api } = await run();
  assert.equal(api.requests.length, 1, 'exactly one API request');
  const { params, options } = api.requests[0];
  assert.equal(params.spreadsheetId, FAKE_ID);
  assert.equal(params.fields, 'properties.title,sheets.properties.title');
  assert.equal(params.fields, METADATA_FIELDS);
  assert.equal(params.includeGridData, false);
  assert.deepEqual(Object.keys(params).sort(), ['fields', 'includeGridData', 'spreadsheetId']);
  assert.ok(options.timeout > 0, 'a timeout is set');
});

test('the existing sign-in module is reused: the same auth client goes to the API', async () => {
  const marker = { fakeAuthClient: 'marker' };
  const authenticated = [];
  const { api, authCalls } = await run({
    createAuth: (options) => {
      assert.equal(options.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE, FAKE_KEY_PATH, 'the environment is handed to the auth module');
      return marker;
    },
    authenticateFn: async (client) => {
      authenticated.push(client);
      return true;
    },
  });
  assert.deepEqual(authCalls, []);
  assert.deepEqual(authenticated, [marker], 'the client from createSheetsAuth is the one authenticated');
  assert.equal(api.receivedAuthClient, marker, 'and the one used for the Sheets API');
});

// --- worksheet detection ------------------------------------------------------------

test('the worksheet name comes from GOOGLE_SHEETS_CONTACTS_TAB', async () => {
  const { result, text } = await run({ env: goodEnv({ GOOGLE_SHEETS_CONTACTS_TAB: 'Archive' }) });
  assert.equal(result.ok, true);
  assert.match(text, /^Worksheet: Archive$/m);
  assert.match(text, /^Worksheet exists: YES$/m);
});

test('without GOOGLE_SHEETS_CONTACTS_TAB the documented default (Contacts) is used', async () => {
  const env = goodEnv();
  delete env.GOOGLE_SHEETS_CONTACTS_TAB;
  const { result, text } = await run({ env });
  assert.equal(result.ok, true);
  assert.match(text, /^Worksheet: Contacts$/m);
});

test('missing worksheet -> WORKSHEET_NOT_FOUND, exit 1, the spreadsheet itself was reachable', async () => {
  const { result, text } = await run({ env: goodEnv({ GOOGLE_SHEETS_CONTACTS_TAB: 'Missing' }) });
  assert.deepEqual(result, { ok: false, exitCode: 1, code: 'WORKSHEET_NOT_FOUND' });
  assert.match(text, /^Spreadsheet access: SUCCESS$/m);
  assert.match(text, /^Spreadsheet: HubSpot CRM Database$/m);
  assert.match(text, /^Worksheet exists: NO$/m);
  assert.match(text, /^Overall status: FAILED$/m);
  assert.match(text, /^Problem: WORKSHEET_NOT_FOUND - /m);
  assert.match(text, /^How to fix: /m);
  assertNoSecrets(text);
});

test('a worksheet name that differs only in letter case is NOT treated as a match', async () => {
  const { result } = await run({ env: goodEnv({ GOOGLE_SHEETS_CONTACTS_TAB: 'contacts' }) });
  assert.equal(result.code, 'WORKSHEET_NOT_FOUND');
});

test('a spreadsheet without worksheets is reported without crashing', async () => {
  const api = makeFakeApi({ response: { data: { properties: { title: 'Empty' }, sheets: [] } } });
  const { result, text } = await run({ api });
  assert.equal(result.code, 'WORKSHEET_NOT_FOUND');
  assert.match(text, /^Worksheets found: \(none\)$/m);
});

// --- configuration errors -----------------------------------------------------------

test('missing spreadsheet ID -> SPREADSHEET_ID_MISSING; nothing else is attempted', async () => {
  for (const value of [undefined, '', '   ']) {
    const env = goodEnv({ GOOGLE_SHEETS_SPREADSHEET_ID: value });
    if (value === undefined) delete env.GOOGLE_SHEETS_SPREADSHEET_ID;
    const api = makeFakeApi();
    let authTried = false;
    const { result, text } = await run({
      env,
      api,
      createAuth: () => {
        authTried = true;
        return {};
      },
    });
    assert.deepEqual(result, { ok: false, exitCode: 1, code: 'SPREADSHEET_ID_MISSING' });
    assert.equal(authTried, false, 'no sign-in without a spreadsheet');
    assert.equal(api.requests.length, 0, 'no API request');
    assert.match(text, /^Settings: FAILED \(SPREADSHEET_ID_MISSING\)$/m);
    assert.match(text, /^Service account authentication: SKIPPED$/m);
    assert.match(text, /^Spreadsheet access: SKIPPED$/m);
    assert.match(text, /GOOGLE_SHEETS_SPREADSHEET_ID/);
    assertNoSecrets(text);
  }
});

test('a malformed spreadsheet ID -> SPREADSHEET_ID_INVALID, and the bad value is not echoed', async () => {
  const bad = 'not a valid id!!';
  const { result, text } = await run({ env: goodEnv({ GOOGLE_SHEETS_SPREADSHEET_ID: bad }) });
  assert.equal(result.code, 'SPREADSHEET_ID_INVALID');
  assert.ok(!text.includes(bad));
});

test('missing or broken service-account credentials are reported from the auth module without leaking', async () => {
  const cases = ['CONFIG_MISSING', 'CREDENTIALS_FILE_NOT_FOUND', 'CREDENTIALS_FILE_UNREADABLE', 'CREDENTIALS_INVALID_JSON', 'CREDENTIALS_INVALID'];
  for (const code of cases) {
    const api = makeFakeApi();
    const { result, text } = await run({
      api,
      createAuth: () => {
        throw new GoogleSheetsError(code);
      },
    });
    assert.deepEqual(result, { ok: false, exitCode: 1, code });
    assert.match(text, new RegExp(`^Service account authentication: FAILED \\(${code}\\)$`, 'm'));
    assert.match(text, /^Spreadsheet access: SKIPPED$/m);
    assert.match(text, /^How to fix: /m);
    assert.equal(api.requests.length, 0);
    assertNoSecrets(text);
  }
});

// --- Google errors ------------------------------------------------------------------

test('Google rejecting the sign-in -> AUTH_FAILED, no API request, no leaks', async () => {
  const api = makeFakeApi();
  const { result, text } = await run({
    api,
    authenticateFn: throwing(new GoogleSheetsError('AUTH_FAILED')),
  });
  assert.deepEqual(result, { ok: false, exitCode: 1, code: 'AUTH_FAILED' });
  assert.match(text, /^Service account authentication: FAILED \(AUTH_FAILED\)$/m);
  assert.equal(api.requests.length, 0);
  assertNoSecrets(text);
});

test('a raw error from the sign-in library is converted and its text is dropped', async () => {
  const { result, text } = await run({ authenticateFn: throwing(apiError(400)) });
  assert.equal(result.ok, false);
  assertNoSecrets(text);
});

test('spreadsheet not found (404) -> SPREADSHEET_NOT_FOUND', async () => {
  const { result, text } = await run({ api: makeFakeApi({ error: apiError(404) }) });
  assert.deepEqual(result, { ok: false, exitCode: 1, code: 'SPREADSHEET_NOT_FOUND' });
  assert.match(text, /^Service account authentication: SUCCESS$/m);
  assert.match(text, /^Spreadsheet access: FAILED \(SPREADSHEET_NOT_FOUND\)$/m);
  assert.match(text, /^How to fix: .*GOOGLE_SHEETS_SPREADSHEET_ID/m);
  assertNoSecrets(text);
});

test('permission denied (403) -> PERMISSION_DENIED with the sharing hint', async () => {
  const { result, text } = await run({ api: makeFakeApi({ error: apiError(403) }) });
  assert.equal(result.code, 'PERMISSION_DENIED');
  assert.match(text, /^Spreadsheet access: FAILED \(PERMISSION_DENIED\)$/m);
  assert.match(text, /^How to fix: .*Share the spreadsheet/m);
  assertNoSecrets(text);
});

test('network failures -> API_UNAVAILABLE, flagged as temporary', async () => {
  for (const code of ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT']) {
    const error = Object.assign(new Error(`getaddrinfo ${code} sheets.googleapis.com ${FAKE_ID}`), { code });
    const { result, text } = await run({ api: makeFakeApi({ error }) });
    assert.equal(result.code, 'API_UNAVAILABLE', code);
    assert.match(text, /temporary/i);
    assertNoSecrets(text);
  }
});

test('rate limits (429) and server errors (5xx) -> RATE_LIMITED / API_UNAVAILABLE, flagged as temporary', async () => {
  for (const [status, code] of [
    [429, 'RATE_LIMITED'],
    [500, 'API_UNAVAILABLE'],
    [503, 'API_UNAVAILABLE'],
  ]) {
    const { result, text } = await run({ api: makeFakeApi({ error: apiError(status) }) });
    assert.equal(result.code, code, String(status));
    assert.equal(result.exitCode, 1);
    assert.match(text, /This looks temporary/);
    assertNoSecrets(text);
  }
});

test('an unexpected Google reply shape -> INTERNAL_ERROR, not a crash', async () => {
  for (const response of [{}, { data: null }, { data: { properties: {} } }, { data: { properties: { title: 'T' }, sheets: 'x' } }]) {
    const { result } = await run({ api: makeFakeApi({ response }) });
    assert.equal(result.code, 'INTERNAL_ERROR');
  }
});

test('any other kind of thrown value is handled safely', async () => {
  for (const thrown of ['a string', 42, null, undefined, { weird: true }, new TypeError(FAKE_KEY_TEXT)]) {
    const { result, text } = await run({ api: makeFakeApi({ error: thrown ?? undefined, response: undefined }) });
    if (thrown === null || thrown === undefined) continue; // the fake only throws truthy values
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 1);
    assertNoSecrets(text);
  }
});

// --- output safety ------------------------------------------------------------------

test('names from the spreadsheet are cleaned before printing (no control characters, bounded length)', async () => {
  const api = makeFakeApi({
    response: {
      data: {
        properties: { title: 'Evil\u001b[31m title\u0007' + 'x'.repeat(300) },
        sheets: [{ properties: { title: 'Contacts' } }, { properties: { title: 'Tab\u0000\nwith\tbreaks' } }],
      },
    },
  });
  const { text } = await run({ api });
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f]/);
  assert.ok(text.split('\n').every((line) => line.length < 400));
  assert.match(text, /Tab with breaks/);
});

test('the script source requests metadata only and cannot write', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.match(source, /spreadsheets\.get\(/);
  assert.doesNotMatch(source, /\.values\b|batchUpdate|spreadsheets\.create|\.append\(|\.update\(|\.clear\(|\.delete\(/);
  assert.doesNotMatch(source, /require\(['"]\.\.\/src\/(oauth|security|webhooks|idempotency)/, 'no HubSpot code');
  assert.doesNotMatch(source, /Google-Credentials|nifty-stage|BEGIN (RSA )?PRIVATE KEY|[A-Za-z]:\\\\/, 'no hardcoded path or key');
  assert.doesNotMatch(source, /1[A-Za-z0-9_-]{43}/, 'no spreadsheet ID literal');
});

// --- sheetsConfig -------------------------------------------------------------------

test('getSpreadsheetId accepts a valid ID (trimmed) and rejects missing or malformed ones', () => {
  assert.equal(getSpreadsheetId({ GOOGLE_SHEETS_SPREADSHEET_ID: `  ${FAKE_ID}  ` }), FAKE_ID);
  for (const env of [{}, undefined, { GOOGLE_SHEETS_SPREADSHEET_ID: '' }, { GOOGLE_SHEETS_SPREADSHEET_ID: '  ' }]) {
    assert.throws(() => getSpreadsheetId(env), (e) => e instanceof GoogleSheetsError && e.code === 'SPREADSHEET_ID_MISSING');
  }
  for (const value of ['short', 'has space in it 0123456789', 'a'.repeat(101), 'https://docs.google.com/spreadsheets/d/x', `${FAKE_ID}/edit`]) {
    assert.throws(
      () => getSpreadsheetId({ GOOGLE_SHEETS_SPREADSHEET_ID: value }),
      (e) => e instanceof GoogleSheetsError && e.code === 'SPREADSHEET_ID_INVALID' && !e.message.includes(value)
    );
  }
});

test('getContactsTab defaults to Contacts, trims, and rejects absurd names', () => {
  assert.equal(DEFAULT_CONTACTS_TAB, 'Contacts');
  assert.equal(getContactsTab({}), 'Contacts');
  assert.equal(getContactsTab(undefined), 'Contacts');
  assert.equal(getContactsTab({ GOOGLE_SHEETS_CONTACTS_TAB: '' }), 'Contacts');
  assert.equal(getContactsTab({ GOOGLE_SHEETS_CONTACTS_TAB: '  Leads  ' }), 'Leads');
  assert.throws(() => getContactsTab({ GOOGLE_SHEETS_CONTACTS_TAB: 'x'.repeat(101) }), (e) => e.code === 'INVALID_INPUT');
});

// --- running the real script as a program (no network is reached) ------------------

function runScript(env) {
  const out = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 20000,
  });
  return { status: out.status, text: `${out.stdout}\n${out.stderr}` };
}

test('as a program: no spreadsheet ID -> exit code 1 and a clear report (Google is never contacted)', () => {
  const { status, text } = runScript({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '', GOOGLE_SHEETS_SPREADSHEET_ID: '', GOOGLE_SHEETS_CONTACTS_TAB: 'Contacts' });
  assert.equal(status, 1);
  assert.match(text, /Overall status: FAILED/);
  assert.match(text, /SPREADSHEET_ID_MISSING/);
});

test('as a program: a spreadsheet ID but no key file path -> exit code 1, stops before any network access', () => {
  const { status, text } = runScript({ GOOGLE_SERVICE_ACCOUNT_KEY_FILE: '', GOOGLE_SHEETS_SPREADSHEET_ID: FAKE_ID, GOOGLE_SHEETS_CONTACTS_TAB: 'Contacts' });
  assert.equal(status, 1);
  assert.match(text, /Service account authentication: FAILED \(CONFIG_MISSING\)/);
  assert.ok(!text.includes(FAKE_ID));
});

test('package.json wires npm run sheets:status to the script and keeps the other scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['sheets:status'], 'node scripts/sheets-status.js');
  for (const name of ['start', 'dev', 'test', 'events:failed', 'oauth:status']) assert.ok(pkg.scripts[name], name);
});
