// scripts/sheets-status.js
// READ-ONLY check of the Google Sheets connection (see docs/24).
//
// Run from the project folder:
//   npm run sheets:status
//
// What it does, in order:
//   1. reads the settings (spreadsheet ID, worksheet name) from the environment
//   2. signs in with the service account (src/google/sheetsAuth.js, reused as is)
//   3. asks Google for the spreadsheet's METADATA only: its title and worksheet names
//   4. checks that the configured worksheet exists
//
// It never reads or writes cell values, never creates, changes or deletes anything, and
// uses no HubSpot code. It prints the spreadsheet title and worksheet names, and nothing
// else from Google: no spreadsheet ID, key, e-mail address, token, file path or raw
// Google error text.
//
// Exit codes: 0 = everything works, 1 = something failed (the report says what).

const { GoogleSheetsError, classifyApiError } = require('../src/google/sheetsErrors');
const { createSheetsAuth, authenticate } = require('../src/google/sheetsAuth');
const { getSpreadsheetId, getContactsTab } = require('../src/google/sheetsConfig');

// The ONLY fields requested from Google: the spreadsheet title and each worksheet title.
const METADATA_FIELDS = 'properties.title,sheets.properties.title';
const REQUEST_TIMEOUT_MS = 15 * 1000;

// What to do about each problem. Fixed text only.
const HINTS = {
  CONFIG_MISSING: 'Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE in .env to the path of the service-account JSON key file.',
  CREDENTIALS_FILE_NOT_FOUND: 'Check that GOOGLE_SERVICE_ACCOUNT_KEY_FILE points to an existing file.',
  CREDENTIALS_FILE_UNREADABLE: 'The key path must be a normal, readable file (not a folder). Check the file permissions.',
  CREDENTIALS_INVALID_JSON: 'The key file is damaged or is not the downloaded key. Download a new JSON key in Google Cloud Console.',
  CREDENTIALS_INVALID: 'The file is not a service-account key. Download the JSON key of the service account (Keys > Add key).',
  AUTH_FAILED: 'Google rejected the key. It may have been deleted or the service account disabled. Create a new key and check your computer clock.',
  AUTH_UNAVAILABLE: 'Temporary network or Google problem. Check your internet connection and run the check again.',
  SPREADSHEET_ID_MISSING: 'Set GOOGLE_SHEETS_SPREADSHEET_ID in .env (the text between /d/ and /edit in the spreadsheet URL).',
  SPREADSHEET_ID_INVALID: 'Copy only the ID from the spreadsheet URL (between /d/ and /edit), without spaces or quotes.',
  SPREADSHEET_NOT_FOUND: 'Check GOOGLE_SHEETS_SPREADSHEET_ID against the spreadsheet URL.',
  PERMISSION_DENIED:
    'Share the spreadsheet with the service account e-mail (Editor) and make sure the Google Sheets API is enabled in the Google Cloud project.',
  WORKSHEET_NOT_FOUND: 'Create the worksheet, or fix GOOGLE_SHEETS_CONTACTS_TAB so it matches a worksheet name exactly.',
  RATE_LIMITED: 'Google is limiting requests. Wait a minute and run the check again.',
  API_UNAVAILABLE: 'Temporary Google or network problem. Wait a little and run the check again.',
  INVALID_INPUT: 'A setting has an unusable value. Check the Google settings in .env.',
  INTERNAL_ERROR: 'Unexpected problem. Run the automated tests (npm test) to check the installation.',
};

// Worksheet and spreadsheet names are free text typed by people. Strip control
// characters (so they cannot mess with the terminal) and cap the length.
function clean(text) {
  const printable = String(text).replace(/[\p{C}\s]+/gu, ' ').trim();
  return printable.length > 100 ? `${printable.slice(0, 97)}...` : printable;
}

// Default way to create the Sheets API object (replaced by a fake in the tests).
function defaultCreateApi(authClient) {
  const { sheets } = require('@googleapis/sheets');
  return sheets({ version: 'v4', auth: authClient });
}

// Turns anything into a GoogleSheetsError (never leaks the original).
function toSafeError(err) {
  return err instanceof GoogleSheetsError ? err : classifyApiError(err);
}

