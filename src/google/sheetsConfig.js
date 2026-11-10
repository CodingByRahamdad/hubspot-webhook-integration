// src/google/sheetsConfig.js
// Reads the non-secret Google Sheets settings from the environment (see docs/24).
//
//   GOOGLE_SHEETS_SPREADSHEET_ID   REQUIRED  which spreadsheet to use
//   GOOGLE_SHEETS_CONTACTS_TAB     optional  worksheet (tab) with the contacts, default "Contacts"
//
// The service-account key path is handled separately in sheetsAuth.js.
// "env" is a parameter so tests never need the real environment. Nothing here logs,
// and errors carry only a fixed message and a code (never the value that was wrong).

const { GoogleSheetsError } = require('./sheetsErrors');

const SPREADSHEET_ID_ENV_VAR = 'GOOGLE_SHEETS_SPREADSHEET_ID';
const CONTACTS_TAB_ENV_VAR = 'GOOGLE_SHEETS_CONTACTS_TAB';
const DEFAULT_CONTACTS_TAB = 'Contacts'; // the documented default in .env.example
const MAX_TAB_NAME_CHARS = 100; // Google's own limit for a worksheet name

// Spreadsheet IDs are letters, digits, "-" and "_" (44 characters in practice).
const SPREADSHEET_ID_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

function getSpreadsheetId(env = process.env) {
  const raw = env ? env[SPREADSHEET_ID_ENV_VAR] : undefined;
  if (typeof raw !== 'string' || raw.trim() === '') throw new GoogleSheetsError('SPREADSHEET_ID_MISSING');
  const id = raw.trim();
  if (!SPREADSHEET_ID_PATTERN.test(id)) throw new GoogleSheetsError('SPREADSHEET_ID_INVALID');
  return id;
}

function getContactsTab(env = process.env) {
  const raw = env ? env[CONTACTS_TAB_ENV_VAR] : undefined;
  if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return DEFAULT_CONTACTS_TAB;
  if (typeof raw !== 'string' || raw.trim().length > MAX_TAB_NAME_CHARS) throw new GoogleSheetsError('INVALID_INPUT');
  return raw.trim();
}

module.exports = {
  SPREADSHEET_ID_ENV_VAR,
  CONTACTS_TAB_ENV_VAR,
  DEFAULT_CONTACTS_TAB,
  getSpreadsheetId,
  getContactsTab,
};
