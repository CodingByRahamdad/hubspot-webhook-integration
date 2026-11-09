# 11 - HubSpot OAuth Flow

## What is it?

**OAuth 2.0** is a standard way to let one application (ours) access data in another service (HubSpot) **on behalf of a user, without ever seeing the user's password**. The user approves access on HubSpot's own page, and HubSpot gives our app a temporary key called an **access token**.

Key words:

| Term | Meaning |
|---|---|
| **Client ID** | Public identifier of our HubSpot app. |
| **Client secret** | Private password of our app. Must never reach a browser, a log, or Git. |
| **Scopes** | The permissions we ask for (here: `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`). |
| **Redirect URI** | The address HubSpot sends the user back to after approval. |
| **Authorization code** | A short-lived, one-time code HubSpot gives us after the user approves. |
| **State** | A random value we make up to protect against forged callbacks. |
| **Access token** | The key used to call the HubSpot API. Expires (about 30 minutes). |
| **Refresh token** | A longer-lived key used to get a new access token later. |

## Why do we need it?

Our webhook receiver only *listens*. To *talk back* to HubSpot (for example, read or update a contact), our app must be authorized. Installing the app through OAuth is how a HubSpot account grants that permission.

## How it works (authorization-code flow)

```
Browser                 Our server (localhost:3000)            HubSpot
   |  GET /oauth/install          |                               |
   |----------------------------->| make random state, remember it|
   |  302 redirect to HubSpot     |                               |
   |<-----------------------------|                               |
   |  open authorize URL (client_id, redirect_uri, scope, state)  |
   |------------------------------------------------------------->|
   |  user logs in and clicks "Connect app"                       |
   |  302 redirect to /oauth/callback?code=...&state=...          |
   |<-------------------------------------------------------------|
   |  GET /oauth/callback?code&state                              |
   |----------------------------->| check state                   |
   |                              | POST /oauth/v3/token (body)   |
   |                              |------------------------------>|
   |                              |  access + refresh tokens      |
   |                              |<------------------------------|
   |  "HubSpot account connected" |                               |
   |<-----------------------------|                               |
```

The public ngrok URL is for **incoming webhooks**. OAuth runs on `http://localhost:3000` in your own browser.

## The routes

### `GET /oauth/install`
Starts the flow. It creates a random `state`, remembers it for 10 minutes, and redirects the browser to HubSpot's authorize URL containing the client ID, the exact redirect URI, the scopes and the state.

### `GET /oauth/callback`
HubSpot sends the user back here. The server handles, in order:
1. **Denied/error** (`?error=access_denied`): returns a friendly 400, nothing is exchanged.
2. **Missing `code` or `state`**: 400.
3. **State check**: the state must be one we issued, not expired, and not used before. Otherwise 400.
4. **Storage check**: before the one-time code is used, the server checks that the encryption key and the token database are ready (otherwise a clear 500/503 and the code is not wasted).
5. **Token exchange**: only now is the code swapped for tokens.
6. **Portal ID and save**: the tokens are encrypted and saved. Success is reported only after that worked.

## State validation (why it matters)

Without `state`, an attacker could trick your browser into visiting `/oauth/callback?code=THEIR_CODE`, connecting *their* account to your session (a CSRF attack). Because only our server knows the random values it issued, a forged callback fails the check. Each state works **once** and expires after 10 minutes.

## Token exchange

The server sends a `POST` to `https://api.hubapi.com/oauth/v3/token` with `Content-Type: application/x-www-form-urlencoded` and this **body**:

```
grant_type=authorization_code
client_id=...
client_secret=...
redirect_uri=http://localhost:3000/oauth/callback
code=...
```

Credentials go in the body, never in the URL, because URLs end up in logs and browser history. The `redirect_uri` must be identical to the one used in `/oauth/install`. HubSpot replies with `access_token`, `refresh_token` and `expires_in`.

Before storing anything, the server checks that the response has a valid access token, a valid refresh token, and a whole-number `expires_in` between 60 seconds and 7 days. If any check fails, it returns an error, logs only the names of the invalid fields (never their values), and keeps any previously stored tokens unchanged. A rejected authorization code (HubSpot answers `invalid_grant`) gives a friendly 400; other HubSpot problems give 502.

## Which HubSpot account? (portal ID)

The token response normally contains `hub_id`, the HubSpot account (portal) ID. If it is missing or invalid, the server asks HubSpot who the new access token belongs to with `POST https://api.hubapi.com/oauth/v3/token/introspect` and uses the `hub_id` from that answer (only if the token is `active`). If the portal still cannot be determined, nothing is stored.

## Saving the tokens (encrypted)

