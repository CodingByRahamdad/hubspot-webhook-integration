// scripts/sheets-crud-demo.js
// A deliberate, step-by-step CRUD demonstration against the REAL "Contacts_Test" worksheet
// (see docs/27). It WRITES to Google Sheets and it DELETES a spreadsheet row.
//
// Run it by hand, and only when you mean to:
//   npm run sheets:crud-demo
//
// It is never part of `npm test` and no test ever runs it against Google.
//
// Safety checks (all must pass, otherwise it stops BEFORE contacting Google):
//   1. GOOGLE_SHEETS_SPREADSHEET_ID is set
//   2. GOOGLE_SHEETS_CONTACTS_TAB is exactly  Contacts_Test   (never Contacts, never anything else)
//   3. GOOGLE_SHEETS_ALLOW_TEST_WRITES is exactly  true
//
// What it does (always with the existing contacts service, src/google/contactsSheet.js):
//   read headers -> append ONE sample contact -> read all -> find -> update its Company ->
//   find again -> delete it -> find again (gone) -> confirm the worksheet is as it was.
// The sample has a generated, clearly marked Contact ID (TEST-DEMO-...). Nothing else is
// updated or deleted. If a step fails after the sample was added, the script tries to remove
// that exact record again ("cleanup").
//
// It uses no HubSpot code. It prints step results, the test Contact ID and counts, and fixed
// error codes: never credentials, tokens, the spreadsheet ID or other people's contact data.
//
// Exit codes: 0 = every step worked and was verified
//             1 = a step or verification failed (see the output; cleanup was attempted)
//             2 = refused because a safety check did not pass (nothing was sent to Google)

const crypto = require('node:crypto');
const { GoogleSheetsError } = require('../src/google/sheetsErrors');
const { getSpreadsheetId } = require('../src/google/sheetsConfig');
const { COLUMNS, FIELDS } = require('../src/google/contactsSheet');

const REQUIRED_TAB = 'Contacts_Test';
const TAB_VAR = 'GOOGLE_SHEETS_CONTACTS_TAB';
const OPT_IN_VAR = 'GOOGLE_SHEETS_ALLOW_TEST_WRITES';
const TOTAL_STEPS = 10;

// A failed verification (the service answered, but not with what we expected).
class DemoCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DemoCheckError';
  }
}

// A unique, obviously-fake Contact ID, for example TEST-DEMO-LZX3K9-1a2b3c4d.
function generateTestContactId({ now = Date.now, randomBytes = crypto.randomBytes } = {}) {
  return `TEST-DEMO-${now().toString(36).toUpperCase()}-${randomBytes(4).toString('hex')}`;
}

// Returns the list of safety problems (empty = safe to continue). Fixed texts only.
function checkSafety(env) {
  const problems = [];
  try {
    getSpreadsheetId(env);
  } catch (err) {
    problems.push(`Spreadsheet ID: ${err instanceof GoogleSheetsError ? err.code : 'INVALID'}. Set GOOGLE_SHEETS_SPREADSHEET_ID.`);
  }
  const tab = env ? env[TAB_VAR] : undefined;
  if (typeof tab !== 'string' || tab === '') {
    problems.push(`${TAB_VAR} is not set. It must be exactly ${REQUIRED_TAB}.`);
  } else if (tab !== REQUIRED_TAB) {
    problems.push(`${TAB_VAR} is not ${REQUIRED_TAB}. This demonstration only ever writes to ${REQUIRED_TAB}.`);
  }
  const optIn = env ? env[OPT_IN_VAR] : undefined;
  if (optIn !== 'true') {
    problems.push(`${OPT_IN_VAR} is not exactly "true". Writes are not allowed.`);
  }
  return problems;
}

function describe(err) {
  if (err instanceof GoogleSheetsError) return `${err.code} - ${err.message}${err.field ? ` (field: ${err.field})` : ''}`;
  if (err instanceof DemoCheckError) return err.message;
  return 'Unexpected error';
}

// The real service. Only valid for the real environment, so the checked settings and the
// settings the service really uses can never differ.
function defaultCreateService(env) {
  if (env !== process.env) throw new GoogleSheetsError('INVALID_INPUT');
  return require('../src/google/contactsSheet').getContactsSheet();
}

const sameFields = (a, b, fields) => fields.every((field) => a[field] === b[field]);
const rowKey = (contact) => JSON.stringify(FIELDS.map((field) => contact[field]));

