// src/google/contactsSheet.js
// Reads and writes CONTACT ROWS in the Contacts worksheet (see docs/26).
//
//   getHeaders()               the header row as it is in the sheet
//   getAllContacts()           every contact row
//   findContactById(id)        one contact, or a clear "not found" result
//   appendContact(contact)     add a new row at the bottom (refuses a duplicate Contact ID)
//   updateContact(id, changes) change fields of an existing row
//   deleteContact(id)          remove that ONE spreadsheet row
//
// Columns, in the existing order of the sheet (A to F):
//   Contact ID | First Name | Last Name | Email | Company | Created Date
//
// This file only talks to the Google Sheets client (sheetsClient.js). It has nothing to do with
// HubSpot: deleting a row here never deletes anything in HubSpot, and nothing in the webhook
// code calls this file yet.
//
// How the rules work:
//   - The worksheet is never created and the header row is never written. Before every
//     operation the first row must match the columns above exactly (else SHEET_HEADERS_MISMATCH).
//   - Google Sheets has no "unique" setting, so uniqueness of Contact ID is CHECKED here, at
//     write time: append refuses an ID that is already there, and find/update/delete refuse an ID
//     that already appears twice (DUPLICATE_CONTACT) instead of guessing which row you mean.
//   - Contact IDs are compared as trimmed text, so 123 and "123" are the same contact.
//   - Writes run one at a time inside this process. Just before an update or delete the row is
//     checked again, so a row that moved in the meantime is not changed by mistake. Edits made by
//     another program or person at the very same moment cannot be fully ruled out (see docs/26).
//   - Text is written with RAW, so Google stores exactly what we send and never turns it into a
//     formula or date.
//
// Errors are GoogleSheetsError objects with fixed messages and codes. An invalid-data error names
// the FIELD that was wrong (error.field) but never its value. Nothing is logged.

const { GoogleSheetsError } = require('./sheetsErrors');
const { getSheetsClient } = require('./sheetsClient');

const COLUMNS = Object.freeze(['Contact ID', 'First Name', 'Last Name', 'Email', 'Company', 'Created Date']);
const FIELDS = Object.freeze(['contactId', 'firstName', 'lastName', 'email', 'company', 'createdDate']);
const WHOLE_TABLE = 'A:F';

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL_CHARACTERS = /\p{C}/u; // includes line breaks and tabs: every cell stays on one line
const MAX_FIELD_CHARS = 1000;
const MAX_EMAIL_CHARS = 254;

const invalid = (field) => new GoogleSheetsError('CONTACT_INVALID', { field });

// ---------------------------------------------------------------------------
// Validation (reports the field name only, never the value)
// ---------------------------------------------------------------------------

function normalizeId(value) {
  const text = Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === 'string' ? value.trim() : null;
  if (text === null || !ID_PATTERN.test(text)) throw invalid('contactId');
  return text;
}

// '' stands for "no value". null and undefined also become ''.
function normalizeText(value, field) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw invalid(field);
  const text = value.trim();
  if (text.length > MAX_FIELD_CHARS || CONTROL_CHARACTERS.test(text)) throw invalid(field);
  if (field === 'email' && text !== '' && (text.length > MAX_EMAIL_CHARS || !EMAIL_PATTERN.test(text))) throw invalid(field);
  return text;
}

// Returns an ISO-8601 text ("2026-11-10T09:30:00.000Z"), or null when nothing was given.
function normalizeDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) throw invalid('createdDate');
  try {
    return date.toISOString();
  } catch {
    throw invalid('createdDate');
  }
}

function requirePlainObject(value, field = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(field);
}

function rejectUnknownKeys(object, allowed) {
  for (const key of Object.keys(object)) {
    if (!allowed.includes(key)) throw invalid(key);
  }
}

// ---------------------------------------------------------------------------
// Rows <-> contacts
// ---------------------------------------------------------------------------

const rowFromContact = (contact) => FIELDS.map((field) => contact[field]);

function contactFromCells(cells) {
  const contact = {};
  FIELDS.forEach((field, index) => {
    contact[field] = String(cells[index] === undefined || cells[index] === null ? '' : cells[index]).trim();
  });
  return contact;
}

// One-at-a-time queue for writes inside this process.
function createSerialQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };
}

