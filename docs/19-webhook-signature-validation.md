# 19. Webhook Signature Validation (HubSpot Signature v3)

## What is webhook signature validation?

A webhook URL is just a public web address. Anyone who learns it can send fake
POST requests to it. **Signature validation** lets your server check that a
request really came from HubSpot and was not changed on the way.

## Why is it necessary?

Without it, an attacker could send `contact.deletion` events and your app would
believe them. With it, only requests signed with your HubSpot app's **client
secret** are accepted, and everything else is rejected before any event is
processed.

## How Signature v3 works

HubSpot builds this text:

```
HTTP_METHOD + REQUEST_URI + RAW_REQUEST_BODY + TIMESTAMP
```

Example (shortened):

```
POST https://my-name.ngrok-free.dev/webhooks/simulate [{"eventId":1,...}] 1730000000000
```
(real strings have no spaces between the four parts)

It then runs **HMAC-SHA256** on it with your client secret and Base64-encodes
the result. That value is sent to you in a header. Your server repeats the
same calculation. If both results match, the request is genuine.

### The two headers

| Header | Purpose |
|---|---|
| `X-HubSpot-Signature-v3` | The Base64 HMAC HubSpot calculated. |
| `X-HubSpot-Request-Timestamp` | When HubSpot sent the request (milliseconds since 1970). Part of the signed text. |

## HMAC-SHA256 in this project

See [src/webhooks/verifyHubspotSignature.js](../src/webhooks/verifyHubspotSignature.js):

```js
crypto.createHmac('sha256', secret).update(source, 'utf8').digest('base64');
```

HMAC mixes a secret key with the message. Without the secret nobody can produce
the correct value, and changing even one character of the message changes the
result completely. The two values are compared with `crypto.timingSafeEqual()`
(constant time, so response timing leaks nothing). That function throws when
lengths differ, so we compare lengths first and just return "not equal".

## Why the raw body matters

The signature covers the **exact bytes** HubSpot sent. If you parse the JSON and
then `JSON.stringify` it, spaces, key order or number formatting can change, and
a valid request would fail. So in `src/server.js`:

```js
express.json({ verify: (req, res, buf) => { req.rawBody = buf; } })
```

`verify` runs before parsing and saves the untouched bytes in `req.rawBody`.
Normal parsing still fills `req.body` for the handlers.

## Why the 5-minute timestamp check matters

Because the timestamp is part of the signed text, it can't be edited. If an
attacker records a genuine request and re-sends it later (a **replay attack**),
the old timestamp exposes it. We reject timestamps that are non-numeric, older
than 5 minutes, or more than 5 minutes in the future.

## How invalid requests are rejected

The `verifyHubspotSignature` middleware runs **before** the event handler on
`POST /webhooks/simulate`:

| Problem | Response |
|---|---|
| `HUBSPOT_CLIENT_SECRET` not set | 500 (fails closed, never skips the check) |
| Missing header | 401 |
| Timestamp invalid / expired | 401 |
| Signature does not match | 401 |

Logs only say what category failed. The secret, signature and body are never
logged. Note: malformed JSON is still rejected with 400 by the JSON parser
before the signature check runs. No events are processed in that case either.

## Environment variables

- `HUBSPOT_CLIENT_SECRET`: your app's client secret (already used by OAuth).
  Nothing new is required.
- `PUBLIC_BASE_URL` (optional): e.g. `https://my-name.ngrok-free.dev`. Only needed
  if the automatically detected host is wrong.

## ngrok and the full URL

HubSpot signs the URL **it** called: `https://my-name.ngrok-free.dev/webhooks/simulate`.
But your Express app sees a local plain-HTTP request to `localhost:3000`. So the
code rebuilds the URL as:

```
https:// + (X-Forwarded-Host or Host) + req.originalUrl
```

