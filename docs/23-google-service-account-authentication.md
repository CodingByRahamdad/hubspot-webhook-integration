# 23 - Google Service-Account Authentication (error handling and sign-in)

This lesson explains how the app proves its identity to **Google** so that, in later steps, it can read and write the `HubSpot CRM Database` spreadsheet. It covers only the sign-in and the error handling. The Sheets client, reading, writing and duplicate detection come in later lessons.

Google sign-in is **completely separate** from HubSpot OAuth ([docs/11](11-hubspot-oauth-flow.md), [docs/22](22-oauth-token-lifecycle.md)). It uses no HubSpot token, no HubSpot database and none of the webhook code.

## The big idea (employee badge)

- A **service account** is a robot employee that belongs to your Google Cloud project. It has its own email address, like `something@your-project.iam.gserviceaccount.com`.
- Sharing the spreadsheet with that email (Editor) is like telling the front desk: "this employee may edit this file".
- The **key file** (a `.json` file) is the robot's **badge**. Whoever holds it can act as the robot. So it stays **outside the project** and is never committed, printed or logged.
- Google gives the app a short-lived **access token** in exchange for proof that it holds the badge. The Google library does this automatically, and keeps and renews the token itself. We never see or store it.

HubSpot OAuth is different: a *person* clicks "Allow" in a browser. Here there is no person and no browser; the app signs in as the robot on its own.

## The pieces

| File | Job |
|---|---|
| `src/google/sheetsErrors.js` | `GoogleSheetsError`: one error class with a fixed message and a short safe code |
| `src/google/sheetsAuth.js` | Reads and checks the key file, builds the Google sign-in client limited to Sheets |
| `tests/sheets-errors.test.js` | Tests for the error class |
| `tests/sheets-auth.test.js` | Tests for the sign-in code, using fake keys and a fake Google client |

## The authentication flow

```
.env / Render setting                       Our code                              Google
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=<path>
        |                                      |
        |  1. createSheetsAuth()               |
        |------------------------------------->| a. is the variable set?             (CONFIG_MISSING)
                                               | b. does the file exist, is it a     (CREDENTIALS_FILE_NOT_FOUND /
                                               |    normal file, is it small?         CREDENTIALS_FILE_UNREADABLE)
                                               | c. is it valid JSON?                (CREDENTIALS_INVALID_JSON)
                                               | d. does it look like a service-     (CREDENTIALS_INVALID)
                                               |    account key (type, email, key)?
                                               | e. build the Google client with
                                               |    email + private key + ONE scope
                                               |    (no network request yet)
                                               |
                                               |  2. later: authenticate(), or the
                                               |     first Sheets API call
                                               |------------------------------------->|
                                               |   "I am <robot>, signed with my key" |
                                               |<-------------------------------------|
                                               |   short-lived access token           |
                                               |   (kept inside the Google library)   |
```

Good to know:
- Steps a-e happen **without contacting Google**. A wrong path or a damaged file is reported immediately and clearly.
- Google is contacted **only** when a token is needed. If Google says no, the error is `AUTH_FAILED` (the key is wrong, revoked or the account is disabled) or `AUTH_UNAVAILABLE` (network problem, Google 429 or 5xx; worth trying again later).
- `authenticate()` returns only `true`. The token is **not** returned to the caller.
- The shared instance (`getSheetsAuth()`) is created on **first use**, not when the server starts. A missing Google setup can never stop the server or the webhook receiver. `resetSheetsAuth()` exists for tests.

## The scope (least privilege)

The client asks for exactly one permission:

```
https://www.googleapis.com/auth/spreadsheets
```

It allows reading and writing spreadsheet cells. It does **not** allow browsing or deleting files in Google Drive. The spreadsheet itself is still only reachable because you shared it with the robot's email.

## Required environment variables