function createContactsSheet({ client, now = Date.now } = {}) {
  const clientOk =
    client && ['getValues', 'appendValues', 'updateValues', 'deleteRow'].every((method) => typeof client[method] === 'function');
  if (!clientOk || typeof now !== 'function') throw new GoogleSheetsError('INVALID_INPUT');

  const runWrite = createSerialQueue();

  // Reads the whole table, checks the header row and numbers the rows as the sheet does
  // (the header is row 1, so the first contact is row 2).
  async function loadTable() {
    const values = await client.getValues(WHOLE_TABLE);
    const header = values[0] || [];
    const headerOk = COLUMNS.every((name, index) => String(header[index] === undefined ? '' : header[index]).trim() === name);
    if (!headerOk) throw new GoogleSheetsError('SHEET_HEADERS_MISMATCH');
    const rows = values.slice(1).map((cells, index) => ({ rowNumber: index + 2, contact: contactFromCells(cells), cells }));
    return rows;
  }

  const isEmptyRow = (row) => FIELDS.every((field) => row.contact[field] === '');

  // The single row for this ID. Throws for none (when "required") or for more than one.
  function pickRow(rows, id, { required }) {
    const matches = rows.filter((row) => row.contact.contactId === id);
    if (matches.length > 1) throw new GoogleSheetsError('DUPLICATE_CONTACT');
    if (matches.length === 0) {
      if (required) throw new GoogleSheetsError('CONTACT_NOT_FOUND');
      return null;
    }
    return matches[0];
  }

  // Last look before a change: is that row still holding this Contact ID?
  async function confirmRow(rowNumber, id) {
    const cells = await client.getValues(`A${rowNumber}`);
    const current = cells[0] && cells[0][0] !== undefined ? String(cells[0][0]).trim() : '';
    if (current !== id) throw new GoogleSheetsError('CONTACT_NOT_FOUND');
  }

  const publicContact = (row) => ({ ...row.contact, rowNumber: row.rowNumber });

  return Object.freeze({
    // The first row exactly as it is in the sheet (not checked here, so you can see what is wrong).
    async getHeaders() {
      const values = await client.getValues('A1:F1');
      return (values[0] || []).map((cell) => String(cell).trim());
    },

    async getAllContacts() {
      const rows = await loadTable();
      return rows.filter((row) => !isEmptyRow(row)).map(publicContact);
    },

    // { found: true, contact, rowNumber } or { found: false, contact: null, rowNumber: null }
    async findContactById(contactId) {
      const id = normalizeId(contactId);
      const row = pickRow(await loadTable(), id, { required: false });
      return row ? { found: true, contact: row.contact, rowNumber: row.rowNumber } : { found: false, contact: null, rowNumber: null };
    },

    // Adds one contact at the bottom. Returns { contact, rowNumber } (rowNumber may be null).
    appendContact(input) {
      return runWrite(async () => {
        requirePlainObject(input);
        rejectUnknownKeys(input, FIELDS);
        const contact = {
          contactId: normalizeId(input.contactId),
          firstName: normalizeText(input.firstName, 'firstName'),
          lastName: normalizeText(input.lastName, 'lastName'),
          email: normalizeText(input.email, 'email'),
          company: normalizeText(input.company, 'company'),
          createdDate: normalizeDate(input.createdDate) || new Date(now()).toISOString(),
        };

        const rows = await loadTable();
        if (pickRow(rows, contact.contactId, { required: false })) throw new GoogleSheetsError('DUPLICATE_CONTACT');

        const { rowNumber } = await client.appendValues(WHOLE_TABLE, [rowFromContact(contact)]);
        return { contact, rowNumber };
      });
    },

    // Changes only the fields you pass. The Contact ID cannot be changed; the Created Date stays
    // unless you pass a new one. Use '' or null to empty a text field.
    // Returns { contact, rowNumber }.
    updateContact(contactId, changes) {
      return runWrite(async () => {
        const id = normalizeId(contactId);
        requirePlainObject(changes);
        rejectUnknownKeys(changes, FIELDS);
        if (changes.contactId !== undefined && normalizeId(changes.contactId) !== id) throw invalid('contactId');

        const edits = {};
        for (const field of ['firstName', 'lastName', 'email', 'company']) {
          if (changes[field] !== undefined) edits[field] = normalizeText(changes[field], field);
        }
        if (changes.createdDate !== undefined) {
          const date = normalizeDate(changes.createdDate);
          if (date === null) throw invalid('createdDate');
          edits.createdDate = date;
        }
        if (Object.keys(edits).length === 0) throw invalid(null);

        const row = pickRow(await loadTable(), id, { required: true });
        await confirmRow(row.rowNumber, id);

        const contact = { ...row.contact, ...edits, contactId: id };
        await client.updateValues(`A${row.rowNumber}:F${row.rowNumber}`, [rowFromContact(contact)]);
        return { contact, rowNumber: row.rowNumber };
      });
    },

    // Removes that one row from the worksheet. Returns { deleted: true, contact, rowNumber }
    // where contact is what the row held. Nothing in HubSpot is touched.
    deleteContact(contactId) {
      return runWrite(async () => {
        const id = normalizeId(contactId);
        const row = pickRow(await loadTable(), id, { required: true });
        await confirmRow(row.rowNumber, id);
        await client.deleteRow(row.rowNumber);
        return { deleted: true, contact: row.contact, rowNumber: row.rowNumber };
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Shared instance for the application (created on first use, not at require time)
// ---------------------------------------------------------------------------

let sharedService = null;

function getContactsSheet({ getClient = () => getSheetsClient() } = {}) {
  if (!sharedService) sharedService = createContactsSheet({ client: getClient() });
  return sharedService;
}

function resetContactsSheet() {
  sharedService = null;
}

module.exports = { createContactsSheet, getContactsSheet, resetContactsSheet, COLUMNS, FIELDS };
