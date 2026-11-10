// src/google/sheetsClient.js
// A small, reusable wrapper around the Google Sheets API (see docs/25).
//
//   createSheetsClient({ api, spreadsheetId, tab })   build a client around a Sheets API object
//   getSheetsClient()                                  the shared client for the app (made on first use)
//   resetSheetsClient()                                forget the shared client (tests)
//
// A client is tied to ONE spreadsheet and ONE worksheet (tab). Its methods:
//   getValues(a1)            read cells            -> array of rows (each an array of strings)
//   appendValues(a1, rows)   add rows after the data
//   updateValues(a1, rows)   overwrite a range
//   getWorksheetId()         the numeric id of the tab (metadata only)
//   deleteRow(rowNumber)     remove one row (never the header row)
//
// Everything is built on what already exists: sign-in comes from sheetsAuth.js, the
// settings from sheetsConfig.js, and failures are translated by sheetsErrors.js. This file
// adds no sign-in or error logic of its own.
//
// Safe by design:
//   - values are written with RAW, so Google never turns text into formulas or dates;
//   - the spreadsheet ID stays inside the client and is never put in an error;
//   - nothing is logged, and no raw Google error is passed on (only a safe GoogleSheetsError);
//   - nothing happens when this file is required, and a failed start is not remembered.

const { GoogleSheetsError, classifyApiError } = require('./sheetsErrors');
const { getSheetsAuth } = require('./sheetsAuth');
const { getSpreadsheetId, getContactsTab } = require('./sheetsConfig');

const DEFAULT_TIMEOUT_MS = 15 * 1000;
const MAX_ROWS_PER_CALL = 100;
const MAX_COLUMNS_PER_ROW = 50;
const MAX_CELL_CHARS = 50000; // Google's own limit per cell

// A1 notation without the sheet name, for example "A:F", "A1:F1", "A7".
const A1_PATTERN = /^[A-Z]{1,3}(?:[1-9][0-9]{0,6})?(?::[A-Z]{1,3}(?:[1-9][0-9]{0,6})?)?$/;

// 'My Tab'!A:F  - the tab name is quoted, and a quote inside it is doubled.
function rangeFor(tab, a1) {
  if (typeof a1 !== 'string' || !A1_PATTERN.test(a1)) throw new GoogleSheetsError('INVALID_INPUT');
  return `'${tab.replace(/'/g, "''")}'!${a1}`;
}

function validateRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_ROWS_PER_CALL) throw new GoogleSheetsError('INVALID_INPUT');
  for (const row of rows) {
    if (!Array.isArray(row) || row.length === 0 || row.length > MAX_COLUMNS_PER_ROW) throw new GoogleSheetsError('INVALID_INPUT');
    for (const cell of row) {
      const ok =
        cell === null ||
        typeof cell === 'boolean' ||
        (typeof cell === 'number' && Number.isFinite(cell)) ||
        (typeof cell === 'string' && cell.length <= MAX_CELL_CHARS);
      if (!ok) throw new GoogleSheetsError('INVALID_INPUT');
    }
  }
}

// Turns a values reply into an array of rows of strings, or throws UNEXPECTED_RESPONSE.
function readRows(response) {
  const data = response && response.data;
  if (!data || typeof data !== 'object') throw new GoogleSheetsError('UNEXPECTED_RESPONSE');
  if (data.values === undefined) return []; // an empty range has no "values" at all
  if (!Array.isArray(data.values)) throw new GoogleSheetsError('UNEXPECTED_RESPONSE');
  return data.values.map((row) => {
    if (!Array.isArray(row)) throw new GoogleSheetsError('UNEXPECTED_RESPONSE');
    return row.map((cell) => (cell === null || cell === undefined ? '' : String(cell)));
  });
}