// Reads the metadata reply defensively. Returns { title, worksheets } or throws.
function readMetadata(response) {
  const data = response && response.data;
  const title = data && data.properties && data.properties.title;
  if (typeof title !== 'string' || !Array.isArray(data.sheets)) throw new GoogleSheetsError('INTERNAL_ERROR');
  const worksheets = data.sheets
    .map((s) => s && s.properties && s.properties.title)
    .filter((name) => typeof name === 'string');
  return { title, worksheets };
}

// Runs the whole check. Everything outside this function is injected so tests use a fake
// sign-in and a fake Sheets API. Resolves { ok, exitCode, code }.
async function runSheetsStatus({
  env = process.env,
  out = console.log,
  createAuth = createSheetsAuth,
  authenticateFn = authenticate,
  createApi = defaultCreateApi,
} = {}) {
  const lines = [];
  const report = (text) => lines.push(text);
  const state = { config: 'SKIPPED', auth: 'SKIPPED', access: 'SKIPPED' };
  let failure = null;
  let spreadsheetId;
  let tab;
  let metadata = null;
  let worksheetExists = null;

  try {
    // 1. Settings
    spreadsheetId = getSpreadsheetId(env);
    tab = getContactsTab(env);
    state.config = 'SUCCESS';

    // 2. Sign in (the existing module: key file checks + Google token request)
    let authClient;
    try {
      authClient = createAuth({ env });
      await authenticateFn(authClient);
      state.auth = 'SUCCESS';
    } catch (err) {
      state.auth = 'FAILED';
      throw toSafeError(err);
    }

    // 3. Metadata only: title + worksheet titles. No cell values are requested.
    try {
      const api = createApi(authClient);
      const response = await api.spreadsheets.get(
        { spreadsheetId, fields: METADATA_FIELDS, includeGridData: false },
        { timeout: REQUEST_TIMEOUT_MS }
      );
      metadata = readMetadata(response);
      state.access = 'SUCCESS';
    } catch (err) {
      state.access = 'FAILED';
      throw toSafeError(err);
    }

    // 4. Does the configured worksheet exist? (exact name)
    worksheetExists = metadata.worksheets.includes(tab);
    if (!worksheetExists) throw new GoogleSheetsError('WORKSHEET_NOT_FOUND');
  } catch (err) {
    failure = toSafeError(err);
    if (state.config === 'SKIPPED') state.config = 'FAILED';
  }

  const label = (value) => (value === 'FAILED' && failure ? `FAILED (${failure.code})` : value);
  report('Google Sheets Connection Status');
  report('--------------------------------');
  report(`Settings: ${label(state.config)}`);
  report(`Service account authentication: ${label(state.auth)}`);
  report(`Spreadsheet access: ${label(state.access)}`);
  if (metadata) {
    report(`Spreadsheet: ${clean(metadata.title)}`);
    report(`Worksheets found: ${metadata.worksheets.length > 0 ? metadata.worksheets.map(clean).join(', ') : '(none)'}`);
  }
  if (tab !== undefined) {
    report(`Worksheet: ${clean(tab)}`);
    if (worksheetExists !== null) report(`Worksheet exists: ${worksheetExists ? 'YES' : 'NO'}`);
  }
  report('');

  if (failure) {
    report('Overall status: FAILED');
    report(`Problem: ${failure.code} - ${failure.message}`);
    report(`How to fix: ${HINTS[failure.code] || HINTS.INTERNAL_ERROR}`);
    if (failure.retryable) report('This looks temporary, so trying again later may work.');
  } else {
    report('Overall status: SUCCESS');
  }

  lines.forEach((line) => out(line));
  return { ok: !failure, exitCode: failure ? 1 : 0, code: failure ? failure.code : null };
}

module.exports = { runSheetsStatus, METADATA_FIELDS };

if (require.main === module) {
  // Load .env only when run as a script, so importing this file (tests) never reads it.
  require('dotenv').config({ quiet: true });
  runSheetsStatus().then(
    (result) => {
      process.exitCode = result.exitCode;
    },
    () => {
      // runSheetsStatus handles its own errors; this is only a last resort and prints nothing from the error.
      console.error('Google Sheets status check stopped unexpectedly.');
      process.exitCode = 1;
    }
  );
}
