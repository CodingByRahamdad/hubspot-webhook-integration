# 26 - The Contacts Sheet Service (contacts as rows)

This lesson explains `src/google/contactsSheet.js`: the part of the app that treats the `Contacts` worksheet like a small contact list. It uses the client from [docs/25](25-google-sheets-client.md) and the same safe errors as the rest of the Google code ([docs/23](23-google-service-account-authentication.md), [docs/24](24-google-sheets-connection-status.md)).

It has **nothing to do with HubSpot's API**, and nothing in the webhook code calls it yet. It does not copy anything from HubSpot automatically. Deleting a row here never deletes a contact in HubSpot.

## The big idea (a paper address book)

Think of the worksheet as a paper address book with a heading line at the top:

| A | B | C | D | E | F |
|---|---|---|---|---|---|
| Contact ID | First Name | Last Name | Email | Company | Created Date |

The service is the careful person who keeps the book. Before touching it, they check the heading line is the one they expect. They look a contact up by its **Contact ID**, they refuse to write the same ID twice, they never scribble over the heading, and they only ever change the one line they were asked about.

## The pieces

| File | Job |
|---|---|
| `src/google/contactsSheet.js` | The service described in this lesson |
| `src/google/sheetsClient.js` | Reads and writes cells (docs/25) |
| `src/google/sheetsErrors.js` | Safe error codes |
| `tests/contacts-sheet.test.js` | Tests on a pretend spreadsheet in memory |

## How it fits together

```
your code
   |  service.appendContact({ contactId: '101', firstName: 'Ada', ... })
   v
contactsSheet.js   - checks the data, checks the header row, checks for duplicates,
   |                 decides WHICH row
   |  client.getValues('A:F'), client.appendValues(...), client.updateValues(...), client.deleteRow(...)
   v
sheetsClient.js    - builds the right Google request, translates errors
   v
Google Sheets
```

Create it like this:

```js
const { getContactsSheet } = require('./src/google/contactsSheet');

const contacts = getContactsSheet();   // built on first use, then reused
```

## A contact

A contact is a plain object. The field names map to the columns:

| Field | Column | Required? | Rules |
|---|---|---|---|
| `contactId` | A - Contact ID | **yes** | letters, digits, `-` or `_`, 1-64 characters. A whole number such as `101` is accepted and stored as the text `"101"`. |
| `firstName` | B - First Name | no | text up to 1000 characters, one line |
| `lastName` | C - Last Name | no | same |
| `email` | D - Email | no | if given, must look like an e-mail address |
| `company` | E - Company | no | text up to 1000 characters, one line |
| `createdDate` | F - Created Date | no | a date (text, Date object or timestamp); stored as ISO-8601 text such as `2026-11-10T09:30:00.000Z`. When you append without one, **the current time** is used. |

Text is **trimmed** (spaces at the start and end are removed). Unknown fields are rejected, not ignored, so a typo like `emial` is caught.

## The methods

### `getHeaders()`
Returns the heading row as it really is in the sheet, for example `['Contact ID', 'First Name', ...]`. It is not checked, so you can see what is wrong if something is.

### `getAllContacts()`
Returns every contact as an object plus its `rowNumber`. Completely empty rows are skipped, short rows are filled with empty text.

### `findContactById('101')`
Returns one of:

```js
{ found: true,  contact: { contactId: '101', ... }, rowNumber: 2 }
{ found: false, contact: null,                       rowNumber: null }   // not an error
```

`101`, `"101"` and `" 101 "` all mean the same contact (IDs are compared as trimmed text).

### `appendContact(contact)`
Adds a new row at the bottom. Returns `{ contact, rowNumber }` (the row number can be `null` if Google does not say). **Refuses** (`DUPLICATE_CONTACT`) if the Contact ID is already in the sheet.

### `updateContact('101', { email: 'new@example.com' })`
Changes only the fields you pass; every other field keeps its value. Rules:
- the Contact ID cannot be changed (passing the same ID is fine, a different one is an error);
- the Created Date stays unless you pass a new one;
- pass `''` or `null` to empty a text field;
- passing nothing to change is an error;
- only that one row is written (for example `A3:F3`).

Returns `{ contact, rowNumber }`. If there is no such contact: `CONTACT_NOT_FOUND`.

### `deleteContact('101')`
Removes **that one row** from the worksheet; the rows below move up. Returns `{ deleted: true, contact, rowNumber }` where `contact` is what the row contained. If there is no such contact: `CONTACT_NOT_FOUND`. **Nothing in HubSpot is touched.** The header row can never be deleted.

## The safety rules

