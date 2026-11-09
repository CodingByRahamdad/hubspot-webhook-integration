# 20. Webhook Idempotency (Duplicate Event Prevention)

## What does "idempotent" mean?

An operation is **idempotent** if doing it twice has the same result as doing it
once. Pressing an elevator's "up" button five times still calls one elevator.
For webhooks it means: if HubSpot tells us about the same event twice, we act on
it only once.

## Why does HubSpot send the same event twice?

HubSpot's own documentation says it "does not guarantee that you'll only get a
single notification for an event". The common reasons:

- **Retries.** If your server answers with a 4xx/5xx error, does not answer
  within **5 seconds**, or cannot be reached, HubSpot sends the batch again,
  up to 10 times over 24 hours. Every event in that batch is sent again, even
  the ones you already handled.
- **Occasional plain duplicates**, even without a failure.

Without protection, a retried `contact.creation` batch would be processed again.

## How do we recognise a duplicate?

Each event has an `eventId`. But HubSpot documents `eventId` as *"not guaranteed
to be unique"*, so we do not trust it alone. The identity of an event is:

| Field | Meaning |
|---|---|
| `portalId` | the HubSpot account |
| `eventId` | HubSpot's event number |
| `subscriptionType` | e.g. `deal.propertyChange` |
| `objectId` | the contact/company/deal/ticket |
| `propertyName` | which property changed (empty if none) |

A retry repeats all five values exactly, so it matches. Two genuinely different
events that happen to share an `eventId` would still differ in another field.
Events with no `eventId`, `portalId` or `subscriptionType` cannot be identified,
so they are skipped and counted as `invalid` (and not stored).

## Why a database file and not a variable in memory?

A JavaScript `Set` is wiped every time the server restarts (nodemon restarts it on
every save!) and is not shared if you run two server processes. HubSpot retries
over **24 hours**, so the memory of "already handled" must survive restarts.

We use **SQLite** through Node's built-in `node:sqlite` module (no extra package
to install; Node 22.5 or newer). Events are stored in the file
`data/webhook-events.db` (change it with `IDEMPOTENCY_DB_PATH`). The `data/` folder
is in `.gitignore`. PostgreSQL would be the better choice if you later run several
servers against one shared database; the storage code is isolated in
`src/idempotency/eventStore.js` so it can be swapped.

The table stores: the five identity fields, a `status`, an attempt counter,
timestamps (first received, last update, processed at) and the **name** of the
error class if processing failed. It never stores headers, signatures, secrets,
request bodies or error messages.

## How does the database stop duplicates?

The five identity fields are the table's **PRIMARY KEY**, so the database itself
refuses to hold the same event twice. The "claim" step is one SQL statement
(`INSERT ... ON CONFLICT ... DO UPDATE ... WHERE ...`):

- The event is new: the row is inserted with status `processing`. **You own it.**
- The row exists and is `processed`: nothing changes. **Duplicate, skip it.**
- The row exists and is `processing`: someone else is working on it. **Skip it.**
- The row exists and is `failed`, or its claim has expired: you take it over
  (a retry).

Because the check and the insert are a single atomic step inside the database,
two requests arriving at the same moment cannot both win. The test suite proves it
twice: 20 simultaneous HTTP requests with the same event process it once, and 8
separate operating-system processes racing on one database file produce exactly
one winner.

## What happens to each event (and the batch)?

```
claim  ->  process  ->  mark "processed"
  |           |
  | skip      +-- throws -> mark "failed"
```

- "processed" is written **only after** processing succeeded.
- Every event in a batch is handled on its own. A duplicate or a failure never
  prevents the other events from being processed.
- Log lines (no secrets, headers or bodies):
  - `New event 123456: processing`
  - `Retry of event 123456: processing`
  - `Duplicate event 123456: skipped`
  - `Event 123456: still being processed elsewhere, HubSpot should retry`
  - `Event 123456: processing failed (TypeError)`
  - `Event 123456: not processed (storage error: ...)`

