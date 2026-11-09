# 18 - Automated Webhook Tests

## What is it?

A test file, `tests/webhook-events.test.js`, that checks the webhook receiver automatically using Node.js's built-in test runner (`node:test`) and assertions (`node:assert`). No extra packages are needed.

## Why do we need it?

Sending Postman requests by hand ([17](17-webhook-testing-guide.md)) is slow and easy to forget. The automated suite re-checks every supported event in a few seconds, so a future change that breaks routing is caught immediately.

**Important limit:** these tests are **simulated**. They prove our receiver's logic. They do not prove HubSpot delivers events. Real-event status is tracked in [17](17-webhook-testing-guide.md).

## How it works

- The test imports the Express `app` from `src/server.js`. That file only calls `listen` when run directly (`require.main === module`) and exports `app`, so importing it opens no port.
- The test starts the app on a random free local port (`app.listen(0)`), sends requests with Node's built-in `fetch`, and closes the server at the end.
- A small `captureConsole()` helper records what the receiver logs during a request and then restores `console`, so tests can check log lines without printing them.
- **Needed:** Node.js 18 or newer (for `fetch`). **Not needed:** a running server, ngrok, or HubSpot credentials. The `.env` file is not required by the tests.

## Commands

Run from `hubspot-webhook-integration`:

```
npm test
node --test tests/webhook-events.test.js
node --test --test-name-pattern="deal" tests/webhook-events.test.js
```

The third form runs only tests whose name contains "deal". `package.json` runs the file explicitly (not the folder) so it works on all Node versions.

## Test cases

| Group | What is checked | Expected result |
|---|---|---|
| `normalizeEvent` | Common fields are extracted (`eventId`, `subscriptionId`, `portalId`, `subscriptionType`, `occurredAt`, `objectId`) plus `objectType` and `action` | Values match the input |
| `normalizeEvent` | `propertyName`/`propertyValue` | Present only when sent |
| `normalizeEvent` | `null`, text, numbers, arrays, `{}`, non-string `subscriptionType` | `valid: false` |
| `normalizeEvent` | `company.merge`, `ticket.associationChange`, `product.creation`, `object.creation`, `a.b.c`, `contact.`, `constructor.creation`, `__proto__.creation`, ... | Valid but `objectType: null` (unknown) |
| `routeEvent` | Supported, unsupported, `null`, `{foo:'bar'}` | `true, false, false, false` |
| HTTP, 12 cases | `creation`, `propertyChange`, `deletion` for contact, company, deal, ticket | 200 and `received 1, recognized 1, unrecognized 0`; the log has the matching message; property changes also log the property name and value |
| Batch | One event per object in one request | 200, `received 4, recognized 4`, "Event 1 of 4" to "Event 4 of 4" logged |
| Mixed batch | 1 good event, 3 unknown types, an object without `subscriptionType`, a string, `null` | 200, `received 7, recognized 1, unrecognized 6`; warnings logged |
| Unknown only | `company.merge`, `product.deletion` | 200, `recognized 0, unrecognized 2` |
| Backward compatibility | `contact.creation` with extra HubSpot fields (`appId`, `attemptNumber`, `changeSource`) | Recognized |
| Invalid payload | A JSON object instead of an array | 400 `Payload must be a JSON array of events.` |
| Invalid payload | `[]` | 400 `Payload must contain at least one event.` |
| Invalid payload | Top-level `"hello"`, `123`, `null` | 400 (refused by Express's strict JSON parser) |
| Malformed JSON | Unclosed array, `{bad json}`, `[1,]` | 400 `Invalid JSON payload.` |
| Other routes | `GET /health`; unknown route | 200 success body; 404 `Route not found: GET /nope` |
| Safety | A request with `Authorization` and `X-HubSpot-Signature` headers | Their values never appear in the logs |

## How to add a test for a new object

1. Add the object to `src/webhooks/objectTypes.js` ([16](16-webhook-event-routing.md)).
2. Add one line to the `OBJECTS` table at the top of the test file: `prefix: [Label, propertyName, sampleValue]`. The three creation/propertyChange/deletion HTTP tests are generated from that table.

## Test results

The suite was run by the project owner (reported to the assistant, who did not run it itself):

| Item | Value |
|---|---|
| Node.js | v24.22.1 |
| Command | `node --test tests/webhook-events.test.js` |
| Total tests | 28 |
| Passed | 28 |
| Failed | 0 |
| Skipped | 0 |
| Duration | about 675 ms |

The 28 tests are: 4 `normalizeEvent` + 1 `routeEvent` + 12 HTTP object/action cases + 4 batch/unknown/compatibility cases + 4 invalid-payload/malformed-JSON cases + 3 other (health, 404, header-leak) cases.

**What this does and does not show.** These are simulated results. They show that the receiver's parsing, routing and responses behave as tested. They do not show that HubSpot delivers company, deal or ticket events, or that the subscriptions and scopes are accepted by HubSpot. See [17](17-webhook-testing-guide.md) for real-event status. `npm test` (which runs the same file) was not separately reported.

## Common errors and troubleshooting

| Symptom | Cause / fix |
|---|---|
| `fetch is not defined` | Node is older than 18. Upgrade Node |
| `Cannot find module '../src/server'` or no tests found | You are not in the `hubspot-webhook-integration` folder. `cd` there first |
| `Cannot find module 'express'` | Run `npm install` |
| Test fails with an unexpected message | The app's text changed. Update the test only if the change was intended |
| Test run never ends | A server was left open. Make sure the `after` hook closes it |
| Output is empty during a test | Expected: `captureConsole()` hides the receiver's logs while a request runs |
