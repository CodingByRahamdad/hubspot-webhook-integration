# 25 - The Google Sheets Client (one safe doorway to the spreadsheet)

This lesson explains `src/google/sheetsClient.js`: a small wrapper that every part of the app uses when it needs to talk to Google Sheets. It builds on the sign-in from [docs/23](23-google-service-account-authentication.md) and the settings and error codes introduced in [docs/24](24-google-sheets-connection-status.md).

It is completely separate from HubSpot ([docs/22](22-oauth-token-lifecycle.md)) and from the webhook receiver. Nothing in the webhook code uses it yet.

## The big idea (a mail slot)

Imagine the spreadsheet is a locked office. Instead of letting every part of the program walk in and wave its own keys around, there is **one mail slot** in the door. You push a small, well-formed request through it ("read these cells", "add this row") and get a clean answer or a clean "no".

The slot does the boring, error-prone work once, in one place:

- it knows **which** spreadsheet and **which** tab it belongs to (so callers cannot mix them up);
- it writes ranges correctly (quotes tab names with spaces or apostrophes);
- it turns every Google failure into the app's own safe error codes;
- it keeps the sign-in and the Google connection, so they are not set up again for every request.

## The pieces

| File | Job |
|---|---|
| `src/google/sheetsClient.js` | The client described in this lesson |
| `src/google/sheetsAuth.js` | Sign-in (reused, lesson 23) |
| `src/google/sheetsConfig.js` | Spreadsheet ID and tab name from `.env` (reused, lesson 24) |
| `src/google/sheetsErrors.js` | `GoogleSheetsError` and the translation of Google failures (reused) |
| `tests/sheets-client.test.js` | Tests, using a pretend spreadsheet in memory |
| `tests/helpers/fake-sheets-api.js` | The pretend spreadsheet used by the tests |

## How the client is created

```
getSheetsClient()
  |  1. spreadsheet ID + tab name   <- sheetsConfig.js   (from GOOGLE_SHEETS_SPREADSHEET_ID / _CONTACTS_TAB)
  |  2. sign-in object              <- sheetsAuth.js     (reads the key file once, builds the Google JWT client)
  |  3. Sheets API object           <- @googleapis/sheets  sheets({ version: 'v4', auth })
  |  4. createSheetsClient({ api, spreadsheetId, tab })   -> the client
  v
the same client object is returned on every later call
```

- **Created on first use**, not when the server starts. A missing Google setup can never stop the server or the webhook receiver from starting.
- **Reused afterwards**: the client is built once and remembered, so there is no repeated key-file reading or setup.
- **A failed start is not remembered**: if the key file was missing and you fix it, the next call simply tries again.
- No separate "sign in now" request is made. The Google library gets its access token automatically at the first real request and renews it itself. If Google rejects the key, you get `AUTH_FAILED` from that request.

Using it:

```js
const { getSheetsClient } = require('./src/google/sheetsClient');

const client = getSheetsClient();            // throws a GoogleSheetsError if not configured
const rows = await client.getValues('A:F');  // [['Contact ID', 'First Name', ...], ['101', 'Ada', ...]]
```

## The methods

| Method | What it does | Google call |
|---|---|---|
| `getValues('A:F')` | Reads cells; returns an array of rows, every cell as text. An empty range returns `[]`. | `values.get` (formatted values) |
| `appendValues('A:F', rows)` | Adds the rows below the existing data. Returns `{ rowNumber }` of the first new row (or `null`). | `values.append` (`RAW`, `INSERT_ROWS`) |
| `updateValues('A3:F3', rows)` | Overwrites exactly that range. Returns `{ updatedCells }`. | `values.update` (`RAW`) |
| `getWorksheetId()` | The numeric id of the tab (needed for deleting rows). Metadata only. | `spreadsheets.get` (`fields: sheets.properties(sheetId,title)`) |
| `deleteRow(3)` | Removes that one row; the rows below move up. **Row 1 (the header) is refused.** | `spreadsheets.batchUpdate` (`deleteDimension`) |

The range you pass is plain "A1 notation" such as `A:F`, `A1:F1` or `A7`. The client adds the tab name itself (`'Contacts'!A:F`) and **rejects anything else**, so a caller cannot sneak in another tab or a strange range.

### Why `RAW`?

When a program writes `=1+1` into a cell, Google normally turns it into a formula. With `RAW` Google stores **exactly the text it was given**. That protects against "formula injection" (text from outside that turns into a formula), and keeps IDs such as `00123` from being changed into the number 123.

### The timeout

Every request has a 15-second timeout, so a stuck connection cannot hang the app forever.

## Errors

The client never lets a raw Google error escape. Everything is a `GoogleSheetsError` (lesson 23) with a fixed message and a code; the original text (which can contain the spreadsheet ID or the service-account e-mail) is thrown away.

| What happened | Code | Retry later? |
|---|---|---|
| Not shared with the service account, or API disabled (HTTP 403) | `PERMISSION_DENIED` | no |
| Spreadsheet does not exist (404) | `SPREADSHEET_NOT_FOUND` | no |
| Google rejects the sign-in (401) | `AUTH_FAILED` | no |
| **The tab does not exist** | `WORKSHEET_NOT_FOUND` | no |
| Google rate limit (429, or 403 with a quota reason) | `RATE_LIMITED` | **yes** |
| Google outage (5xx) or network problem | `API_UNAVAILABLE` | **yes** |
| Google's reply has an unexpected shape | `UNEXPECTED_RESPONSE` | no |
| Bad input to the client (wrong range, unusable rows) | `INVALID_INPUT` | no |
| Anything else | `INTERNAL_ERROR` | no |

**A missing tab** needs a special note. If you ask Google for `'Typo'!A:F` and the tab does not exist, Google answers a confusing "400, cannot parse range". When the client sees such a 400, it looks at the list of tabs and, if yours is not there, reports a clear `WORKSHEET_NOT_FOUND`. **The client never creates a tab.**

The client does not retry by itself. `retryable` only tells the caller that trying again later may work. Automatic retries are a later lesson.

## Security

- The spreadsheet ID lives only inside the client and is never put in an error or a log.
- Nothing is logged by the client. Tests prove it.
- The client has no method that clears data, creates sheets or changes formatting; it only reads, appends, updates and deletes single rows.
- No HubSpot code is imported.

## Local development vs production (Render)

The client reads its settings from the environment, so nothing changes between your computer and Render: you set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE`, `GOOGLE_SHEETS_SPREADSHEET_ID` and `GOOGLE_SHEETS_CONTACTS_TAB` in `.env` locally and in the Render dashboard (with the key as a Secret File) in production.

## Tests

`node --test tests/sheets-client.test.js` (also part of `npm test`). The tests use a **pretend spreadsheet in memory** (`tests/helpers/fake-sheets-api.js`). It copies the behaviours that matter (a missing tab gives a 400, empty rows in the middle come back as `[]`) and **throws if the code ever calls something it should not** (clear, create, ...). No real key is read, Google is never contacted, and the Google settings in the environment are blanked while the tests run.

They cover: creating and validating a client, reusing it, a failed start not being remembered, the exact requests sent (spreadsheet, quoted range, `RAW`, `INSERT_ROWS`, timeout, `deleteDimension` positions), refusing to delete the header, the missing-tab case, every error mapping, bad replies, nothing being logged and no secret appearing in any error.

## What this still does not do

- It knows nothing about contacts or columns; that is [docs/26](26-google-contacts-sheet-service.md).
- No automatic retries or backoff.
- No caching of cell data: every read asks Google again.
- Not connected to the webhook receiver.
