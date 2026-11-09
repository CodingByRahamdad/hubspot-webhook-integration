# 21. Error Handling and Retry Management

This lesson explains what the receiver does when something goes wrong, and how
that works together with HubSpot's own retries. Read
[docs/20](20-webhook-idempotency.md) first.

## The big idea

Our server does **not** retry anything by itself. **HubSpot** does the retrying.
Our job is to answer each delivery honestly:

- "Got it, all done" -> a `2xx` status. HubSpot stops.
- "Something went wrong, please try again" -> a `5xx` status. HubSpot sends the
  **whole batch** again later.

According to HubSpot's documentation, a delivery counts as failed (and is retried,
up to 10 times over 24 hours) when:

1. it cannot connect to your server,
2. your server takes **longer than 5 seconds** to answer, or
3. your server answers with a 4xx or 5xx status code.

Because the whole batch is re-sent, the duplicate protection from lesson 20 is what
makes retries safe: events already done are skipped.

## Status codes on `POST /webhooks/simulate`

| Code | Meaning | HubSpot retries? |
|---|---|---|
| 200 | Every event was processed, skipped as a duplicate, rejected for good, or invalid | No |
| 400 | Body is not a non-empty JSON array, or is invalid JSON | Yes (HubSpot never sends this; it signals a non-HubSpot caller) |
| 401 | Signature headers missing/wrong or timestamp invalid/expired | Yes (again, not something HubSpot normally causes) |
| 413 / 415 | Body too large / unsupported encoding (client problems) | Yes |
| 500 | At least one event's handler failed (a retryable failure), or an unexpected error | Yes |
| 503 | Database problem, **or** an event is still being processed by another request | Yes |

## Lesson learned: the "lost event" hole (and the fix)

Imagine a handler that takes 8 seconds (for example it calls another service):

1. Request 1 starts processing event X. The database row says `processing`.
2. After 5 seconds HubSpot gives up on request 1 and sends request 2 (a retry).
3. Request 2 finds X marked `processing`. **Old behaviour:** it answered `200`
   ("duplicate, skip"). HubSpot believed the retry succeeded and stopped.
4. Request 1 then fails. X becomes `failed`... but nobody will ever send X again.
   **The event is lost.**

**New behaviour:** request 2 answers **503** and reports `inProgress: 1`. HubSpot
tries again later. By then request 1 has either finished (the retry is a normal
duplicate, 200) or failed (the retry claims the event and processes it). No event is
lost. The tests `HTTP: an in-progress event gets 503...` and `...no lost event` prove
both paths.

## Retryable vs permanent failures

Not every failure deserves a retry.

| Kind | Example | How to signal it | What happens |
|---|---|---|---|
| **Retryable** (default) | a network call failed, a service was busy | `throw new Error(...)` | event stored as `failed`, response **500**, HubSpot retries |
| **Permanent** | the event data is unusable, retrying can never help | `throw new PermanentEventError(...)` (from `src/webhooks/errors.js`) | event stored as `rejected`, response **200** for it, HubSpot stops retrying |

When unsure, throw a normal `Error`. A wasted retry is better than a lost event. The
current handlers only log, so neither kind is thrown today. This is the framework for
future real handlers.

## Errors that are the client's fault

Problems caused by the request itself keep their proper 4xx status instead of
becoming a confusing 500: a body over the default 100 KB limit returns **413**, an
unsupported `Content-Encoding` returns **415**, bad JSON returns **400**. The log
shows only the status and type, never the request contents. Anything truly
unexpected returns 500 and logs only the error's class name.

## Seeing what failed

Run (from the project folder, server not required):

```
npm run events:failed
```

It is **read-only** and lists events that need attention:

- `failed`: processing threw; waiting for HubSpot to retry.
- `processing` whose claim expired: the server probably crashed mid-event.

Columns: event ID, type, status, attempts, error class name, first-seen time and
minutes since the last update. No payloads or secrets are shown. If nothing needs
attention it says so. An event that stays `failed` for more than about 24 hours has
probably used up all of HubSpot's retries: investigate it.

## Extra log details

- `New event 123 (HubSpot attemptNumber 2): processing` shows when HubSpot is retrying
  (first deliveries, `attemptNumber` 0, are not mentioned).
- `[WARNING] Batch took 3.4s; HubSpot times out after 5s.` appears when a batch takes
  over 3 seconds, as an early warning.
- Failure lines include a short error code when one exists, for example
  `processing failed (Error, ECONNRESET)`. Error messages are never logged because they
  can contain data.

## Shutdown and crashes

When started with `npm start`/`npm run dev`, Ctrl+C or a stop signal now closes the
HTTP server and the database cleanly. An uncaught exception or unhandled promise
rejection logs the error class name and exits with a failure code (a process manager
can restart it). The server never keeps running in an unknown state.

## Database upgrade

The table gained a status value, `rejected`. Existing database files are upgraded
automatically the first time the new code opens them: the table is rebuilt in one
transaction and **all rows are kept**. If you want a safety copy first, stop the
server and copy the `data/` folder.

## What this still does not do

- It does not retry on a timer by itself, and has no queue or background worker.
- There is no maximum-attempts cutoff. An event that always fails keeps returning
  500 until HubSpot gives up. (A "give up after N tries" setting is possible but
  deliberately not enabled, because it means choosing to drop an event.)
- Old rows are never deleted automatically.
- Processing is still at-least-once, not exactly-once (see lesson 20).
