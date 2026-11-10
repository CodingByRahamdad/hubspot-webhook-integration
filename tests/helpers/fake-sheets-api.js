// tests/helpers/fake-sheets-api.js
//
// An IN-MEMORY stand-in for the Google Sheets API, used by tests/sheets-client.test.js and
// tests/contacts-sheet.test.js. It is a tiny spreadsheet in an array: no network, no
// credentials, and it can never touch the real spreadsheet.
//
// It implements only what the client uses (spreadsheets.get, spreadsheets.batchUpdate with
// deleteDimension, values.get, values.append, values.update). Any other method (clear,
// batchUpdate on values, create ...) records the call and THROWS, so a test fails if the code
// ever tries something it should not.
//
// It copies a few real behaviours of Google: a bad range or a missing tab is "400"; empty
// rows between data come back as []; trailing empty rows and cells are left out; values are
// returned as text.
//
// This file is not a test itself (npm test only runs tests/*.test.js).

const FAKE_SPREADSHEET_ID = 'FAKEspreadsheetID_0123456789abcdefghij';
const HEADER = ['Contact ID', 'First Name', 'Last Name', 'Email', 'Company', 'Created Date'];

// An error shaped like the ones the Google library throws. Its message holds "secrets" on
// purpose, so tests can prove they never reach the caller.
function googleError(status, extra = {}) {
  return Object.assign(new Error(`Request failed for ${FAKE_SPREADSHEET_ID} fake-sa@fake-project.iam.gserviceaccount.com ya29.fake-token`), {
    response: { status },
    ...extra,
  });
}

const columnIndex = (letters) => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const asText = (cell) => (cell === null || cell === undefined ? '' : String(cell));