## Responses and retries

HubSpot retries on error responses, so the status code is meaningful:

| Situation | HTTP status |
|---|---|
| All events processed, or skipped as duplicates / rejected / invalid | **200** |
| An event is still being processed by another request | **503** (HubSpot retries later, see docs/21) |
| At least one event's processing failed | **500** (the rest were still processed) |
| The database failed (event NOT processed, because processing without duplicate protection is not allowed) | **503** |

The 200 body keeps `status`, `message`, `received`, `recognized`, `unrecognized`
and adds `duplicates`, `inProgress`, `rejected`, `failed`, `invalid`. They add up to
`received`. (Error handling and retries are explained in more depth in
[docs/21](21-error-handling-and-retries.md).)

**Retry example.** A batch has events A and B. A is processed, B throws. We answer
500. HubSpot re-sends [A, B]. A is a duplicate (skipped), B's row is `failed`, so it
is claimed again and processed. If B succeeds we answer 200 and later deliveries of
B are duplicates.

**Crash example.** If the server dies while handling an event, its row stays
`processing`. Its claim expires after 60 seconds, after which HubSpot's next retry
can take it over.

## Honest limits: this is not "exactly once"

Networks make true exactly-once processing impossible for outside side effects.
What we provide is: HubSpot delivers **at least once**, and we skip events already
recorded as processed. A gap remains: if the server crashes *after* a handler did
its work but *before* the database row is marked `processed`, the retry will run
the handler again. Today the handlers only log, so this is harmless. When you later
add real actions (calling other APIs, writing records), make those actions
idempotent too (for example by using the event ID as a request key).

Also note: `/webhooks/local-test` is intentionally **not** protected, so you can
re-send sample payloads while experimenting. Only the real signed
`/webhooks/simulate` route remembers events. Old rows are never deleted
automatically; for a long-running server add a cleanup job later (for example
delete `processed` rows older than 30 days, since HubSpot stops retrying after 24
hours).

## How to test duplicates manually

1. Put a **test** value in your environment, never your real secret in a script:
   `HUBSPOT_CLIENT_SECRET` in `.env` is read by the server.
2. Start the server: `npm run dev`.
3. Save this as `dup-test.js` **outside the repo** (or run with `node`), then run
   `node dup-test.js` twice, or call `send()` twice:

```js
require('dotenv').config({ path: 'D:/Webhooks/hubspot-webhook-integration/.env' });
const crypto = require('crypto');
const body = JSON.stringify([{ eventId: 999001, subscriptionId: 1, portalId: 1,
  occurredAt: Date.now(), subscriptionType: 'contact.creation', objectId: 42 }]);

async function send() {
  const ts = String(Date.now());
  const uri = 'https://localhost:3000/webhooks/simulate';   // what the server rebuilds locally
  const sig = crypto.createHmac('sha256', process.env.HUBSPOT_CLIENT_SECRET)
    .update('POST' + uri + body + ts).digest('base64');
  const r = await fetch('http://localhost:3000/webhooks/simulate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
      'X-HubSpot-Signature-v3': sig, 'X-HubSpot-Request-Timestamp': ts },
    body,
  });
  console.log(r.status, await r.text());
}
send().then(send);   // first: recognized 1, second: duplicates 1
```

4. Watch the server terminal: first `New event 999001: processing`, then
   `Duplicate event 999001: skipped`.
5. Look inside the database (read-only):

```
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/webhook-events.db');console.table(d.prepare('SELECT portal_id,event_id,subscription_type,object_id,status,attempts FROM webhook_events').all())"
```

6. To start fresh, stop the server and delete the `data/` folder.

## Automated tests

`tests/idempotency.test.js` covers: new, duplicate (same request and later
request), different IDs, mixed batches, concurrency (HTTP and multi-process),
database errors, processing failures and retries, lease expiry, signature
validation still running first, all 12 CRM object/action combinations through the
signed route, and no secrets stored or logged. Run everything with `npm test`.
