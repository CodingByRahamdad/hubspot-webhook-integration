# 27 - Testing Google Sheets for Real: the CRUD Demonstration

This lesson explains `npm run sheets:crud-demo`, a script that proves the Contacts service from [docs/26](26-google-contacts-sheet-service.md) really works against Google Sheets: it creates, reads, updates and deletes **one test row** in a **separate test worksheet**.

Everything so far was tested with a pretend spreadsheet in memory. This script is the one place where real data is written. It has nothing to do with HubSpot: it calls no HubSpot API and changes nothing in HubSpot.

> **Do not run it until you have decided to.** It really writes to your spreadsheet and really deletes a row (the row it created itself). It is never run automatically, never by `npm test`, and the person who built it did not run it.

## What CRUD means

CRUD is a common name for the four things you do with stored records:

| Letter | Meaning | In the contacts service |
|---|---|---|
| **C**reate | add a new record | `appendContact` |
| **R**ead | look records up | `getAllContacts`, `findContactById`, `getHeaders` |
| **U**pdate | change a record | `updateContact` |
| **D**elete | remove a record | `deleteContact` |

## Why a separate test worksheet (a rehearsal stage)

Your real contacts live in the `Contacts` worksheet. Testing on it would be like rehearsing a play on opening night: a bug could damage real data. So the spreadsheet has a second worksheet, **`Contacts_Test`**, with the same six headers. The demonstration is only allowed to write there.

## What the script does

It uses the existing service methods (nothing is re-implemented) in this order:

| Step | Operation | What is checked |
|---|---|---|
| 1 | Read the worksheet headers | They are exactly `Contact ID`, `First Name`, `Last Name`, `Email`, `Company`, `Created Date` |
| 2 | Read the existing contacts | Takes a baseline (only the count is printed) and checks the test ID is not already used |
| 3 | **Create**: append one sample contact | The service reports the sample was added |
| 4 | **Read**: all contacts | The sample is there exactly once, with the right values |
| 5 | **Read**: find it by Contact ID | It is found with the right values |
| 6 | **Update**: change its Company | The service reports the new Company |
| 7 | **Read**: find it again | The sheet really shows the new Company, other fields unchanged |
| 8 | **Delete**: remove the sample row | The service reports it was removed |
| 9 | **Read**: find it again | It is gone |
| 10 | Compare with the baseline | The worksheet is back to exactly what it was before (so no other row changed) |

### The test record

The sample is easy to recognise:

- Contact ID like `TEST-DEMO-LZX3K9-1a2b3c4d` (the time plus 8 random hex characters), unique for every run, so it cannot collide with real data;
- name `Demo Test`, email `test-demo-...@example.invalid` (a reserved address that can never receive mail), company `Demo Company (test)`, which step 6 changes to `Demo Company UPDATED (test)`.

## The safety checks

Before anything is sent to Google, **all three** checks must pass. If any fails, the script prints why, says "Nothing was sent to Google", and stops with exit code **2**.

| Setting in `.env` | Must be | Why |
|---|---|---|
| `GOOGLE_SHEETS_SPREADSHEET_ID` | set to a valid ID | It must know which spreadsheet |
| `GOOGLE_SHEETS_CONTACTS_TAB` | **exactly** `Contacts_Test` | The real `Contacts` worksheet, any other name, and even look-alikes (`contacts_test`, `Contacts_Test ` with a space) are refused. A missing setting is refused too: the script never falls back to the usual default (`Contacts`). |
| `GOOGLE_SHEETS_ALLOW_TEST_WRITES` | **exactly** `true` | A second, deliberate "yes, I mean it". `TRUE`, `1`, `yes`, ` true` and empty are all refused. |

Two more protections:

- **It cannot be started by accident.** It only runs when you start it yourself. It is not part of `npm test`, and no test ever starts it with real settings.
- **It writes only to the worksheet that was checked.** The service the script uses is built from the very same settings it checked.

> The `.env` file is only read when you run the script yourself; the automated tests never read it.

## How to run it (only after you have decided to)