function createFakeSheetsApi({
  spreadsheetId = FAKE_SPREADSHEET_ID,
  tab = 'Contacts',
  sheetId = 777,
  rows = [HEADER],
  otherTabs = ['Archive'],
} = {}) {
  const state = { grid: rows.map((row) => row.slice()) };
  const calls = [];
  const failures = new Map(); // "values.get" -> [error, ...] (each used once)
  const hooks = { beforeValuesGet: null };
  let valuesGetCount = 0;

  function record(method, params, options) {
    calls.push({ method, params: JSON.parse(JSON.stringify(params || {})), options });
  }
  function maybeFail(method) {
    const queue = failures.get(method);
    if (queue && queue.length > 0) throw queue.shift();
  }
  function checkId(params) {
    if (params.spreadsheetId !== spreadsheetId) throw googleError(404);
  }

  // "'My Tab'!A1:F1" -> { startRow, endRow, startCol, endCol } (0-based, endRow may be Infinity)
  function parseRange(range) {
    const m = /^(?:'((?:[^']|'')+)'|([^'!]+))!(.+)$/.exec(String(range));
    if (!m) throw googleError(400);
    const name = m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2];
    if (name !== tab) throw googleError(400); // Google: "Unable to parse range"
    const a = /^([A-Z]+)([0-9]*)(?::([A-Z]+)([0-9]*))?$/.exec(m[3]);
    if (!a) throw googleError(400);
    const startCol = columnIndex(a[1]);
    const startRow = a[2] ? Number(a[2]) - 1 : 0;
    const endCol = a[3] ? columnIndex(a[3]) : startCol;
    let endRow;
    if (a[3] === undefined) endRow = a[2] ? startRow : Infinity;
    else endRow = a[4] ? Number(a[4]) - 1 : Infinity;
    return { name, startRow, endRow, startCol, endCol };
  }

  const lastDataRow = () => {
    for (let i = state.grid.length - 1; i >= 0; i -= 1) {
      if (state.grid[i].some((cell) => asText(cell) !== '')) return i;
    }
    return -1;
  };

  const forbidden = (name) => (params, options) => {
    record(name, params, options);
    throw new Error(`forbidden call: ${name}`);
  };

  const api = {
    spreadsheets: {
      async get(params, options) {
        record('spreadsheets.get', params, options);
        maybeFail('spreadsheets.get');
        checkId(params);
        const titles = [tab, ...otherTabs];
        return {
          data: { sheets: titles.map((title, index) => ({ properties: { sheetId: index === 0 ? sheetId : sheetId + index, title } })) },
        };
      },

      async batchUpdate(params, options) {
        record('spreadsheets.batchUpdate', params, options);
        maybeFail('spreadsheets.batchUpdate');
        checkId(params);
        for (const request of params.requestBody.requests) {
          const deletion = request.deleteDimension;
          if (!deletion) throw new Error('forbidden request type in batchUpdate');
          const { range } = deletion;
          if (range.sheetId !== sheetId || range.dimension !== 'ROWS') throw googleError(400);
          state.grid.splice(range.startIndex, range.endIndex - range.startIndex);
        }
        return { data: { spreadsheetId: params.spreadsheetId, replies: [{}] } };
      },

      values: {
        async get(params, options) {
          record('values.get', params, options);
          valuesGetCount += 1;
          if (hooks.beforeValuesGet) hooks.beforeValuesGet(valuesGetCount, state);
          maybeFail('values.get');
          checkId(params);
          const r = parseRange(params.range);
          let slice = state.grid.slice(r.startRow, r.endRow === Infinity ? undefined : r.endRow + 1).map((row) => {
            const cells = row.slice(r.startCol, r.endCol + 1).map(asText);
            while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
            return cells;
          });
          while (slice.length > 0 && slice[slice.length - 1].length === 0) slice.pop();
          const data = { range: params.range, majorDimension: 'ROWS' };
          if (slice.length > 0) data.values = slice;
          return { data };
        },

        async append(params, options) {
          record('values.append', params, options);
          maybeFail('values.append');
          checkId(params);
          const r = parseRange(params.range);
          const start = lastDataRow() + 1;
          params.requestBody.values.forEach((values, i) => {
            const row = [];
            values.forEach((cell, c) => {
              row[r.startCol + c] = asText(cell);
            });
            state.grid[start + i] = Array.from(row, (cell) => (cell === undefined ? '' : cell));
          });
          const first = start + 1;
          const last = start + params.requestBody.values.length;
          return {
            data: {
              spreadsheetId: params.spreadsheetId,
              updates: { updatedRange: `${r.name}!A${first}:F${last}`, updatedRows: params.requestBody.values.length },
            },
          };
        },

        async update(params, options) {
          record('values.update', params, options);
          maybeFail('values.update');
          checkId(params);
          const r = parseRange(params.range);
          let cells = 0;
          params.requestBody.values.forEach((values, i) => {
            const rowIndex = r.startRow + i;
            while (state.grid.length <= rowIndex) state.grid.push([]);
            values.forEach((cell, c) => {
              const row = state.grid[rowIndex];
              while (row.length < r.startCol + c) row.push('');
              row[r.startCol + c] = asText(cell);
              cells += 1;
            });
          });
          return { data: { updatedCells: cells, updatedRange: params.range } };
        },

        clear: forbidden('values.clear'),
        batchUpdate: forbidden('values.batchUpdate'),
        batchClear: forbidden('values.batchClear'),
      },
      create: forbidden('spreadsheets.create'),
      developerMetadata: { get: forbidden('developerMetadata.get') },
    },
  };

  return {
    api,
    calls,
    state,
    hooks,
    spreadsheetId,
    tab,
    sheetId,
    // Makes the next call of "method" (for example "values.get") fail with this error.
    failNext(method, error) {
      if (!failures.has(method)) failures.set(method, []);
      failures.get(method).push(error);
    },
    callsOf: (method) => calls.filter((c) => c.method === method),
    // The calls that could change the spreadsheet.
    writeCalls: () => calls.filter((c) => ['values.append', 'values.update', 'spreadsheets.batchUpdate'].includes(c.method)),
    // The sheet as plain rows (copies).
    snapshot: () => state.grid.map((row) => row.slice()),
  };
}

module.exports = { createFakeSheetsApi, googleError, FAKE_SPREADSHEET_ID, HEADER };
