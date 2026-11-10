# 24 - Google Sheets Connection Status (a read-only health check)

This lesson explains `npm run sheets:status`, a small script that answers one question: **"Can this app reach my spreadsheet?"** It sits on top of the sign-in code from [docs/23](23-google-service-account-authentication.md) and does nothing else. Reading and writing contacts comes in later lessons.

It is completely separate from HubSpot ([docs/22](22-oauth-token-lifecycle.md)) and from the webhook receiver. It uses no HubSpot token and no webhook code.

## Why the script exists (the doorbell test)

Before you move into a house you ring the doorbell. If nobody answers, you want to know *why* (wrong address? no key? nobody home?) before you start carrying boxes.

Many things must be right for Sheets to work: the key file, its path, the spreadsheet ID, the sharing, the worksheet name, the internet. The status script checks them **one by one** and says which one is wrong, using plain words instead of a long Google error.

## The pieces

| File | Job |
|---|---|
| `scripts/sheets-status.js` | The check itself and its printed report |
| `src/google/sheetsAuth.js` | Sign-in (from lesson 23, reused as is) |
| `src/google/sheetsConfig.js` | Reads `GOOGLE_SHEETS_SPREADSHEET_ID` and `GOOGLE_SHEETS_CONTACTS_TAB` |
| `src/google/sheetsErrors.js` | The error class and the translation of Google failures into safe codes |
| `tests/sheets-status.test.js` | Tests with a fake sign-in and a fake Google (no real request) |

## How it works

```
npm run sheets:status
  |
  | 1. Settings      spreadsheet ID + worksheet name from .env       (sheetsConfig.js)
  | 2. Sign-in       createSheetsAuth() + authenticate()              (sheetsAuth.js, reused)
  |                  -> Google confirms the service-account key works
  | 3. Metadata      spreadsheets.get(spreadsheetId, fields: title + worksheet titles)
  |                  -> "what is this spreadsheet called, and which tabs does it have?"
  | 4. Worksheet     is the configured tab (default "Contacts") in that list?
  v
  report + exit code (0 = all good, 1 = a problem)
```

If a step fails, the later steps are shown as `SKIPPED`, so you always see the **first** thing that is wrong.

### The authentication module is reused, not copied

The script calls the same two functions as the rest of the Google code:

- `createSheetsAuth({ env })` checks the key file (exists? valid JSON? looks like a service-account key?) and builds the Google client with the **one** Sheets scope.
- `authenticate(client)` asks Google for a token to prove the key is accepted.

All key-file rules, scope rules and "never leak" rules therefore live in one place ([docs/23](23-google-service-account-authentication.md)).

### The metadata request

The script sends exactly one request, in effect:

```
spreadsheets.get
  spreadsheetId:   <from GOOGLE_SHEETS_SPREADSHEET_ID>
  fields:          properties.title,sheets.properties.title
  includeGridData: false
```

- **Metadata** means *information about* the spreadsheet (its name, its tab names), not *what is written in* it.
- `fields` tells Google to send back **only** those two things. No cells, no formatting, no sharing details.
- `includeGridData: false` states explicitly that no cell data is wanted.

## What the report means

Successful run:

```
Google Sheets Connection Status
--------------------------------
Settings: SUCCESS
Service account authentication: SUCCESS
Spreadsheet access: SUCCESS
Spreadsheet: HubSpot CRM Database
Worksheets found: Contacts
Worksheet: Contacts
Worksheet exists: YES

Overall status: SUCCESS
```

| Line | Meaning |
|---|---|
| `Settings` | The spreadsheet ID and worksheet name were found and look usable. |
| `Service account authentication` | The key file is valid **and Google accepted it**. |
| `Spreadsheet access` | Google found the spreadsheet and the robot account is allowed to see it. |
| `Spreadsheet` | The title Google reports (so you can see it is the right file). |
| `Worksheets found` | The tab names in the spreadsheet. |
| `Worksheet` / `Worksheet exists` | The configured tab and whether it is really there (the name must match exactly, including capital letters). |
| `SKIPPED` | Not tried, because an earlier step failed. |
| `FAILED (CODE)` | This step failed; the code is explained below. |

A failed run ends with `Overall status: FAILED`, a `Problem:` line (code and fixed message) and a `How to fix:` line. If the problem is temporary, it says so.

The exit code is **0** for success and **1** for any failure, so other tools can use it.

## How to run it

From the project folder, with these set in your real `.env` (see `.env.example`):

