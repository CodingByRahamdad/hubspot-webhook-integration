# 09 - HubSpot Event Types (Classic Format)

> **Update:** this lesson was written when only contacts and deals were handled. The receiver now also recognizes `company.*` and `ticket.*` events, and the routing moved from `handleEvent` in `server.js` to `src/webhooks/router.js` (`routeEvent`). So `company.creation` is **no longer** an unknown type, and the "Unknown type" test below should use `company.merge` instead. See [16-webhook-event-routing.md](16-webhook-event-routing.md) for the current code.

## What is it?
Each classic webhook event has a `subscriptionType` string saying what happened. The pattern is `object.action`:

| subscriptionType | Meaning |
|---|---|
| `contact.creation` | A contact was created. |
| `contact.propertyChange` | A property on a contact changed. |
| `contact.deletion` | A contact was deleted. |
| `deal.creation` | A deal was created. |
| `deal.propertyChange` | A property on a deal changed. |
| `deal.deletion` | A deal was deleted. |

> These are **simulated classic** events. HubSpot's newer format names events differently (see "`legacyCrmObjects` vs `crmObjects`" below), so don't assume these strings or properties carry over. If an event has no `subscriptionType`, our code treats it as unrecognized.

## Why is it important?
Different events need different actions. A new contact might be copied to another system, a deletion might remove a record, a property change might trigger an update. Your code must first know the type to choose the right action.

## How it works
Our code reads `event.subscriptionType` and compares it to the known values. If nothing matches, it falls to an "unknown" branch. It logs a warning and carries on instead of crashing. HubSpot may add new types later, so handling the unknown gracefully matters.

### Recognized does not mean completed
An event is **recognized** when its `subscriptionType` is one of the six values above, so our code knows where to route it. That is all it means.

In this project the handlers only print a message. Nothing is created, updated, synced or deleted anywhere. In a real application, a recognized event could still fail later (for example a database error or an API error while doing the real work). So "recognized" is not the same as "the business operation succeeded". Later lessons deal with doing real work reliably; none of that exists yet.

### Example events (sample data, abbreviated)
Common metadata (`eventId`, `subscriptionId`, `portalId`, `occurredAt`, `subscriptionType`, `objectId`) is on every event. `propertyName` and `propertyValue` are only on property-change events. `changeSource` is optional. See doc 07 for the full field list. Fields such as `appId` and `attemptNumber` are left out here to keep the examples short.

```json
{ "eventId": 1, "subscriptionId": 555001, "portalId": 12345678, "occurredAt": 1730000000000, "subscriptionType": "contact.creation", "objectId": 3001, "changeSource": "CRM" }
```
```json
{ "eventId": 2, "subscriptionId": 555002, "portalId": 12345678, "occurredAt": 1730000001000, "subscriptionType": "contact.propertyChange", "objectId": 3001, "propertyName": "lifecyclestage", "propertyValue": "customer", "changeSource": "CRM" }
```
```json
{ "eventId": 3, "subscriptionId": 555003, "portalId": 12345678, "occurredAt": 1730000002000, "subscriptionType": "contact.deletion", "objectId": 3002 }
```
```json
{ "eventId": 4, "subscriptionId": 555004, "portalId": 12345678, "occurredAt": 1730000003000, "subscriptionType": "deal.creation", "objectId": 9001, "changeSource": "CRM" }
```
```json
{ "eventId": 5, "subscriptionId": 555005, "portalId": 12345678, "occurredAt": 1730000004000, "subscriptionType": "deal.propertyChange", "objectId": 9001, "propertyName": "dealstage", "propertyValue": "closedwon", "changeSource": "CRM" }
```
```json
{ "eventId": 6, "subscriptionId": 555006, "portalId": 12345678, "occurredAt": 1730000005000, "subscriptionType": "deal.deletion", "objectId": 9002 }
```

## `legacyCrmObjects` vs `crmObjects`
When you configure webhooks in a HubSpot app on the newer developer platform, the subscriptions live in a webhook configuration file (`webhook-hsmeta.json`) under `config.subscriptions`. There are separate arrays for the two event styles.

Source: [HubSpot: Configure webhooks](https://developers.hubspot.com/docs/apps/developer-platform/add-features/configure-webhooks)

| | `legacyCrmObjects` | `crmObjects` |
|---|---|---|
| Event style | **Classic** types such as `contact.creation`, `contact.propertyChange`, `deal.deletion` | **New format**, event types in the `object.*` style, e.g. `object.creation` |
| How the object is chosen | Part of the type string (`contact.` / `deal.`) | A separate `objectType` field (e.g. `"contact"`) |
| Property changes | Entry carries a `propertyName` | (see HubSpot's docs for the exact entry shape) |
| Supported by our `/webhooks/simulate` | Yes | **No** |

Small examples of the configuration shape, as described by that page:

```json
{ "subscriptionType": "contact.propertyChange", "propertyName": "lastname", "active": true }
```
(a classic entry, for `legacyCrmObjects`)

```json
{ "subscriptionType": "object.creation", "objectType": "contact", "active": true }
```
(a new-format entry, for `crmObjects`)

Also, per that page, a separate `hubEvents` array holds some other classic types such as `contact.privacyDeletion` and `conversation.*`.

**Important limits of what this lesson knows:** that page explains how to *configure* subscriptions and says HubSpot sends a POST request with the event data to your target URL, which should answer with a `2xx` status code. It does not show the payload of the new format, so we do not guess its fields and our code does not handle `object.*` events. If one reached `/webhooks/simulate`, it would simply count as unrecognized.

## How we implemented it
In `handleEvent(event)` in [src/server.js](../src/server.js):

```js
switch (event.subscriptionType) {
  case 'contact.creation':
    console.log(`  -> New contact created (ID ${event.objectId}).`);
    return true;
  case 'contact.propertyChange':
    console.log(`  -> Contact ${event.objectId} property "${event.propertyName}" changed to "${event.propertyValue}".`);
    return true;
  // ... contact.deletion, deal.creation, deal.propertyChange, deal.deletion ...
  default:
    console.warn(`  -> Unknown event type "${event.subscriptionType}". Ignoring it.`);
    return false;
}
```
- `switch` compares one value against several `case` labels and runs the matching block.
- `return true` means "recognized"; `return false` means "unrecognized". The route uses this to count.
- The messages only *report* the event ("was deleted" describes what HubSpot told us). We did not delete anything.
- `console.warn` prints like `console.log` but marks the message as a warning.

## Testing with Postman
`POST http://localhost:3000/webhooks/simulate`, Body > raw > JSON.

**Unknown type:**
```json
[
  { "eventId": 7, "subscriptionId": 555007, "portalId": 12345678, "occurredAt": 1730000006000, "subscriptionType": "company.creation", "objectId": 7001 }
]
```
Expected: HTTP 200, `"received": 1, "recognized": 0, "unrecognized": 1`. The terminal prints `Unknown event type "company.creation". Ignoring it.`

**A new-format style type (not supported):**
```json
[
  { "eventId": 8, "subscriptionId": 555008, "portalId": 12345678, "occurredAt": 1730000007000, "subscriptionType": "object.creation", "objectId": 3003 }
]
```
Expected: `"recognized": 0, "unrecognized": 1`. This is only a routing demonstration; it is not a real new-format payload.

**Each known type:** send any single event from the examples above in an array, e.g. `[ { ...deal.propertyChange example... } ]`. The terminal prints a different message per type, and the response shows `"recognized": 1`.
