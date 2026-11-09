# 10 - Multiple Events and Event Routing

> **Update:** `handleEvent` was replaced by `routeEvent` in `src/webhooks/router.js`, and `ticket.*` and `company.*` events are now recognized (so the `ticket.creation` and `company.creation` examples below are no longer "unrecognized"). Counting and the response shape are unchanged. See [16-webhook-event-routing.md](16-webhook-event-routing.md).

## What is it?
- **Multiple events**: in the classic format, one HTTP request can carry many events in an array.
- **Event routing**: looking at each event's `subscriptionType` and sending it to the right piece of code.

## Why is it important?
HubSpot may group several events into one request. If your code only looked at the first item, you'd silently lose the rest. Each event must be handled individually, and a single bad event must not stop the others.

## How it works
1. Receive the request and check the body is a **non-empty array**.
2. **Loop** over the array.
3. For each event, `handleEvent` checks it is an object with a `subscriptionType`, then uses `switch` to route it.
4. Count how many events were recognized and how many were not.
5. Reply with HTTP 200 and the counts.

```
Request body: [ e1, e2, e3 ]
                 |   |   |
                 v   v   v        (one at a time)
             handleEvent(event) --switch--> message for that type
```

### The three counts
| Field | Meaning |
|---|---|
| `received` | Total number of events in the array we received. |
| `recognized` | Events with a **supported** event type (one of the six in doc 09). |
| `unrecognized` | Events with an **unsupported or missing** event type (also items that are not JSON objects). |

`recognized + unrecognized` always equals `received`.

### Recognized does not mean completed
`recognized` only says "we know this event type and routed it". It does **not** say a business operation finished. In this project the handlers just print messages; we create, update and delete nothing. In a real app, a recognized event could still fail afterwards (a database error, a failed API call). Do not read `"recognized": 6` as "six records were successfully synced".

## How we implemented it
The route in [src/server.js](../src/server.js):

```js
app.post('/webhooks/simulate', (req, res) => {
  const events = req.body;

  if (!Array.isArray(events)) {
    return res.status(400).json({ status: 'error', message: 'Payload must be a JSON array of events.' });
  }
  if (events.length === 0) {
    return res.status(400).json({ status: 'error', message: 'Payload must contain at least one event.' });
  }

  let recognized = 0;   // supported event types
  let unrecognized = 0; // unsupported or missing event types

  events.forEach((event, index) => {
    console.log(`\nEvent ${index + 1} of ${events.length}`);
    if (handleEvent(event)) { recognized += 1; } else { unrecognized += 1; }
  });

  res.status(200).json({
    status: 'success',
    message: 'Events routed.',
    received: events.length,
    recognized,
    unrecognized,
  });
});
```

### Important pieces
- `Array.isArray(events)`: true only for real arrays (a plain object `{}` fails).
- `return res.status(400)...`: `return` stops the function so we don't also send a second response.
- `events.forEach((event, index) => {...})`: runs the function once per item; `index` starts at 0, so we print `index + 1`.
- `handleEvent(event)`: routes one event and returns `true` (recognized) or `false` (unrecognized). It never throws, so one bad item can't stop the loop.
- `recognized` / `unrecognized`: counters. Items that are not objects, lack `subscriptionType`, or have an unsupported type are `unrecognized`.
- Status **200** is returned even if some events are unrecognized. Real webhook senders retry when they get an error status, and retrying an unsupported event would never help.
- Route order: this route sits **before** the 404 handler. Express reads top to bottom, so a route placed after the 404 handler would never run.

## Responses

| Situation | Status | Body |
|---|---|---|
| All events supported | 200 | `received`, `recognized`, `unrecognized: 0` |
| Some unsupported/malformed events | 200 | `unrecognized` > 0 |
| Body is not an array (e.g. `{}`) | 400 | `"Payload must be a JSON array of events."` |
| Empty array `[]` | 400 | `"Payload must contain at least one event."` |
| Broken JSON | 400 | `"Invalid JSON payload."` (existing error handler, doc 05) |

## Testing with Postman
`POST http://localhost:3000/webhooks/simulate`, Body > raw > JSON.

**1. Six events, one per type:**
```json
[
  { "eventId": 1, "subscriptionId": 555001, "portalId": 12345678, "occurredAt": 1730000000000, "subscriptionType": "contact.creation", "objectId": 3001, "changeSource": "CRM" },
  { "eventId": 2, "subscriptionId": 555002, "portalId": 12345678, "occurredAt": 1730000001000, "subscriptionType": "contact.propertyChange", "objectId": 3001, "propertyName": "lifecyclestage", "propertyValue": "customer", "changeSource": "CRM" },
  { "eventId": 3, "subscriptionId": 555003, "portalId": 12345678, "occurredAt": 1730000002000, "subscriptionType": "contact.deletion", "objectId": 3002 },
  { "eventId": 4, "subscriptionId": 555004, "portalId": 12345678, "occurredAt": 1730000003000, "subscriptionType": "deal.creation", "objectId": 9001, "changeSource": "CRM" },
  { "eventId": 5, "subscriptionId": 555005, "portalId": 12345678, "occurredAt": 1730000004000, "subscriptionType": "deal.propertyChange", "objectId": 9001, "propertyName": "dealstage", "propertyValue": "closedwon", "changeSource": "CRM" },
  { "eventId": 6, "subscriptionId": 555006, "portalId": 12345678, "occurredAt": 1730000005000, "subscriptionType": "deal.deletion", "objectId": 9002 }
]
```
Expected: 200 and
```json
{ "status": "success", "message": "Events routed.", "received": 6, "recognized": 6, "unrecognized": 0 }
```
The terminal shows six blocks, each with its own message.

**2. Mixed supported and unsupported:**
```json
[
  { "eventId": 1, "subscriptionId": 555001, "portalId": 12345678, "occurredAt": 1730000000000, "subscriptionType": "contact.creation", "objectId": 3001, "changeSource": "CRM" },
  { "eventId": 8, "subscriptionId": 555008, "portalId": 12345678, "occurredAt": 1730000006000, "subscriptionType": "ticket.creation", "objectId": 5001 },
  { "eventId": 9, "portalId": 12345678, "occurredAt": 1730000007000, "objectId": 5002 }
]
```
Expected: 200 with `"received": 3, "recognized": 1, "unrecognized": 2`, and two warnings in the terminal (the unsupported type, and the missing `subscriptionType`).

**3. Single unsupported type:** a one-item array with `"subscriptionType": "company.creation"` gives `"received": 1, "recognized": 0, "unrecognized": 1`.

**4. Not an array:** body `{ "eventId": 1 }` gives 400.

**5. Empty array:** body `[]` gives 400.

**6. Regression check:** `GET /health` and `POST /webhooks/test` still work exactly as before.
