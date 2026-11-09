# 07 - Understanding Webhook Payloads

## What is it?
A **payload** is the data inside a webhook request: the body, written in JSON. It describes what happened ("a contact was created", "a deal's stage changed").

JSON has two building blocks:
- **Object**: `{ "name": "value" }`, a set of named properties.
- **Array**: `[ ..., ... ]`, an ordered list.

## Why is it important?
Your code can only react to an event if it understands the payload. If you don't know which property holds the event type or the record ID, you can't do anything useful with the webhook.

## How it works
In the **classic HubSpot webhook format**, one HTTP request contains an **array of event objects**:

```json
[
  { "...event 1..." },
  { "...event 2..." }
]
```

> **Important:** this lesson only simulates the *classic* format. HubSpot's newer webhook format (`object.*` event types) uses different event names, and you should not assume it shares the same payload properties. Never assume two formats are identical; check HubSpot's current documentation for the format you actually use. See doc 09 for how the two formats are configured.
>
> Source for the configuration side: [HubSpot: Configure webhooks](https://developers.hubspot.com/docs/apps/developer-platform/add-features/configure-webhooks). Note that this page explains how to *configure* subscriptions. It does not list every payload field. The field descriptions below are sample data for learning, so confirm exact fields against HubSpot's payload documentation before relying on them in production.

### Common event metadata vs property-change fields

Some fields describe *any* event. Others only make sense when a property changed.

**Common event metadata** (we expect these on every classic event):

| Property | Meaning |
|---|---|
| `eventId` | Unique ID of this event. |
| `subscriptionId` | ID of the webhook subscription that produced it. |
| `portalId` | The HubSpot account (portal) the event came from. |
| `appId` | The HubSpot app that owns the subscription. |
| `occurredAt` | When it happened, as a Unix timestamp in milliseconds. |
| `subscriptionType` | **What kind of event it is.** We route on this. |
| `attemptNumber` | 0 for the first delivery; higher if HubSpot is retrying. |
| `objectId` | ID of the CRM record (contact, deal, ...) involved. |

**Specific to property-change events** (`contact.propertyChange`, `deal.propertyChange`):

| Property | Meaning |
|---|---|
| `propertyName` | Which property changed. |
| `propertyValue` | The new value of that property. |

**Optional extra:** `changeSource` says what caused the change (for example `CRM` or `API`). We treat it as optional: our code never requires it, and the deletion example below leaves it out.

### Example: a property-change event
```json
{
  "eventId": 100001,
  "subscriptionId": 555001,
  "portalId": 12345678,
  "appId": 987654,
  "occurredAt": 1730000000000,
  "subscriptionType": "contact.propertyChange",
  "attemptNumber": 0,
  "objectId": 3001,
  "propertyName": "lifecyclestage",
  "propertyValue": "customer",
  "changeSource": "CRM"
}
```

### Example: a creation event (no property fields)
```json
{
  "eventId": 100002,
  "subscriptionId": 555002,
  "portalId": 12345678,
  "appId": 987654,
  "occurredAt": 1730000005000,
  "subscriptionType": "contact.creation",
  "attemptNumber": 0,
  "objectId": 3002,
  "changeSource": "CRM"
}
```
A creation event has no `propertyName` or `propertyValue`, so our code checks before printing them.

All data in this lesson is made-up sample data.

## How we implemented it
In [src/server.js](../src/server.js), `express.json()` (from Lesson 2) parses the body. In the new route, `req.body` is our array:

```js
app.post('/webhooks/simulate', (req, res) => {
  const events = req.body;
  ...
```

`logCommonDetails(event)` prints the shared properties:
```js
function logCommonDetails(event) {
  console.log(`  Event ID:        ${event.eventId}`);
  console.log(`  Subscription ID: ${event.subscriptionId}`);
  console.log(`  Portal ID:       ${event.portalId}`);
  console.log(`  Event type:      ${event.subscriptionType}`);
  console.log(`  CRM object ID:   ${event.objectId}`);
  if (event.propertyName !== undefined) {
    console.log(`  Property name:   ${event.propertyName}`);
  }
}
```
- Template strings (`` `...${value}` ``) insert values into text.
- `event.propertyName !== undefined` means "only print it if it exists".
- The code only *uses* some of the fields. `occurredAt`, `appId`, `attemptNumber` and `changeSource` are accepted in the payload but not printed.

## Testing with Postman
1. Start the server: `npm run dev`.
2. New request: `POST http://localhost:3000/webhooks/simulate`.
3. Body > raw > JSON, then paste:
```json
[
  {
    "eventId": 100001,
    "subscriptionId": 555001,
    "portalId": 12345678,
    "appId": 987654,
    "occurredAt": 1730000000000,
    "subscriptionType": "contact.propertyChange",
    "attemptNumber": 0,
    "objectId": 3001,
    "propertyName": "lifecyclestage",
    "propertyValue": "customer",
    "changeSource": "CRM"
  }
]
```
4. Expected response (HTTP 200):
```json
{ "status": "success", "message": "Events routed.", "received": 1, "recognized": 1, "unrecognized": 0 }
```
5. Expected terminal output includes the event ID, subscription ID, portal ID, event type, object ID and property name.
6. Try the creation example above too. The terminal shows no "Property name" line.