`originalUrl` includes the path and query string. The scheme is always `https`.
Before signing, only these encoded characters are decoded, as HubSpot documents:
`%3A %2F %3F %40 %21 %24 %27 %28 %29 %2A %2C %3B`. Others (such as `%3D`) stay
encoded. If validation fails only through ngrok, set `PUBLIC_BASE_URL`.

## Two routes

| Route | Signature | Use |
|---|---|---|
| `POST /webhooks/simulate` | **Required** | The real HubSpot target URL. No bypass. |
| `POST /webhooks/local-test` | None | Local Postman/curl practice only. Never point HubSpot at it. Local-only (see below). |
| `POST /webhooks/test` | None | Local debugging only. Local-only, headers redacted (see below). |

## Security hardening: keeping dev routes off the internet

ngrok forwards **every** Express route to the public internet. Two routes have
no signature check, so they must never be reachable that way:

- `/webhooks/local-test` runs the real event handler with no signature. Anyone
  could have used it to inject fake events and skip validation.
- `/webhooks/test` printed every request header, including any `Authorization`,
  cookie or signature, to your terminal.

Both are now protected in two layers:

1. **Not registered in production.** If `NODE_ENV=production`, the routes do
   not exist (a normal 404). Your deployment must set `NODE_ENV=production`.
   Local development needs no `.env` change because `NODE_ENV` is simply unset.
2. **Local requests only.** Even in development, `src/security/localOnly.js`
   answers only if all of these are true, otherwise it returns the normal 404:
   - the TCP connection comes from a loopback address (`127.0.0.1`, `::1`);
   - none of `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`,
     `Forwarded` is present;
   - the `Host` header is `localhost`, `127.0.0.1` or `[::1]`.

Why not just check "is the client localhost"? ngrok runs on **your computer** and
connects to Express from `127.0.0.1`, so internet traffic also looks like
localhost. The proxy headers (which ngrok always adds) and the `Host` header are
what reveal that a request came from outside. `/webhooks/simulate` has no such
exceptions and is unaffected.

Note: the JSON body parser runs before these checks, so a remote caller sending
malformed JSON to a dev route gets a 400 instead of a 404. Nothing is processed.

### Header redaction

`/webhooks/test` now prints headers through `src/security/redactHeaders.js`. Any
header whose name contains `signature`, `token`, `secret`, `key`, `password`,
`auth`, `cookie` or `credential` is shown as `[REDACTED]`; harmless ones such as
`content-type`, `host` and `user-agent` are still printed. The request payload
is still logged, so use this route only with test data.

Tests for all of this are in `tests/security.test.js`.

## How to test

Automated (generated secrets, no real credentials):

```
npm test
```

Manual signed request (PowerShell/Git Bash, with the server running and
`HUBSPOT_CLIENT_SECRET` set in `.env`). Save as `sign-test.js` outside the repo
or run with `node -e`:

```js
require('dotenv').config();
const crypto = require('crypto');
const body = JSON.stringify([{ eventId: 1, subscriptionId: 1, portalId: 1,
  occurredAt: Date.now(), subscriptionType: 'contact.creation', objectId: 1 }]);
const ts = String(Date.now());
const host = 'localhost:3000';
// Local test: the server sees host "localhost:3000", so sign https://localhost:3000/...
const uri = `https://${host}/webhooks/simulate`;
const sig = crypto.createHmac('sha256', process.env.HUBSPOT_CLIENT_SECRET)
  .update('POST' + uri + body + ts).digest('base64');
fetch('http://localhost:3000/webhooks/simulate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json',
    'X-HubSpot-Signature-v3': sig, 'X-HubSpot-Request-Timestamp': ts },
  body,
}).then(async (r) => console.log(r.status, await r.text()));
```

Expect `200`. Change one character of `body` after signing (or omit the headers)
and expect `401`.

With ngrok: create, edit or delete a test record in HubSpot, then check the
server terminal and the ngrok inspector (`http://127.0.0.1:4040`) for a `200`.
A `401` means the secret, URL or body didn't match.