| Variable | Needed for | Notes |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` | signing in | The **path** to the key file, never its contents. **Required.** No default and no path in source code. |

`.env.example` shows the shape (commented, no real values). Two more Google variables, `GOOGLE_SHEETS_SPREADSHEET_ID` and `GOOGLE_SHEETS_CONTACTS_TAB`, are used by later lessons.

On this project's computer the key lives at:

```
D:\Google-Credentials\nifty-stage-514309-h3-a69e7fedc920.json
```

so the line in your **real `.env`** is:

```
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=D:\Google-Credentials\nifty-stage-514309-h3-a69e7fedc920.json
```

## What the code checks in the key file

A valid service-account key must have:

- `"type": "service_account"`
- a `client_email` that looks like an email address
- a `private_key` in PEM form (`-----BEGIN PRIVATE KEY-----` ... `-----END PRIVATE KEY-----`)

The file must also be an ordinary file (not a folder) and at most 64 KB (real keys are about 2.4 KB). The check only answers "looks right or not". It never says *which* value was wrong, so nothing from the file can end up in an error message.

## Errors

Every failure is a `GoogleSheetsError` with a **fixed message**, a short **code** and a `retryable` flag. Callers decide from the code, never from the text.

| Code | Meaning | Retry later? |
|---|---|---|
| `CONFIG_MISSING` | `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` is not set | no |
| `CREDENTIALS_FILE_NOT_FOUND` | nothing exists at that path | no |
| `CREDENTIALS_FILE_UNREADABLE` | it is a folder, too large, or cannot be read (permissions) | no |
| `CREDENTIALS_INVALID_JSON` | the file is not valid JSON | no |
| `CREDENTIALS_INVALID` | valid JSON, but not a service-account key | no |
| `AUTH_FAILED` | Google rejected the sign-in | no |
| `AUTH_UNAVAILABLE` | network problem, Google 429 or 5xx | **yes** |
| `INVALID_INPUT` | the function was called with the wrong kind of value | no |
| `INTERNAL_ERROR` | anything unexpected | no |

The optional `reason` field holds a short system code such as `ENOENT` or `ECONNRESET`, and only if it looks like one. API-level errors (spreadsheet not shared, wrong ID, rate limits) are added in later lessons.

## Security

- **Never logged.** These two files contain no `console` calls. Errors contain no path, email, key or token. The tests prove it with a fake key.
- **The Google library's own error text is discarded**, because it can quote the account email or key.
- **The key stays outside the project** (`D:\Google-Credentials\`) and `.gitignore` has extra patterns (`google-*.json`, `*service-account*.json`, `nifty-stage-*.json`, `credentials/`) as a safety net. Do not copy the file into the project, e-mail it or paste it into a chat.
- **No hardcoded path or key.** The path comes only from the environment variable.
- **Why `JWT` and not `GoogleAuth({ credentials })`?** The Google library marks the `credentials` and `keyFilename` options as deprecated and prints a warning. We check the file ourselves and give the library only the email, the private key and the scope.
- If the key may have leaked, delete it in Google Cloud Console (IAM, Service Accounts, Keys) and create a new one.

## Local development vs production (Render)

- **Local:** the key file sits in `D:\Google-Credentials\` and `.env` holds its path.
- **Render:** the file is not on the server. Upload the JSON as a **Secret File** in the Render dashboard (Environment, Secret Files). Render mounts it under `/etc/secrets/`. Then set `GOOGLE_SERVICE_ACCOUNT_KEY_FILE` to that path, for example `/etc/secrets/nifty-stage-514309-h3-a69e7fedc920.json`. The code is identical in both places; only the variable's value differs. The full Render walkthrough comes in a later lesson.
- This repository has no Render configuration file, so these settings live only in the Render dashboard.

## Tests

`npm test` runs every file in `tests/`. The two new ones need **no real credentials and make no request to Google**:

- They write key files into a temporary folder, using a throw-away RSA key created inside the test, and delete them afterwards.
- A fake stand-in replaces Google's client in almost every test. One test builds the real class to prove it accepts a valid key, makes no request and prints no warning.
- Covered: missing variable, blank variable, missing file, folder instead of file, oversize file, unreadable file, invalid JSON, empty file, wrong structure (11 variations), successful setup (exact scope, no deprecated options), Google rejecting the key, network and 5xx errors, non-Error failures, lazy start, nothing logged, no key material or path in any error, and no hardcoded path or HubSpot imports in the source.

```
node --test tests/sheets-errors.test.js tests/sheets-auth.test.js
```

## What this still does not do

- It does not talk to the Sheets API yet: no reading, writing or updating rows.
- It does not know the spreadsheet ID or the tab name.
- It has no retry loop; `retryable` only tells a caller that trying again later could help.
- Nothing is connected to the webhook receiver. Webhook behavior is unchanged.
- Key rotation is manual (create a new key, replace the file, restart).

## Official Google documentation

- Service accounts overview: <https://cloud.google.com/iam/docs/service-account-overview>
- Authenticating as a service account: <https://cloud.google.com/docs/authentication/application-default-credentials>
- Sheets API scopes: <https://developers.google.com/workspace/sheets/api/scopes>
- Render Secret Files: <https://render.com/docs/configure-environment-variables#secret-files>
