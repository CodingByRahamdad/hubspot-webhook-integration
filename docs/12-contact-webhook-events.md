# 12 - Contact Webhook Events

## What is it?

Contact events tell your server when a HubSpot contact is created, one of its watched properties changes, or it is deleted. Subscription types: `contact.creation`, `contact.propertyChange`, `contact.deletion`.

## Why do we need it?

It lets other systems react immediately (sync a new lead, notice a lifecycle change) without polling the API.

## How it works

1. Someone creates, edits or deletes a contact in HubSpot.
2. HubSpot POSTs a JSON **array** to `/webhooks/simulate`.
3. `routeEvent` (see [16](16-webhook-event-routing.md)) splits `contact.creation` into object `contact` + action `creation` and logs a message.

## Relevant code and configuration

- Subscriptions: `webhooks-hsmeta.json` (see [11](11-hubspot-webhook-subscriptions.md)). Watched properties: `firstname`, `lastname`, `email`, `lifecyclestage`.
- Scope: `crm.objects.contacts.read`.
- Code: `src/webhooks/objectTypes.js` (`contact: 'Contact'`), `normalizeEvent.js`, `router.js`.
- HubSpot reference: [Webhooks v3 guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide).

## Example payloads

Creation (the same shape as a real HubSpot delivery; IDs here are sample values):

```json
[{ "eventId": 1, "subscriptionId": 100, "portalId": 12345678, "occurredAt": 1730000000000,
   "subscriptionType": "contact.creation", "objectId": 1001 }]
```

Property change (`propertyName` and `propertyValue` are present):

```json
[{ "eventId": 2, "subscriptionId": 101, "portalId": 12345678, "occurredAt": 1730000001000,
   "subscriptionType": "contact.propertyChange", "objectId": 1001,
   "propertyName": "lifecyclestage", "propertyValue": "customer" }]
```

Deletion:

```json
[{ "eventId": 3, "subscriptionId": 102, "portalId": 12345678, "occurredAt": 1730000002000,
   "subscriptionType": "contact.deletion", "objectId": 1001 }]
```

Expected server output (property change): `-> Contact 1001 property "lifecyclestage" changed to "customer".`
Expected response: `{"status":"success","message":"Events routed.","received":1,"recognized":1,"unrecognized":0}`

## How to configure it

Nothing extra beyond [11](11-hubspot-webhook-subscriptions.md). To watch another property, add one `contact.propertyChange` entry with that `propertyName`.

## How to test

- **Simulated** (Postman): send the payloads above to `POST http://localhost:3000/webhooks/simulate`. This only proves our receiver's logic.
- **Real HubSpot**: create, edit (for example change the email) and delete a test contact.
- Status: `contact.creation` is **confirmed with a real HubSpot event**. `contact.propertyChange` and `contact.deletion` are **not yet verified with real events**.

## Common errors and troubleshooting

- `property changed to "undefined"`: the event had no `propertyValue` (a hand-built payload), not a HubSpot problem.
- Deleting a contact via privacy deletion also sends a deletion event when `contact.privacyDeletion` is subscribed. That subscription is inactive here.
- Merging contacts sends `contact.merge`, which is not handled and is counted as unrecognized.
- No event for an edit: the changed property is not one of the four watched ones.
