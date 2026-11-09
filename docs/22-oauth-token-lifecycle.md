# 22 - OAuth Token Lifecycle (storage, refresh, re-authorization)

This lesson explains how the app keeps HubSpot's OAuth tokens **safely and permanently**, and how it renews them automatically. Read [docs/11](11-hubspot-oauth-flow.md) first (the one-time authorization) and [docs/20](20-webhook-idempotency.md) (the other SQLite database).

## The big idea (hotel key card)

- The **access token** is a key card. It works for about **30 minutes**, then stops.
- The **refresh token** is the record at the front desk that lets us print a new card without bothering the guest again.
- We keep both in a locked safe (**encrypted** in a database), note when the card expires, and have **one clerk** (`getValidAccessToken`) who hands out a working card, printing a new one when needed.

Webhook *receiving* does not need any of this: signature validation uses the client secret only. Tokens are for when our app wants to **talk back** to HubSpot's API.

## The pieces

| File | Job |
|---|---|
| `src/oauth.js` | `/oauth/install` and `/oauth/callback` (the one-time authorization) |
| `src/security/tokenCrypto.js` | Encrypts/decrypts a token (AES-256-GCM) |
| `src/oauth/tokenStore.js` | The SQLite table of encrypted connections, with version checks |
| `src/oauth/hubspotTokenClient.js` | Sends the "refresh" request to HubSpot and checks the answer |
| `src/oauth/tokenService.js` | Decides when to refresh and handles every failure |
| `scripts/oauth-status.js` | Read-only status report (`npm run oauth:status`) |

## Authorization and callback flow

```
Browser            Our server                         HubSpot
  | /oauth/install     |                                 |
  |------------------->| random state (10 min, once)     |
  |<-- 302 to HubSpot -|                                 |
  | user approves ---------------------------------------->|
  |<-- redirect to /oauth/callback?code&state ------------|
  | /oauth/callback    | 1. check state (single use)     |
  |------------------->| 2. check encryption + database  |
  |                    |    are ready (BEFORE the code   |
  |                    |    is used)                     |
  |                    | 3. POST /oauth/v3/token         |
  |                    |------------------------------->|
  |                    |<-- access + refresh token, hub_id
  |                    | 4. portal ID: hub_id, or ask    |
  |                    |    /oauth/v3/token/introspect   |
  |                    | 5. encrypt + save               |
  |<-- "connected" ----| (only AFTER the save worked)    |
```

Good to know:
- The authorization code works **once**, so the server first checks that it can store the tokens. If the encryption key is missing, you get a clear error and the code is not wasted.
- The expiry time is counted from the moment the tokens arrive.
- Success is reported **only after** the encrypted save worked. If saving fails you see "The HubSpot account was NOT connected" (HTTP 500/503) and nothing is stored.
- The response and the logs never contain a token. Reconnecting the same account replaces its tokens.

## Encryption key

Tokens are encrypted with **AES-256-GCM**. Every encryption uses a fresh random value, and each ciphertext is bound to the portal and to the token type, so it cannot be copied to another row. Tampering is detected.

You need one secret key: **32 random bytes written in base64**. Generate it once with this command (it only prints a random value; it changes nothing):

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Put the value in your **real `.env`** (never in `.env.example`, never in Git):

```
TOKEN_ENCRYPTION_KEY=<the value you generated>
```

Rules:
- **Back up the key separately from the database** (for example in a password manager). Anyone with both can read the tokens; without the key the tokens are unreadable.
- **If the key is lost**, the stored tokens are gone for good: connect the account again at `/oauth/install`.
- **Missing or invalid key = fail closed.** Nothing is ever stored or read in plaintext. Webhook receiving keeps working.
- Changing the key makes existing rows unreadable (re-authorize). Key rotation is not built yet.

## Where the tokens live

`data/oauth-tokens.db` (SQLite, created on first use). Override with `OAUTH_TOKEN_DB_PATH`. It is a **separate file** from `data/webhook-events.db`, so secrets are isolated from event data, can be backed up separately, and the webhook code is untouched. `data/` is in `.gitignore`.

One row per HubSpot portal: encrypted access token, encrypted refresh token, expiry time, status (`active` or `needs_reauth`), failure counters, timestamps and a version number. No plaintext token is ever stored.

## Automatic refresh

Application code asks for a token like this:

```js
const { getValidAccessToken } = require('./oauth/tokenService');
const accessToken = await getValidAccessToken(portalId); // a working token, or a clear error
```