function createSheetsClient({ api, spreadsheetId, tab, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const apiOk =
    api &&
    api.spreadsheets &&
    typeof api.spreadsheets.get === 'function' &&
    typeof api.spreadsheets.batchUpdate === 'function' &&
    api.spreadsheets.values &&
    ['get', 'append', 'update'].every((m) => typeof api.spreadsheets.values[m] === 'function');
  const tabOk = typeof tab === 'string' && tab.trim() !== '' && tab.length <= 100;
  const timeoutOk = Number.isSafeInteger(timeoutMs) && timeoutMs > 0;
  if (!apiOk || !tabOk || !timeoutOk) throw new GoogleSheetsError('INVALID_INPUT');
  const id = getSpreadsheetId({ GOOGLE_SHEETS_SPREADSHEET_ID: spreadsheetId }); // same shape check as the settings
  const requestOptions = { timeout: timeoutMs };

  // Runs one API call and turns any failure into a safe GoogleSheetsError.
  async function call(fn) {
    try {
      return await fn();
    } catch (err) {
      throw classifyApiError(err);
    }
  }

  async function getWorksheetId() {
    const response = await call(() =>
      api.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties(sheetId,title)', includeGridData: false }, requestOptions)
    );
    const sheets = response && response.data && response.data.sheets;
    if (!Array.isArray(sheets)) throw new GoogleSheetsError('UNEXPECTED_RESPONSE');
    const match = sheets.find((s) => s && s.properties && s.properties.title === tab);
    if (!match) throw new GoogleSheetsError('WORKSHEET_NOT_FOUND');
    if (!Number.isSafeInteger(match.properties.sheetId)) throw new GoogleSheetsError('UNEXPECTED_RESPONSE');
    return match.properties.sheetId;
  }

  // For calls that use a range. Google answers "400 bad range" when the tab does not exist,
  // which would be confusing; so after a 400 we look at the tab list and say what is wrong.
  async function rangeCall(fn) {
    try {
      return await fn();
    } catch (err) {
      const classified = classifyApiError(err);
      if (classified.code === 'INVALID_INPUT') {
        try {
          await getWorksheetId();
        } catch (checkError) {
          if (checkError instanceof GoogleSheetsError && checkError.code === 'WORKSHEET_NOT_FOUND') throw checkError;
        }
      }
      throw classified;
    }
  }

  async function getValues(a1) {
    const range = rangeFor(tab, a1);
    const response = await rangeCall(() =>
      api.spreadsheets.values.get(
        { spreadsheetId: id, range, majorDimension: 'ROWS', valueRenderOption: 'FORMATTED_VALUE' },
        requestOptions
      )
    );
    return readRows(response);
  }

  // Adds the rows below the existing data. Returns { rowNumber } of the first new row, or null
  // when Google did not say where it went.
  async function appendValues(a1, rows) {
    const range = rangeFor(tab, a1);
    validateRows(rows);
    const response = await rangeCall(() =>
      api.spreadsheets.values.append(
        {
          spreadsheetId: id,
          range,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { majorDimension: 'ROWS', values: rows },
        },
        requestOptions
      )
    );
    const updatedRange = response && response.data && response.data.updates && response.data.updates.updatedRange;
    const match = typeof updatedRange === 'string' ? /!\$?[A-Z]{1,3}\$?([1-9][0-9]{0,6})(?::|$)/.exec(updatedRange) : null;
    return { rowNumber: match ? Number(match[1]) : null };
  }

  async function updateValues(a1, rows) {
    const range = rangeFor(tab, a1);
    validateRows(rows);
    const response = await rangeCall(() =>
      api.spreadsheets.values.update(
        { spreadsheetId: id, range, valueInputOption: 'RAW', requestBody: { majorDimension: 'ROWS', values: rows } },
        requestOptions
      )
    );
    const cells = response && response.data && response.data.updatedCells;
    return { updatedCells: Number.isInteger(cells) ? cells : null };
  }

  // Removes exactly one row. Row 1 (the header) can never be removed.
  async function deleteRow(rowNumber) {
    if (!Number.isSafeInteger(rowNumber) || rowNumber < 2) throw new GoogleSheetsError('INVALID_INPUT');
    const sheetId = await getWorksheetId();
    await call(() =>
      api.spreadsheets.batchUpdate(
        {
          spreadsheetId: id,
          requestBody: {
            requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber } } }],
          },
        },
        requestOptions
      )
    );
    return { deleted: true };
  }

  return Object.freeze({ tab, getValues, appendValues, updateValues, getWorksheetId, deleteRow });
}

// ---------------------------------------------------------------------------
// Shared client for the application (created on first use, not at require time)
// ---------------------------------------------------------------------------

function defaultCreateApi(authClient) {
  const { sheets } = require('@googleapis/sheets');
  return sheets({ version: 'v4', auth: authClient });
}

let sharedClient = null;

// "env", "getAuth" and "createApi" are parameters so tests use fakes and never the real
// environment, key file or Google. A failed start throws and is NOT remembered.
function getSheetsClient({ env = process.env, getAuth = () => getSheetsAuth(), createApi = defaultCreateApi } = {}) {
  if (sharedClient) return sharedClient;
  try {
    const spreadsheetId = getSpreadsheetId(env);
    const tab = getContactsTab(env);
    const auth = getAuth();
    const api = createApi(auth);
    sharedClient = createSheetsClient({ api, spreadsheetId, tab });
    return sharedClient;
  } catch (err) {
    throw err instanceof GoogleSheetsError ? err : new GoogleSheetsError('INTERNAL_ERROR');
  }
}

function resetSheetsClient() {
  sharedClient = null;
}

module.exports = { createSheetsClient, getSheetsClient, resetSheetsClient, rangeFor };