The tokens are saved **encrypted** in `data/oauth-tokens.db`, one row per portal, using `TOKEN_ENCRYPTION_KEY`. The expiry time is counted from the moment the tokens arrived. The callback answers `HubSpot account connected. Tokens are stored encrypted.` **only after** the save worked; if encryption or storage fails you get an error that says the account was NOT connected (HTTP 500 for encryption, 503 for storage), and nothing is stored. Tokens never appear in a response or a log. Reconnecting the same account replaces its tokens.

The full story (encryption key, automatic refresh, failures, backup) is in [docs/22](22-oauth-token-lifecycle.md).

## Environment variables

Stored in `.env` (never committed; `.gitignore` already lists it):

| Variable | Purpose |
|---|---|
| `HUBSPOT_CLIENT_ID` | From the app's Auth page in HubSpot. |
| `HUBSPOT_CLIENT_SECRET` | From the same page. Keep private. |
| `HUBSPOT_REDIRECT_URI` | `http://localhost:3000/oauth/callback` |
| `HUBSPOT_SCOPES` | Space-separated scopes (optional; defaults to the project's scopes). |
| `TOKEN_ENCRYPTION_KEY` | **Required to connect an account.** 32 random bytes in base64; encrypts the stored tokens. See [docs/22](22-oauth-token-lifecycle.md) for how to generate and protect it. |
| `OAUTH_TOKEN_DB_PATH` | Optional. Where the encrypted tokens are stored. Default `data/oauth-tokens.db`. |

`.env.example` shows the shape with no real values. The `dotenv` package loads `.env` when the server starts.

## Setup

1. Install the new dependency: `npm install dotenv`.
2. Change the redirect URL in the HubSpot app project (`src/app/app-hsmeta.json`) from `http://localhost:3000` to `http://localhost:3000/oauth/callback`, then upload the project (`hs project upload`).
3. Copy the Client ID and Client Secret from the app's Auth settings in HubSpot.
4. Copy `.env.example` to `.env` and paste the values.
5. Generate an encryption key and put it in `.env` as `TOKEN_ENCRYPTION_KEY=` (command and rules in [docs/22](22-oauth-token-lifecycle.md)). Without it the callback refuses to connect an account.
6. Start the server: `npm run dev`.

## Testing

**Browser (full flow):** open `http://localhost:3000/oauth/install` (use localhost, not ngrok), choose a HubSpot test account, click connect. You should see `HubSpot account connected. Tokens are stored encrypted.` and the portal ID. The terminal prints only safe messages, never the code or tokens. Check the result afterwards with `npm run oauth:status` (read-only, shows no tokens).

**Postman (error cases, no HubSpot needed):**

| Request | Expected |
|---|---|
| `GET /oauth/callback` | 400 missing parameters |
| `GET /oauth/callback?error=access_denied` | 400 denied |
| `GET /oauth/callback?code=abc` | 400 missing parameters |
| `GET /oauth/callback?code=abc&state=fake` | 400 invalid or expired state |
| `GET /oauth/install` (turn off "Follow redirects") | 302 with a `Location` header to `app.hubspot.com` |

**Troubleshooting:**
- *redirect_uri mismatch*: the `.env` value and the registered URL differ (even a trailing slash).
- *Invalid or expired state*: more than 10 minutes passed, the page was reloaded, or nodemon restarted the server. Start again at `/oauth/install`.
- *OAuth is not configured*: `.env` is missing or incomplete.
- *Token exchange failed*: wrong client ID/secret.
- *"The authorization code is invalid or expired"*: the code works once and only briefly; start again at `/oauth/install`.
- *"token encryption is not configured correctly ... NOT connected"* (500): `TOKEN_ENCRYPTION_KEY` is missing or not 32 random bytes in base64. Fix `.env`, restart, start again.
- *"Token storage is unavailable ... NOT connected"* (503): the token database cannot be opened or written (check `OAUTH_TOKEN_DB_PATH` and folder permissions).
- *"Could not determine the HubSpot account ID"*: HubSpot returned no usable `hub_id`; nothing was stored.

## Security considerations

- Never hardcode, log or share the client secret, codes or tokens. Our code logs only short status messages.
- The secret is used only on the server; the browser never receives it, and the callback response contains no tokens.
- Always use HTTPS in production. `http://localhost` is acceptable only for local development.
- The code and state appear in the callback URL, so they are one-time and short-lived.

## Limitations of this learning version

- **State in memory** is fine for one local server: it is simple and short-lived. It is lost on restart, does not work across multiple servers, and is not tied to a specific browser session.
- **Tokens are stored encrypted and persistently** (they survive restarts and nodemon reloads), per HubSpot account, and are renewed automatically when the app asks for a valid token. See [docs/22](22-oauth-token-lifecycle.md).
- Nothing calls the HubSpot API with these tokens yet; this is the foundation for that.
- Webhook signature verification is a separate topic, not covered here.