What happens inside:
1. More than **5 minutes** left -> the stored token is returned (no HubSpot call).
2. 5 minutes or less (or expired) -> a **refresh** (`POST /oauth/v3/token`, `grant_type=refresh_token`).
3. Many callers at once share **one** refresh.
4. The new tokens are saved with a **version check**: if the row changed meanwhile (another process, or a new authorization), the stale result is thrown away and never overwrites newer data.
5. If HubSpot sends a **new refresh token**, it is stored. If it sends none, the old one is kept. (HubSpot's docs do not say whether refresh tokens rotate, so both cases are handled.)
6. An **expired token is never returned** after a failed refresh.

## When a refresh fails

| What happened | Result | Stored tokens |
|---|---|---|
| Network error, timeout, HTTP 429, HTTP 5xx, bad answer | Temporary error `REFRESH_FAILED`; retry later. A **cooldown** starts (HubSpot's `Retry-After`, otherwise 30 s doubling up to 5 min). A token that is still valid for 30+ seconds keeps being used. | Untouched |
| HubSpot says the refresh token is no longer valid (`invalid_grant`) | Connection marked **`needs_reauth`**, error `REAUTH_REQUIRED` | Kept, but no more refresh attempts |
| Wrong client ID/secret, other 4xx | `REFRESH_REJECTED` or `REFRESH_MISCONFIGURED` (not retried quickly) | Untouched |
| Wrong/missing encryption key, database problem | `ENCRYPTION_ERROR` / `STORAGE_ERROR` | Untouched |

**Re-authorization:** if an account needs it, open `http://localhost:3000/oauth/install` again and approve. The new tokens replace the old ones, the status returns to `active` and the failure state is cleared.

Errors carry only a fixed message and a short code, never a token, key or HubSpot response text.

## Checking the status safely

```
npm run oauth:status
npm run oauth:status -- --check-decrypt
```

Both are **read-only**: they never create or change anything. They show whether the key is configured (`configured`, `missing`, `invalid`), whether the database exists, and for each portal its status, access-token expiry, last refresh, failure count and short error code. They **never show tokens, ciphertext, the key, file paths or raw database errors**. `--check-decrypt` additionally tries to decrypt the stored tokens in memory and prints only `ok` or `cannot decrypt` (useful to detect a wrong or lost key). Exit codes: 0 report shown, 1 decrypt check failed, 2 database unreadable or bad usage.

## Backup and recovery

- Back up `data/oauth-tokens.db` **and** the key, **in different places**. Stop the server before copying and copy the `-wal`/`-shm` files too if they exist (or copy after a clean shutdown).
- Restoring an **old** copy can bring back a refresh token that HubSpot has since replaced; if the account then shows `needs_reauth`, just re-authorize.
- Lost key or lost database = connect the account again. Nothing else is lost: webhook events and their duplicate protection live in the other database.
- To start clean, stop the server, delete `data/oauth-tokens.db*`, and reconnect.

## Required environment variables

| Variable | Needed for | Notes |
|---|---|---|
| `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` | authorization and refresh | from the app's Auth page |
| `HUBSPOT_REDIRECT_URI` | authorization | must exactly match the app's registered redirect URL |
| `HUBSPOT_SCOPES` | authorization | optional; defaults to the project's scopes |
| `TOKEN_ENCRYPTION_KEY` | storing/reading tokens | 32 random bytes, base64. **Required.** |
| `OAUTH_TOKEN_DB_PATH` | token database | optional; default `data/oauth-tokens.db` |

`.env.example` shows the shape with no real values. Never commit `.env`.

## Local development vs production

- **Redirect URI:** `http://localhost` is allowed only for local testing; production needs `https`.
- **Key management:** locally a `.env` is fine. In production use a secret manager or protected environment variables, and restrict who can read the database and key (file permissions).
- **Processes:** one server process is the supported setup. The version check keeps two processes from overwriting each other, but if HubSpot rotates refresh tokens a lost race between processes could force a re-authorization.
- **OAuth `state`** is still kept in memory: an install started before a restart must be started again.
- **Disk and backups:** the token database is small; include it (and keep the key elsewhere) in your backup routine.
- **Not built yet:** encryption key rotation, an admin "disconnect" action, automatic cleanup of old rows.

## Official HubSpot documentation

- OAuth overview, authorize URL and redirect rules: <https://developers.hubspot.com/docs/apps/legacy-apps/authentication/working-with-oauth>
- Token endpoint (`POST /oauth/v3/token`, grant types `authorization_code` and `refresh_token`): <https://developers.hubspot.com/docs/api-reference/legacy/authentication/oauth-tokens/create-oauth-token>
- OAuth v3 guide (30-minute access tokens, credentials in the request body, RFC 6749 errors): <https://developers.hubspot.com/docs/api-reference/auth-oauth-v3/guide>
- Managing tokens and introspection (`POST /oauth/v3/token/introspect`): <https://developers.hubspot.com/docs/api-reference/legacy/authentication/manage-oauth-tokens>
- OAuth quickstart: <https://developers.hubspot.com/docs/apps/legacy-apps/authentication/oauth-quickstart-guide>
- Scopes: <https://developers.hubspot.com/docs/apps/legacy-apps/authentication/scopes>

What HubSpot's pages do **not** state (so the code does not rely on it): whether refresh tokens rotate or expire, and rate limits of the token endpoint. `hub_id` is optional in the token response, which is why the introspection fallback exists.

## Tests

`npm test` runs every file in `tests/`. The OAuth pieces have their own: `token-crypto`, `token-store`, `hubspot-token-client`, `token-service`, `oauth-callback` and `oauth-status`. They use fake tokens and a stand-in for HubSpot, so no real request is made and no real database is touched.

## What this still does not do

- No encryption key rotation and no "disconnect" button.
- No automatic refresh on a timer: a token is refreshed when the app asks for it.
- Nothing calls the HubSpot API with these tokens yet; this is the foundation for that.