async function runCrudDemo({
  env = process.env,
  out = console.log,
  createService = () => defaultCreateService(env),
  generateId = () => generateTestContactId(),
  now = Date.now,
} = {}) {
  out('Google Sheets CRUD demonstration');
  out('--------------------------------');

  // 1. Safety checks, before anything touches Google.
  const problems = checkSafety(env);
  if (problems.length > 0) {
    out('REFUSED: the safety checks did not pass. Nothing was sent to Google.');
    problems.forEach((problem) => out(`  - ${problem}`));
    out('');
    out('Overall status: REFUSED');
    return { ok: false, refused: true, exitCode: 2, testContactId: null };
  }

  let service;
  try {
    service = createService();
  } catch (err) {
    out(`Could not start the Google Sheets service: ${describe(err)}`);
    out('');
    out('Overall status: FAILED');
    return { ok: false, refused: false, exitCode: 1, testContactId: null };
  }

  const id = generateId();
  const sample = {
    contactId: id,
    firstName: 'Demo',
    lastName: 'Test',
    email: `${id.toLowerCase()}@example.invalid`,
    company: 'Demo Company (test)',
    createdDate: new Date(now()).toISOString(),
  };
  const UPDATED_COMPANY = 'Demo Company UPDATED (test)';
  const unchangedFields = ['contactId', 'firstName', 'lastName', 'email', 'createdDate'];

  out(`Worksheet: ${REQUIRED_TAB}`);
  out(`Test Contact ID for this run: ${id}`);
  out('');

  let stepNumber = 0;
  async function step(title, action) {
    stepNumber += 1;
    try {
      const detail = await action();
      out(`[${stepNumber}/${TOTAL_STEPS}] ${title}: OK${detail ? ` (${detail})` : ''}`);
    } catch (err) {
      out(`[${stepNumber}/${TOTAL_STEPS}] ${title}: FAILED`);
      throw err;
    }
  }

  let baseline = [];
  let appendAttempted = false;
  let removed = false;
  let failure = null;

  try {
    await step('Read the worksheet headers', async () => {
      const headers = await service.getHeaders();
      if (JSON.stringify(headers) !== JSON.stringify([...COLUMNS])) {
        throw new DemoCheckError('The worksheet headers are not the expected six columns.');
      }
      return headers.join(' | ');
    });

    await step('Read the existing contacts (baseline)', async () => {
      baseline = await service.getAllContacts();
      if (baseline.some((contact) => contact.contactId === id)) {
        throw new DemoCheckError('The generated test Contact ID already exists; nothing was written.');
      }
      return `${baseline.length} existing contact(s)`;
    });

    await step('Create: append the sample contact', async () => {
      appendAttempted = true; // from here on, cleanup may be needed
      const result = await service.appendContact(sample);
      if (!result || !result.contact || result.contact.contactId !== id) {
        throw new DemoCheckError('Appending did not return the sample contact.');
      }
      return result.rowNumber ? `row ${result.rowNumber}` : null;
    });

    await step('Read: all contacts include the sample', async () => {
      const all = await service.getAllContacts();
      const matches = all.filter((contact) => contact.contactId === id);
      if (matches.length !== 1 || !sameFields(matches[0], sample, FIELDS)) {
        throw new DemoCheckError('The sample contact was not found exactly once with the expected values.');
      }
      return `${all.length} contact(s), sample present once`;
    });

    await step('Read: find the sample by its Contact ID', async () => {
      const result = await service.findContactById(id);
      if (!result.found || !sameFields(result.contact, sample, FIELDS)) {
        throw new DemoCheckError('Finding the sample by its Contact ID failed.');
      }
      return `row ${result.rowNumber}`;
    });

    await step('Update: change the Company of the sample', async () => {
      const result = await service.updateContact(id, { company: UPDATED_COMPANY });
      if (!result || !result.contact || result.contact.company !== UPDATED_COMPANY) {
        throw new DemoCheckError('The update did not return the new Company value.');
      }
      return null;
    });

    await step('Read: verify the updated Company', async () => {
      const result = await service.findContactById(id);
      if (!result.found || result.contact.company !== UPDATED_COMPANY || !sameFields(result.contact, sample, unchangedFields)) {
        throw new DemoCheckError('The sheet does not show the updated Company (or other fields changed).');
      }
      return 'Company changed, other fields unchanged';
    });

    await step('Delete: remove the sample row', async () => {
      const result = await service.deleteContact(id);
      if (!result || result.deleted !== true || !result.contact || result.contact.contactId !== id) {
        throw new DemoCheckError('The delete did not report the sample contact as removed.');
      }
      return result.rowNumber ? `row ${result.rowNumber}` : null;
    });

    await step('Read: verify the sample is gone', async () => {
      const result = await service.findContactById(id);
      if (result.found) throw new DemoCheckError('The test contact still exists after deleting it.');
      removed = true;
      return null;
    });

    await step('Verify: the worksheet is back to its original content', async () => {
      const after = await service.getAllContacts();
      const before = baseline.map(rowKey);
      const now_ = after.map(rowKey);
      if (before.length !== now_.length || before.some((key, index) => key !== now_[index])) {
        throw new DemoCheckError('The worksheet content differs from before the test.');
      }
      return `${after.length} contact(s), identical to the baseline`;
    });
  } catch (err) {
    failure = err;
    out(`Stopped: ${describe(err)}`);
  } finally {
    // Cleanup: only ever the record created by THIS run, found by its exact generated ID.
    if (appendAttempted && !removed) {
      out('');
      out('Cleanup: removing the test record created by this run...');
      try {
        const found = await service.findContactById(id);
        if (!found.found) {
          out('Cleanup: the test record is not in the worksheet (nothing to remove).');
        } else {
          await service.deleteContact(id);
          const again = await service.findContactById(id);
          if (again.found) throw new DemoCheckError('The test record is still there after cleanup.');
          out('Cleanup: the test record was removed.');
        }
      } catch (cleanupError) {
        out(`Cleanup FAILED (${describe(cleanupError)}).`);
        out(`Please delete the row with Contact ID ${id} in the ${REQUIRED_TAB} worksheet by hand. Do not touch any other row.`);
        failure = failure || cleanupError;
      }
    }
  }

  out('');
  if (failure) {
    out('Overall status: FAILED');
    return { ok: false, refused: false, exitCode: 1, testContactId: id };
  }
  out('Overall status: SUCCESS');
  return { ok: true, refused: false, exitCode: 0, testContactId: id };
}

module.exports = { runCrudDemo, generateTestContactId, checkSafety, REQUIRED_TAB, OPT_IN_VAR };

if (require.main === module) {
  // Load .env only when run directly, so importing this file (tests) never reads it.
  require('dotenv').config({ quiet: true });
  runCrudDemo().then(
    (result) => {
      process.exitCode = result.exitCode;
    },
    () => {
      console.error('The CRUD demonstration stopped unexpectedly.');
      process.exitCode = 1;
    }
  );
}
