// scripts/list-failed-events.js
// READ-ONLY report of webhook events that need attention (see docs/21):
//   - status "failed"                         (processing threw; waiting for a HubSpot retry)
//   - status "processing" with expired claim  (the server probably crashed mid-event)
//
// Run from the project folder:  npm run events:failed
// It never changes the database and prints no payload data or secrets.

require('dotenv').config({ quiet: true });
const { listProblemEvents, DEFAULT_DB_PATH } = require('../src/idempotency/eventStore');

const dbPath = process.env.IDEMPOTENCY_DB_PATH || DEFAULT_DB_PATH;
const now = Date.now();
const rows = listProblemEvents(dbPath, { now });

if (rows.length === 0) {
  console.log(`No failed or stuck events in ${dbPath}.`);
} else {
  console.log(`${rows.length} event(s) need attention in ${dbPath}:`);
  console.table(
    rows.map((r) => ({
      portal_id: r.portal_id,
      event_id: r.event_id,
      type: r.subscription_type,
      object_id: r.object_id,
      status: r.status,
      attempts: r.attempts,
      error: r.last_error,
      first_seen: new Date(r.first_received_at).toISOString(),
      minutes_since_update: Math.round((now - r.updated_at) / 60000),
    }))
  );
}
