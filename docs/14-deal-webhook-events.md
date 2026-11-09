# 14 - Deal Webhook Events

## What is it?

Deal events report when a deal is created, a watched property changes, or it is deleted: `deal.creation`, `deal.propertyChange`, `deal.deletion`.

## Why do we need it?

Deals carry sales pipeline state. Reacting to a stage or amount change (notify a team, update a forecast) is a classic webhook use.

## How it works

HubSpot POSTs an array. `routeEvent` splits `deal.propertyChange` into object `deal` + action `propertyChange` and logs it ([16](16-webhook-event-routing.md)). `deal.*` was already recognized before this expansion, and its behavior is unchanged.

## Relevant code and configuration

- Subscriptions: creation, deletion, and property changes for `dealname`, `dealstage`, `amount`, `pipeline` ([11](11-hubspot-webhook-subscriptions.md)).
- Scope: `crm.objects.deals.read`.
- Code: `src/webhooks/objectTypes.js` (`deal: 'Deal'`).
- Reference: [Webhooks v3 guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide).

## Example payloads (sample values)

```json
[{ "eventId": 21, "subscriptionId": 300, "portalId": 12345678, "occurredAt": 1730000020000,
   "subscriptionType": "deal.creation", "objectId": 9001 }]
```

```json
[{ "eventId": 22, "subscriptionId": 301, "portalId": 12345678, "occurredAt": 1730000021000,
   "subscriptionType": "deal.propertyChange", "objectId": 9001,
   "propertyName": "dealstage", "propertyValue": "closedwon" }]
```

```json
[{ "eventId": 23, "subscriptionId": 302, "portalId": 12345678, "occurredAt": 1730000022000,
   "subscriptionType": "deal.deletion", "objectId": 9001 }]
```

Expected output (property change): `-> Deal 9001 property "dealstage" changed to "closedwon".`

## How to configure it

Deploy the project and re-authorize the app ([11](11-hubspot-webhook-subscriptions.md)).

## How to test

- **Simulated** (Postman): send the payloads above. Proves only our logic.
- **Real HubSpot**: create a deal, move its stage, change amount/name/pipeline, delete it.
- Status: **not yet verified with real HubSpot events.**

## Common errors and troubleshooting

- `dealstage` and `pipeline` values are internal IDs (for example `closedwon`, or a numeric ID in custom pipelines), not display names.
- Moving a deal to another pipeline can fire several property changes (`pipeline` and `dealstage`). Batches are not ordered, so use `occurredAt` to sequence them.
- `deal.merge` and association changes are counted as unrecognized.
