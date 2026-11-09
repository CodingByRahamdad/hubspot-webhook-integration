# 15 - Ticket Webhook Events

## What is it?

Ticket events report when a support ticket is created, a watched property changes, or it is deleted: `ticket.creation`, `ticket.propertyChange`, `ticket.deletion`.

## Why do we need it?

Support tooling can react at once to new tickets or status changes instead of polling.

## How it works

HubSpot POSTs an array. `routeEvent` splits `ticket.creation` into object `ticket` + action `creation` and logs it ([16](16-webhook-event-routing.md)).

## Relevant code and configuration

- Subscriptions: creation, deletion, and property changes for `subject`, `hs_pipeline`, `hs_pipeline_stage` ([11](11-hubspot-webhook-subscriptions.md)).
- Scope: **`crm.objects.tickets.read`**, as set in `app-hsmeta.json`, `src/oauth.js` and `.env.example`. Note: [HubSpot's Webhooks v3 guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide) lists `tickets` as the ticket webhook scope. Whether HubSpot accepts `crm.objects.tickets.read` for ticket webhooks is **not verified** until the project is uploaded and a real ticket event arrives.
- Code: `src/webhooks/objectTypes.js` (`ticket: 'Ticket'`).
- Reference: [Webhooks v3 guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide).

## Example payloads (sample values)

```json
[{ "eventId": 31, "subscriptionId": 400, "portalId": 12345678, "occurredAt": 1730000030000,
   "subscriptionType": "ticket.creation", "objectId": 5001 }]
```

```json
[{ "eventId": 32, "subscriptionId": 401, "portalId": 12345678, "occurredAt": 1730000031000,
   "subscriptionType": "ticket.propertyChange", "objectId": 5001,
   "propertyName": "hs_pipeline_stage", "propertyValue": "2" }]
```

```json
[{ "eventId": 33, "subscriptionId": 402, "portalId": 12345678, "occurredAt": 1730000032000,
   "subscriptionType": "ticket.deletion", "objectId": 5001 }]
```

Expected output (deletion): `-> Ticket 5001 was deleted.`

## How to configure it

Deploy the project and re-authorize the app so the `crm.objects.tickets.read` scope is granted ([11](11-hubspot-webhook-subscriptions.md)).

## How to test

- **Simulated** (Postman): send the payloads above. Proves only our logic.
- **Real HubSpot**: create a ticket, rename it, move it to another stage, delete it.
- Status: **not yet verified with real HubSpot events.**

## Common errors and troubleshooting

- `hs_pipeline_stage` and `hs_pipeline` hold internal IDs (often numbers such as `"1"`, `"2"`), not stage names.
- No ticket events: the `crm.objects.tickets.read` scope is missing from the installed app. Re-authorize. If it is present and events still do not arrive, the scope name may be the problem (see the note above about `tickets`).
- `ticket.merge` and association changes are counted as unrecognized.