1. **The header row is a safety check.** Before every operation the first row must be exactly the six names above (capital letters matter; extra spaces around a name are ignored). Otherwise you get `SHEET_HEADERS_MISMATCH` and nothing is written. The service never writes or repairs headers, so it cannot overwrite them by accident, and it will not guess when someone reorders the columns.
2. **A missing worksheet is an error, not something to fix silently.** You get `WORKSHEET_NOT_FOUND`. The service never creates a tab.
3. **Contact IDs are not unique by themselves.** Google Sheets has no "unique" setting, so the service checks:
   - `appendContact` refuses an ID that is already there;
   - if an ID **already appears twice** (for example because someone typed it by hand), `find`, `update` and `delete` refuse with `DUPLICATE_CONTACT` rather than guess which row you mean. Clean the sheet up by hand, then try again.
4. **Data is stored exactly as given (`RAW`).** Text such as `=1+1` or `+1234` stays plain text; Google never turns it into a formula or number.
5. **Writes happen one at a time** inside the app. Two `appendContact` calls for the same new ID at the same moment: one succeeds, the other gets `DUPLICATE_CONTACT`.
6. **The row is re-checked right before a change.** Rows are found by position. Between "I found the row" and "I changed it", someone might delete a row above it and shift everything up. So just before an update or delete the service reads that row's Contact ID again; if it no longer matches, it stops with `CONTACT_NOT_FOUND` instead of changing the wrong row.

## Errors

All errors are `GoogleSheetsError` objects with a fixed message and a code (see lesson 23). The codes you will meet here:

| Code | Meaning |
|---|---|
| `CONTACT_INVALID` | The data is not valid. `error.field` names the field (for example `email`); the value is never repeated. |
| `CONTACT_NOT_FOUND` | Update or delete found no row with that ID (or the row moved while working). |
| `DUPLICATE_CONTACT` | Append would create a duplicate, or an existing ID is ambiguous. |
| `SHEET_HEADERS_MISMATCH` | The first row is not the expected six columns. |
| `WORKSHEET_NOT_FOUND` | The tab does not exist. |
| `UNEXPECTED_RESPONSE` | Google's reply had an unexpected shape. |
| `PERMISSION_DENIED`, `SPREADSHEET_NOT_FOUND`, `AUTH_FAILED` | Access problems (see lesson 24 for fixes). |
| `RATE_LIMITED`, `API_UNAVAILABLE` | Temporary; `error.retryable` is `true`. |

A typical way to handle them:

```js
try {
  await contacts.appendContact({ contactId: '101', firstName: 'Ada', email: 'ada@example.com' });
} catch (err) {
  if (err.code === 'DUPLICATE_CONTACT') { /* already there: maybe update instead */ }
  else if (err.retryable) { /* try again later */ }
  else { /* report err.code - never log anything else from the request */ }
}
```

## Honest limits

- **Not "exactly once" across programs.** The one-at-a-time rule and the re-check protect against problems inside this app. If another program or a person edits the sheet in the very same instant, a conflict is unlikely but cannot be fully ruled out. Run **one** server process.
- **Every operation reads the whole table** (`A:F`) so that it can check the header and look for duplicates. This is fine for hundreds or thousands of contacts. Google limits how many requests per minute are allowed, so a very large sheet or a burst of calls will need caching and batching later.
- **No automatic retries.** `retryable` only tells you that trying again may work.
- **Only columns A to F** are read and written. Anything you add in column G or beyond is ignored and left alone.

## Local development vs production (Render)

Same code and settings as lesson 25: the spreadsheet ID and tab come from `GOOGLE_SHEETS_SPREADSHEET_ID` and `GOOGLE_SHEETS_CONTACTS_TAB`, the key from `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`. Locally use `.env`; on Render use the dashboard and a Secret File.

**Be careful when you experiment:** these methods change the real spreadsheet. Try them on a copy of the sheet or a scratch tab first (set `GOOGLE_SHEETS_CONTACTS_TAB` to the scratch tab).

## Tests

`node --test tests/contacts-sheet.test.js` (also part of `npm test`). The service runs on the real client, but the Google API underneath is a **pretend spreadsheet in memory** (`tests/helpers/fake-sheets-api.js`). No real key is read, Google is never contacted, and the real spreadsheet cannot be touched.

They cover: the column order; headers; reading contacts (empty and short rows, numbering); finding (found, not found, text vs number IDs); appending (order, defaults, trimming, dates, formulas stored as text); duplicates; a full validation matrix; partial updates, immutable IDs, clearing fields; deleting only the right row and never the header; ambiguous IDs; wrong or missing headers; a missing worksheet; every Google error; failed writes leaving the sheet unchanged; two appends at once; a row that moves during a change; nothing logged; no secrets in errors; and that no other app code imports these modules (so the webhook behavior is unchanged).

## What this still does not do

- It is **not connected to the webhook receiver** and does not copy contacts from HubSpot. That comes later and needs its own design (the receiver must answer HubSpot within 5 seconds).
- It has no "update or insert" shortcut yet; you choose between `appendContact` and `updateContact` (use `findContactById` first).
- No bulk operations and no automatic retries.
