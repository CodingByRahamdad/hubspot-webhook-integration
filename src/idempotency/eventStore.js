// src/idempotency/eventStore.js
// Persistent record of which webhook events we have handled, backed by SQLite
// (Node's built-in "node:sqlite", no extra dependency). See docs/20.
//
// The database PRIMARY KEY is what prevents two requests from processing the
// same event: claim() is ONE atomic SQL statement, not a check done in JavaScript.
//
// Stored: event identifiers, status, timestamps, and an error CLASS NAME.
// Never stored: headers, signatures, secrets, request bodies, error messages.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_LEASE_MS = 60 * 1000; // how long a "processing" claim stays valid
const DEFAULT_DB_PATH = path.join('data', 'webhook-events.db');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS webhook_events (
    portal_id         TEXT NOT NULL,
    event_id          TEXT NOT NULL,
    subscription_type TEXT NOT NULL,
    object_id         TEXT NOT NULL,
    property_name     TEXT NOT NULL,
    status            TEXT NOT NULL CHECK (status IN ('processing', 'processed', 'failed', 'rejected')),
    attempts          INTEGER NOT NULL,
    first_received_at INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    processed_at      INTEGER,
    lease_expires_at  INTEGER,
    last_error        TEXT,
    PRIMARY KEY (portal_id, event_id, subscription_type, object_id, property_name)
  )
`;

const KEY_WHERE =
  'portal_id = ? AND event_id = ? AND subscription_type = ? AND object_id = ? AND property_name = ?';

const keyValues = (k) => [k.portalId, k.eventId, k.subscriptionType, k.objectId, k.propertyName];

// Builds the dedupe key from a raw event, or returns null if it cannot be keyed
// (HubSpot "eventId" alone is documented as not guaranteed unique, so the key
// also includes portal, event type, object and property).
function buildEventKey(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const present = (v) => (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v !== '');
  if (!present(raw.eventId) || !present(raw.portalId) || typeof raw.subscriptionType !== 'string') {
    return null;
  }
  return {
    portalId: String(raw.portalId),
    eventId: String(raw.eventId),
    subscriptionType: raw.subscriptionType,
    objectId: raw.objectId === undefined || raw.objectId === null ? '' : String(raw.objectId),
    propertyName: typeof raw.propertyName === 'string' ? raw.propertyName : '',
  };
}

// Databases created before the 'rejected' status existed have an older CHECK
// constraint. SQLite cannot alter a constraint, so rebuild the table once,
// keeping every row.
function migrateOldSchema(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'webhook_events'").get();
  if (!row || row.sql.includes("'rejected'")) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('ALTER TABLE webhook_events RENAME TO webhook_events_old');
    db.exec(SCHEMA);
    db.exec('INSERT INTO webhook_events SELECT * FROM webhook_events_old');
    db.exec('DROP TABLE webhook_events_old');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function createEventStore(dbPath = DEFAULT_DB_PATH, { leaseMs = DEFAULT_LEASE_MS, now = Date.now } = {}) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA busy_timeout = 5000'); // wait (not fail) if another connection holds a lock
  if (dbPath !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrateOldSchema(db);
  db.exec(SCHEMA);

  // ONE atomic statement. A new key is inserted ("processing"). An existing key is
  // taken over ONLY if its previous attempt failed or its claim has expired.
  const claimStmt = db.prepare(`
    INSERT INTO webhook_events
      (portal_id, event_id, subscription_type, object_id, property_name,
       status, attempts, first_received_at, updated_at, lease_expires_at)
    VALUES (?, ?, ?, ?, ?, 'processing', 1, ?, ?, ?)
    ON CONFLICT (portal_id, event_id, subscription_type, object_id, property_name)
    DO UPDATE SET
      status = 'processing',
      attempts = webhook_events.attempts + 1,
      updated_at = excluded.updated_at,
      lease_expires_at = excluded.lease_expires_at,
      last_error = NULL
    WHERE webhook_events.status = 'failed'
       OR (webhook_events.status = 'processing' AND webhook_events.lease_expires_at < excluded.updated_at)
  `);
  const selectStmt = db.prepare(`SELECT status, attempts FROM webhook_events WHERE ${KEY_WHERE}`);
  const processedStmt = db.prepare(`
    UPDATE webhook_events
    SET status = 'processed', processed_at = ?, updated_at = ?, lease_expires_at = NULL, last_error = NULL
    WHERE ${KEY_WHERE} AND status = 'processing'
  `);
  const failedStmt = db.prepare(`
    UPDATE webhook_events
    SET status = 'failed', updated_at = ?, lease_expires_at = NULL, last_error = ?
    WHERE ${KEY_WHERE} AND status = 'processing'
  `);

  const rejectedStmt = db.prepare(`
    UPDATE webhook_events
    SET status = 'rejected', updated_at = ?, lease_expires_at = NULL, last_error = ?
    WHERE ${KEY_WHERE} AND status = 'processing'
  `);

  return {
    // Returns { claimed: true, retry } if THIS caller now owns the event, otherwise
    // { claimed: false, status } where status is 'processed', 'processing' or 'rejected'.
    // Throws if the database fails (the caller must then NOT process the event).
    claim(key) {
      const t = now();
      const result = claimStmt.run(...keyValues(key), t, t, t + leaseMs);
      const row = selectStmt.get(...keyValues(key));
      if (result.changes === 1) return { claimed: true, retry: row.attempts > 1 };
      return { claimed: false, status: row.status };
    },

    markProcessed(key) {
      const t = now();
      processedStmt.run(t, t, ...keyValues(key));
    },

    markFailed(key, errorName) {
      failedStmt.run(now(), String(errorName || 'Error').slice(0, 100), ...keyValues(key));
    },

    // Permanent failure (retrying can never help): HubSpot is told "OK" so it stops retrying.
    markRejected(key, errorName) {
      rejectedStmt.run(now(), String(errorName || 'Error').slice(0, 100), ...keyValues(key));
    },

    // For tests and the manual inspection script in docs/20.
    get(key) {
      return selectStmt.get(...keyValues(key));
    },

    close() {
      db.close();
    },
  };
}

// Lazily opened shared store used by the server. Path comes from
// IDEMPOTENCY_DB_PATH (default data/webhook-events.db). If opening fails the
// error is thrown to the caller on every attempt (so requests fail closed).
let sharedStore = null;
function getEventStore() {
  if (!sharedStore) {
    sharedStore = createEventStore(process.env.IDEMPOTENCY_DB_PATH || DEFAULT_DB_PATH);
  }
  return sharedStore;
}

// Closes the shared store if it was opened (used on shutdown).
function closeEventStore() {
  if (sharedStore) {
    sharedStore.close();
    sharedStore = null;
  }
}

// READ-ONLY report of events that need attention: 'failed', or 'processing'
// with an expired claim (the server probably crashed mid-event). Returns only
// identifiers, status, attempt count, error CLASS name and times. No payload data.
function listProblemEvents(dbPath, { now = Date.now() } = {}) {
  if (dbPath !== ':memory:' && !fs.existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT portal_id, event_id, subscription_type, object_id, status, attempts,
                last_error, first_received_at, updated_at
         FROM webhook_events
         WHERE status = 'failed' OR (status = 'processing' AND lease_expires_at < ?)
         ORDER BY updated_at`
      )
      .all(now);
  } finally {
    db.close();
  }
}

module.exports = { createEventStore, getEventStore, closeEventStore, listProblemEvents, buildEventKey, DEFAULT_DB_PATH };
