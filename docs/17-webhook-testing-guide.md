# 17 - Webhook Testing Guide

## Two kinds of tests (do not confuse them)

| Kind | Sender | What a pass proves |
|---|---|---|
| **Simulated** | You, via Postman/curl or `npm test` | Our receiver parses, routes and responds correctly |
| **Real** | HubSpot, after the project is deployed | HubSpot's subscriptions, scopes, ngrok and our receiver all work end to end |

Passing simulated tests does **not** mean HubSpot delivers those events. Current status: only `contact.creation` has been seen from real HubSpot. All other events are **simulated-only so far**.

## Setup

1. `npm start` in `hubspot-webhook-integration` (port 3000, or `PORT` from `.env`).
2. Postman: `POST http://localhost:3000/webhooks/local-test` (unsigned local route; `/webhooks/simulate` now requires a HubSpot signature, see docs/19), header `Content-Type: application/json`, body = raw JSON.
3. Watch the terminal for the output described below.

## A. Simulated Postman tests

Common fields used below: `"eventId":N,"subscriptionId":N,"portalId":12345678,"occurredAt":1730000000000`. Write them out in full in Postman; each body is a JSON **array**.

| # | Test | Body (`subscriptionType` + extra) | Expected HTTP / response | Expected terminal line |
|---|---|---|---|---|
| 1 | Contact creation | `contact.creation`, `objectId:1001` | 200, received 1, recognized 1, unrecognized 0 | `New contact created (ID 1001).` |
| 2 | Contact update | `contact.propertyChange`, `objectId:1001`, `propertyName:"email"`, `propertyValue:"a@b.com"` | 200, recognized 1 | `Contact 1001 property "email" changed to "a@b.com".` |
| 3 | Contact deletion | `contact.deletion`, `objectId:1001` | 200, recognized 1 | `Contact 1001 was deleted.` |
| 4 | Company creation | `company.creation`, `objectId:7001` | 200, recognized 1 | `New company created (ID 7001).` |
| 5 | Company update | `company.propertyChange`, `propertyName:"domain"`, `propertyValue:"acme.com"` | 200, recognized 1 | `Company 7001 property "domain" changed to "acme.com".` |
| 6 | Company deletion | `company.deletion`, `objectId:7001` | 200, recognized 1 | `Company 7001 was deleted.` |
| 7 | Deal creation | `deal.creation`, `objectId:9001` | 200, recognized 1 | `New deal created (ID 9001).` |
| 8 | Deal update | `deal.propertyChange`, `propertyName:"dealstage"`, `propertyValue:"closedwon"` | 200, recognized 1 | `Deal 9001 property "dealstage" changed to "closedwon".` |
| 9 | Deal deletion | `deal.deletion`, `objectId:9001` | 200, recognized 1 | `Deal 9001 was deleted.` |
| 10 | Ticket creation | `ticket.creation`, `objectId:5001` | 200, recognized 1 | `New ticket created (ID 5001).` |
| 11 | Ticket update | `ticket.propertyChange`, `propertyName:"subject"`, `propertyValue:"Help"` | 200, recognized 1 | `Ticket 5001 property "subject" changed to "Help".` |
| 12 | Ticket deletion | `ticket.deletion`, `objectId:5001` | 200, recognized 1 | `Ticket 5001 was deleted.` |
| 13 | Batch | Array of tests 1, 4, 7, 10 | 200, received 4, recognized 4, unrecognized 0 | One block per event ("Event 1 of 4"...) |
| 14 | Unknown type | `company.merge` and `product.creation` in one array | 200, received 2, recognized 0, unrecognized 2 | `Unknown event type "company.merge". Ignoring it.` |
| 15 | Mixed batch | Test 1 + `{"foo":"bar"}` + `"text"` | 200, received 3, recognized 1, unrecognized 2 | Two `[WARNING] Skipping ...` lines |

### Invalid payloads

| # | Body | Expected |
|---|---|---|
| 16 | `{"subscriptionType":"contact.creation"}` (object, not array) | 400 `Payload must be a JSON array of events.` |
| 17 | `[]` | 400 `Payload must contain at least one event.` |
| 18 | `"hello"`, `123` or `null` (top-level, not an array or object) | 400, rejected by Express's strict JSON parser (expected to be `Invalid JSON payload.`; confirm by running it) |

### Malformed JSON

| # | Body | Expected |
|---|---|---|
| 19 | `[{"subscriptionType": "contact.creation"` (missing closing brackets) | 400 `Invalid JSON payload.` |

Example for test 8 (full body):

```json
[{ "eventId": 22, "subscriptionId": 301, "portalId": 12345678, "occurredAt": 1730000021000,
   "subscriptionType": "deal.propertyChange", "objectId": 9001,
   "propertyName": "dealstage", "propertyValue": "closedwon" }]
```

### Automated version

`npm test` covers all four objects, a mixed batch, the unknown types, empty/non-array bodies and malformed JSON. It is still **simulated**.

## B. Real HubSpot tests (after upload, deploy and re-authorize)

Prerequisites: project uploaded and deployed ([11](11-hubspot-webhook-subscriptions.md)), app re-authorized with the new scopes, ngrok running, server running.

For each object (contact, company, deal, ticket): create a test record, edit each watched property, delete the record. Check (1) the ngrok inspector at `http://127.0.0.1:4040` shows a POST, and (2) the server terminal shows the event. Real payloads also include fields like `appId`, `attemptNumber` and `changeSource`, which we ignore.

Record results here (fill in yourself):

| Object | creation | propertyChange | deletion |
|---|---|---|---|
| Contact | verified | not yet verified | not yet verified |
| Company | not yet verified | not yet verified | not yet verified |
| Deal | not yet verified | not yet verified | not yet verified |
| Ticket | not yet verified | not yet verified | not yet verified |

## Common errors and troubleshooting

| Symptom | Cause / fix |
|---|---|
| Postman: connection refused | Server not running, or wrong port |
| Postman gets 400 on a good-looking body | Body is an object, not an array. Wrap it in `[ ]` |
| Postman `Invalid JSON payload.` | Trailing commas or smart quotes. Postman body must be type raw/JSON |
| Real events never arrive | Not deployed, subscription inactive, scope missing, ngrok URL changed or tunnel down |
| ngrok shows the request but the server logs nothing | ngrok forwards to the wrong port |
| Browser shows an ngrok warning page | Free ngrok interstitial; it affects browsers, not HubSpot's POST |
| Same event twice | Duplicate delivery is possible ([guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide)) |