1. In your **real `.env`** make sure these are set (the key file path and spreadsheet ID are already there):

   ```
   GOOGLE_SHEETS_CONTACTS_TAB=Contacts_Test
   GOOGLE_SHEETS_ALLOW_TEST_WRITES=true
   ```

2. From the project folder run exactly:

   ```
   npm run sheets:crud-demo
   ```

3. **Afterwards, remove or change `GOOGLE_SHEETS_ALLOW_TEST_WRITES`** (for example delete the line). That way the demonstration cannot be run again by accident, and it is not left switched on. Switch `GOOGLE_SHEETS_CONTACTS_TAB` back to `Contacts` when you want the app to use the real list again.

Only run it after you have explicitly approved a real test.

## Reading the output

A successful run looks like this (IDs and counts will differ):

```
Google Sheets CRUD demonstration
--------------------------------
Worksheet: Contacts_Test
Test Contact ID for this run: TEST-DEMO-LZX3K9-1a2b3c4d

[1/10] Read the worksheet headers: OK (Contact ID | First Name | Last Name | Email | Company | Created Date)
[2/10] Read the existing contacts (baseline): OK (0 existing contact(s))
[3/10] Create: append the sample contact: OK (row 2)
[4/10] Read: all contacts include the sample: OK (1 contact(s), sample present once)
[5/10] Read: find the sample by its Contact ID: OK (row 2)
[6/10] Update: change the Company of the sample: OK
[7/10] Read: verify the updated Company: OK (Company changed, other fields unchanged)
[8/10] Delete: remove the sample row: OK (row 2)
[9/10] Read: verify the sample is gone: OK
[10/10] Verify: the worksheet is back to its original content: OK (0 contact(s), identical to the baseline)

Overall status: SUCCESS
```

| Line | Meaning |
|---|---|
| `[n/10] ...: OK` | That step worked **and** its result was checked. |
| `[n/10] ...: FAILED` | That step failed; the next line, `Stopped: ...`, gives a code and a fixed message. |
| `Overall status: SUCCESS` | All ten steps passed. Exit code **0**. |
| `Overall status: FAILED` | Something failed. Exit code **1**. |
| `Overall status: REFUSED` | A safety check did not pass; Google was not contacted. Exit code **2**. |

The output never contains credentials, tokens, the spreadsheet ID, or other people's contact details. Google errors appear as a code such as `PERMISSION_DENIED` with a fixed message (see [docs/24](24-google-sheets-connection-status.md) for what each code means and how to fix it).

## What happens if a step fails

The sample row might already exist when something goes wrong (for example a network error after step 3). So the script always finishes with a **cleanup**:

1. It looks up the sample by its exact generated Contact ID.
2. If it is found, it deletes **that row only** and checks it is gone.
3. If it is not found, there is nothing to remove.
4. If the cleanup itself fails (or the ID is somehow found twice, so it cannot be sure which row is meant), it deletes nothing, and prints:

   ```
   Cleanup FAILED (...).
   Please delete the row with Contact ID TEST-DEMO-... in the Contacts_Test worksheet by hand. Do not touch any other row.
   ```

   Do exactly that in the spreadsheet: find the row with that Contact ID in `Contacts_Test` and delete it.

The cleanup never touches any other row. If a failure happens before the sample was added (for example the headers are wrong), no cleanup is needed and none is attempted.

## Why this script is excluded from the automated tests

- `npm test` must be safe to run any time, offline, on any computer, with no credentials. A test that writes to a real spreadsheet would break all of that.
- Tests that run on a developer's machine or a build server could change real data by mistake or hit Google's rate limits.
- The automated tests (`tests/sheets-crud-demo.test.js`) instead check the script's logic against a **pretend spreadsheet in memory**: every refusal, the full successful sequence, each verification, and each cleanup case. Two of them run the script as a program, only with settings that make it refuse before contacting Google.

So the real run is a **manual, deliberate check** that the pretend spreadsheet and the real one behave the same.

## Limits

- It proves the operations work **once, now**. It does not test heavy use or many things happening at once.
- It needs an internet connection and the key file, like `npm run sheets:status`.
- It does not copy anything from HubSpot, and nothing in the webhook receiver calls it.
- If you run two copies at the same time they use different test IDs, but both write to the same worksheet. Run one at a time.