```
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=<path to the key file>
GOOGLE_SHEETS_SPREADSHEET_ID=<the ID from the spreadsheet URL>
GOOGLE_SHEETS_CONTACTS_TAB=Contacts
```

```
npm run sheets:status
```

The spreadsheet ID is the long text between `/d/` and `/edit` in the sheet's address:
`https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.

It does contact Google (twice: one sign-in, one metadata request). It needs an internet connection.

## Common problems and fixes

| Code | What it means | What to do |
|---|---|---|
| `SPREADSHEET_ID_MISSING` | The ID is not set. | Add `GOOGLE_SHEETS_SPREADSHEET_ID` to `.env`. |
| `SPREADSHEET_ID_INVALID` | The value does not look like an ID (spaces, quotes, a whole URL). | Copy only the part between `/d/` and `/edit`. |
| `CONFIG_MISSING` | The key file path is not set. | Add `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` to `.env`. |
| `CREDENTIALS_FILE_NOT_FOUND` | Nothing exists at that path. | Check the path and spelling. |
| `CREDENTIALS_FILE_UNREADABLE` | The path is a folder, too large, or not readable. | Point it at the `.json` file itself; check permissions. |
| `CREDENTIALS_INVALID_JSON` / `CREDENTIALS_INVALID` | The file is damaged or is not a service-account key. | Download a fresh JSON key in Google Cloud Console. |
| `AUTH_FAILED` | Google rejected the key (deleted key, disabled account, wrong clock). | Create a new key; check your computer's date and time. |
| `SPREADSHEET_NOT_FOUND` | Google has no spreadsheet with that ID. | Compare the ID with the URL. |
| `PERMISSION_DENIED` | The robot is not allowed in, or the Sheets API is off. | Share the spreadsheet (Editor) with the service-account e-mail; enable the Google Sheets API in the Cloud project. |
| `WORKSHEET_NOT_FOUND` | The tab is not in the spreadsheet. | Fix `GOOGLE_SHEETS_CONTACTS_TAB` (exact spelling and capitals) or create the tab. |
| `RATE_LIMITED` | Google asks you to slow down (temporary). | Wait a minute and run it again. |
| `AUTH_UNAVAILABLE` / `API_UNAVAILABLE` | Network trouble or a Google outage (temporary). | Check your internet connection; try again later. |
| `INTERNAL_ERROR` | Something unexpected. | Run `npm test` to check the installation. |

## Why this check is read-only

- It asks for **metadata only**, with a field filter, and never for cell values.
- The script contains **no call that can change anything**: no write, no create, no delete, no formatting. A test reads the script's source and fails if such a call appears.
- The tests use a fake Google where every write or value-reading method **throws**, so an accidental write would break the test.
- It is safe to run at any time, as often as you like (Google does limit very frequent requests).

## Security

- Printed: the spreadsheet **title**, the **worksheet names** and fixed text. Names are cleaned first (control characters removed, length limited), because they are free text typed by people.
- **Never printed:** the spreadsheet ID, the key file path, the service-account e-mail, the private key, tokens, or Google's own error text (it can quote the e-mail or ID). Google failures are translated into a code using only the HTTP status and short system codes.
- `.env` is loaded only when the script is run directly. Importing it (as the tests do) never reads `.env`.

## Local development vs production (Render)

- **Locally:** run `npm run sheets:status` in the project folder; it uses your `.env`.
- **On Render:** the same variables are set in the Render dashboard, and the key file is a Secret File (see lesson 23). The check can be run from a Render shell with the same command. The full Render walkthrough comes in a later lesson.

## Tests

`npm test` runs `tests/sheets-status.test.js`. It uses a fake sign-in and a fake Sheets API; **no real key is read and Google is never contacted**. It covers:

- a successful run and its report;
- the exact spreadsheet ID and the field filter sent to the API (one request only);
- worksheet detection (found, missing, different capital letters, no worksheets at all);
- a missing or malformed spreadsheet ID;
- missing or broken credentials;
- sign-in rejected, spreadsheet not found (404), permission denied (403), network failures, rate limits (429), server errors (5xx) and unexpected replies;
- that no fake key, e-mail, ID, path or token ever appears in the output;
- two runs of the real script as a program, with both Google variables set to empty so that no network access is possible.

```
node --test tests/sheets-status.test.js
```

## What this still does not do

- It does not read or write any contact rows and does not check the column headers.
- It does not create the worksheet if it is missing.
- It does not retry automatically; "temporary" only means that running it again later may work.
- Nothing is connected to the webhook receiver. Webhook behavior is unchanged.
