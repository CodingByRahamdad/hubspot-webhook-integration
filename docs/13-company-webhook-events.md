# 13 - Company Webhook Events

## What is it?

Company events report when a HubSpot company is created, a watched property changes, or it is deleted: `company.creation`, `company.propertyChange`, `company.deletion`.

## Why do we need it?

Company records drive account data (name, website, industry). Webhooks let other systems stay in sync without polling.

## How it works

Same flow as contacts: HubSpot POSTs an array, `routeEvent` splits `company.propertyChange` into object `company` + action `propertyChange`, and logs it. See [16](16-webhook-event-routing.md).

## Relevant code and configuration

- Subscriptions in `webhooks-hsmeta.json`: creation, deletion, and property changes for `name`, `domain`, `industry` ([11](11-hubspot-webhook-subscriptions.md)).
- Scope: `crm.objects.companies.read` (added to the app, `oauth.js` defaults and `.env.example`; you must update your own `.env`).
- Code: `src/webhooks/objectTypes.js` (`company: 'Company'`).
- Reference: [Webhooks v3 guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide).

## Example payloads (sample values)

```json
[{ "eventId": 11, "subscriptionId": 200, "portalId": 12345678, "occurredAt": 1730000010000,
   "subscriptionType": "company.creation", "objectId": 7001 }]
```

```json
[{ "eventId": 12, "subscriptionId": 201, "portalId": 12345678, "occurredAt": 1730000011000,
   "subscriptionType": "company.propertyChange", "objectId": 7001,
   "propertyName": "industry", "propertyValue": "COMPUTER_SOFTWARE" }]
```

```json
[{ "eventId": 13, "subscriptionId": 202, "portalId": 12345678, "occurredAt": 1730000012000,
   "subscriptionType": "company.deletion", "objectId": 7001 }]
```

Expected output (creation): `-> New company created (ID 7001).`

## How to configure it

Deploy the project and re-authorize the app so the new scope applies ([11](11-hubspot-webhook-subscriptions.md)).

## How to test

- **Simulated** (Postman): send the payloads above. Proves only our logic.
- **Real HubSpot**: create a test company, change its name/domain/industry, delete it.
- Status: **not yet verified with real HubSpot events.**

## Common errors and troubleshooting

- Nothing arrives: project not deployed, or the app was not re-authorized after the scope change.
- `industry` values are HubSpot internal option values (for example `COMPUTER_SOFTWARE`), not the display label.
- `company.merge` and association changes are not handled and are counted as unrecognized.
- Before this feature, `company.creation` was unrecognized. If your old notes say that, they are outdated.
