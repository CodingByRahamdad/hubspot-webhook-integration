# 16 - Webhook Event Routing

## What is it?

Routing decides what happens to each event in a batch, based on its `subscriptionType` (for example `deal.propertyChange`).

## Why do we need it?

Four objects times three actions is twelve event types. One `switch` with twelve copy-pasted cases would be hard to maintain. Now an object is one line in a table and each action has one handler.

## How it works

```
POST /webhooks/simulate  (JSON array)
   |
   v  server.js: must be a non-empty array, else HTTP 400
for each item:
   routeEvent(item)               src/webhooks/router.js
      -> normalizeEvent(item)     src/webhooks/normalizeEvent.js
            not an object / no subscriptionType  -> warning, unrecognized
            "company.propertyChange" -> objectType "company", action "propertyChange"
            unsupported object or action         -> "Unknown event type", unrecognized
      -> ACTION_HANDLERS[action](label, event)   -> logs a message, recognized
   |
   v
HTTP 200 { status, message:'Events routed.', received, recognized, unrecognized }
```

"Recognized" means we know the type and logged it. No handler creates, updates or deletes anything.

## Relevant code

| File | Role |
|---|---|
| `src/webhooks/objectTypes.js` | `OBJECT_TYPES` (contact, company, deal, ticket) and `ACTIONS` (creation, propertyChange, deletion) |
| `src/webhooks/normalizeEvent.js` | Validates one item and extracts `eventId`, `subscriptionId`, `portalId`, `subscriptionType`, `occurredAt`, `objectId`, plus `propertyName`/`propertyValue` when present. Never throws |
| `src/webhooks/router.js` | `routeEvent()`: logs the common fields and calls the action handler. Returns true/false |
| `src/server.js` | The HTTP route, batch validation, counters and response (unchanged shape) |

Behavior that did not change: a non-array or empty body gives 400; malformed JSON gives 400 `Invalid JSON payload.`; any well-formed batch gives 200; only `content-type` and `user-agent` headers are logged; no tokens or secrets are logged.

New: `Occurred at` and `Property value` lines are printed, and `company.*` and `ticket.*` are recognized.

## Example

Request:

```json
[
  { "eventId": 1, "subscriptionId": 100, "portalId": 12345678, "occurredAt": 1730000000000, "subscriptionType": "contact.creation", "objectId": 1001 },
  { "eventId": 2, "subscriptionId": 301, "portalId": 12345678, "occurredAt": 1730000001000, "subscriptionType": "deal.propertyChange", "objectId": 9001, "propertyName": "amount", "propertyValue": "5000" },
  { "eventId": 3, "subscriptionId": 999, "portalId": 12345678, "occurredAt": 1730000002000, "subscriptionType": "company.merge", "objectId": 7001 }
]
```

Response: `{"status":"success","message":"Events routed.","received":3,"recognized":2,"unrecognized":1}`

## How to configure it: add a new object

1. Add a line to `OBJECT_TYPES` in `objectTypes.js`.
2. Add the matching subscriptions and scope ([11](11-hubspot-webhook-subscriptions.md)).
3. Add a test case.

Only the classic format is supported. The generic `object.*` format has a different payload and would need its own normalizer.

## How to test

`npm test` runs `tests/webhook-events.test.js` (simulated only). Postman cases are in [17](17-webhook-testing-guide.md).

## Common errors and troubleshooting

- `Unknown event type` for a type you expect: check spelling and case (`propertyChange`, not `propertychange`).
- Real HubSpot events also hit this route. HubSpot retries on 4xx/5xx and expects a reply within 5 seconds ([guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide)), so keep handlers fast and non-throwing.
- Batches are unordered and may contain duplicates. We do not deduplicate; if you add real processing, sequence by `occurredAt` and be idempotent.
- **Known gap:** the receiver does not verify the `X-HubSpot-Signature` header ([validating requests](https://developers.hubspot.com/docs/apps/legacy-apps/authentication/validating-requests.md)). Anyone who knows the URL can post to it.
