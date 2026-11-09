# 11 - HubSpot Webhook Subscriptions

> Not to be confused with [11-hubspot-oauth-flow.md](11-hubspot-oauth-flow.md), which shares this number.

## What is it?

A **subscription** tells HubSpot "send my server a POST request when this kind of thing happens". Ours are declared in the HubSpot project file:

`hubspot-webhook-app/HubSpot_Webhook_Events_App/src/app/webhooks/webhooks-hsmeta.json`

## Why do we need it?

HubSpot only sends events you subscribed to. No subscription means no webhook, even if your server is running perfectly.

## How it works

The file has three lists under `config.subscriptions`:

| List | Event format | Used by us? |
|---|---|---|
| `legacyCrmObjects` | Classic types such as `contact.creation` | **Yes, all active subscriptions** |
| `crmObjects` | Newer generic `object.*` types | Present but **inactive** |
| `hubEvents` | e.g. `contact.privacyDeletion` | Present but **inactive** |

The two formats have different payloads, so we do not mix them. The receiver only understands the classic format. Source: [Configure a webhook subscription](https://developers.hubspot.com/docs/apps/developer-platform/add-features/configure-webhooks).

A property-change subscription names **one** `propertyName`, so each watched property needs its own entry.

## What is configured

| Object | creation | deletion | propertyChange (one entry per property) |
|---|---|---|---|
| Contact | yes | yes | `firstname`, `lastname`, `email`, `lifecyclestage` |
| Company | yes | yes | `name`, `domain`, `industry` |
| Deal | yes | yes | `dealname`, `dealstage`, `amount`, `pipeline` |
| Ticket | yes | yes | `subject`, `hs_pipeline`, `hs_pipeline_stage` |

That is 22 subscriptions, all with `"active": true`. The target URL is `https://lived-freeness-disband.ngrok-free.dev/webhooks/simulate` (unchanged). Subscription types and the requirement for a `propertyName` come from the [Webhooks v3 guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide).

Example entries:

```json
{ "subscriptionType": "company.creation", "active": true },
{ "subscriptionType": "deal.propertyChange", "propertyName": "dealstage", "active": true },
{ "subscriptionType": "ticket.deletion", "active": true }
```

## Required scopes

HubSpot requires a read scope for each object you subscribe to ([guide](https://developers.hubspot.com/docs/api-reference/legacy/webhooks/guide)):

| Object | Scope |
|---|---|
| Contact | `crm.objects.contacts.read` |
| Company | `crm.objects.companies.read` |
| Deal | `crm.objects.deals.read` |
| Ticket | `crm.objects.tickets.read` (see note) |

> **Note on the ticket scope:** the project uses `crm.objects.tickets.read`. The Webhooks v3 guide linked above lists `tickets` as the scope for ticket webhooks. Whether HubSpot accepts `crm.objects.tickets.read` for ticket webhook subscriptions has **not been verified**; it will only be confirmed by uploading the project and receiving a real ticket event.

These were added to `requiredScopes` in `app-hsmeta.json`, to `DEFAULT_SCOPES` in `src/oauth.js`, and to `.env.example`. **Your own `.env` was not changed.** Edit `HUBSPOT_SCOPES` there yourself to match.

## How to configure it

1. Edit `webhooks-hsmeta.json` (set `active`, add or remove entries).
2. Validate: `hs project validate` (from the HubSpot project folder).
3. Upload and deploy the project (`hs project upload`, then deploy the build).
4. Because scopes changed, re-authorize the app in your HubSpot account (open `/oauth/install`).
5. Make sure ngrok is running and forwarding to the Express port.

> Status: the file has been edited, but **it has not been uploaded or deployed yet**. Until then HubSpot still uses the old subscriptions.

## How to test

- Simulated: see [17-webhook-testing-guide.md](17-webhook-testing-guide.md).
- Real: after deployment, create, edit and delete a test record of each type and watch the server terminal and the ngrok inspector (`http://127.0.0.1:4040`).

Verified with real HubSpot events so far: **`contact.creation` only.** Every other subscription is **not yet verified** with real delivery.

## Common errors and troubleshooting

| Symptom | Likely cause |
|---|---|
| No events at all | Project not uploaded/deployed, subscription `active: false`, or ngrok not running |
| Company/deal/ticket events missing | App not re-authorized after the scope change |
| Property change never arrives | Wrong `propertyName`, or that property is not on the record. HubSpot sends nothing for a property that does not exist |
| Same change arrives twice | Duplicate delivery is possible. Do not assume `eventId` is unique |
| Validation fails on upload | Too many or duplicate subscriptions. Run `hs project validate` and read the message |
| Events not recognized by our server | You activated `crmObjects` (generic format). Keep those inactive |
