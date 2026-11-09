// src/webhooks/processBatch.js
// Processes one HubSpot batch with duplicate protection (see docs/20 and docs/21).
//
// Every event is handled on its own: a duplicate or a failure never stops the
// other events in the batch. Per event:
//   1. build the dedupe key          (no key  -> "invalid", not processed)
//   2. claim it in the database      (already done -> "duplicate",
//                                     being processed elsewhere -> "inProgress")
//   3. process it                    (routeEvent)
//   4. mark it processed, rejected OR failed ("processed" is written only AFTER step 3)
//
// If the database fails at step 2 the event is NOT processed (fail closed).
// Logs never include headers, signatures, secrets or event bodies.

const { buildEventKey } = require('../idempotency/eventStore');
const { routeEvent } = require('./router');
const { PermanentEventError } = require('./errors');

const HUBSPOT_TIMEOUT_MS = 5000; // HubSpot treats a slower response as a failed delivery
const SLOW_BATCH_MS = 3000; // warn well before that

// Safe description of an error for logs: class name, plus err.code (like
// "ECONNRESET") when it is a short code. Never the message, which could hold data.
function describeError(err) {
  const name = (err && err.name) || 'Error';
  const code = err && typeof err.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code) ? err.code : null;
  return code ? `${name}, ${code}` : name;
}

// HubSpot numbers deliveries from 0. Only retries (1, 2, ...) are worth logging.
function retryNote(event) {
  const n = event && event.attemptNumber;
  return Number.isInteger(n) && n >= 1 ? ` (HubSpot attemptNumber ${n})` : '';
}

function processBatch(events, { store, processEvent = routeEvent, now = Date.now, slowBatchMs = SLOW_BATCH_MS }) {
  const startedAt = now();
  const counts = {
    received: events.length,
    recognized: 0,
    unrecognized: 0,
    duplicates: 0,
    inProgress: 0,
    rejected: 0,
    failed: 0,
    invalid: 0,
  };
  let storeErrors = 0;

  events.forEach((event, index) => {
    console.log(`\nEvent ${index + 1} of ${events.length}`);

    const key = buildEventKey(event);
    if (!key) {
      console.warn('  [WARNING] Skipping event: missing eventId, portalId or subscriptionType.');
      counts.invalid += 1;
      return;
    }

    // Step 2: atomic claim.
    let claim;
    try {
      claim = store.claim(key);
    } catch (err) {
      console.error(`  Event ${key.eventId}: not processed (storage error: ${describeError(err)}).`);
      counts.failed += 1;
      storeErrors += 1;
      return;
    }

    if (!claim.claimed) {
      if (claim.status === 'processing') {
        // Another request is working on it right now. We must NOT answer "OK" for it:
        // if that other attempt fails, nobody would ever send the event again.
        console.log(`  Event ${key.eventId}: still being processed elsewhere, HubSpot should retry`);
        counts.inProgress += 1;
      } else if (claim.status === 'rejected') {
        console.log(`  Event ${key.eventId}: previously rejected as unprocessable, skipped`);
        counts.duplicates += 1;
      } else {
        console.log(`  Duplicate event ${key.eventId}: skipped`);
        counts.duplicates += 1;
      }
      return;
    }

    console.log(`  ${claim.retry ? 'Retry of event' : 'New event'} ${key.eventId}${retryNote(event)}: processing`);

    // Step 3: process.
    let recognized;
    try {
      recognized = processEvent(event);
    } catch (err) {
      if (err instanceof PermanentEventError) {
        // Retrying cannot help: record it and let HubSpot stop retrying this event.
        console.error(`  Event ${key.eventId}: rejected, will not be retried (${describeError(err)})`);
        counts.rejected += 1;
        try {
          store.markRejected(key, err.name);
        } catch (markErr) {
          console.error(`  Event ${key.eventId}: could not record the rejection (${describeError(markErr)}).`);
          storeErrors += 1;
        }
        return;
      }

      console.error(`  Event ${key.eventId}: processing failed (${describeError(err)})`);
      counts.failed += 1;
      try {
        store.markFailed(key, err.name);
      } catch (markErr) {
        // The claim lease will expire, so a retry can still take the event over.
        console.error(`  Event ${key.eventId}: could not record the failure (${describeError(markErr)}).`);
        storeErrors += 1;
      }
      return;
    }

    // Step 4: only now is the event recorded as processed.
    try {
      store.markProcessed(key);
    } catch (err) {
      // Processed, but not recorded. Report a failure so HubSpot retries; the
      // retry may process it again (at-least-once, see docs/20).
      console.error(`  Event ${key.eventId}: processed but could not be recorded (${describeError(err)}).`);
      counts.failed += 1;
      storeErrors += 1;
      return;
    }

    if (recognized) counts.recognized += 1;
    else counts.unrecognized += 1;
  });

  const durationMs = now() - startedAt;
  if (durationMs > slowBatchMs) {
    console.warn(
      `  [WARNING] Batch took ${(durationMs / 1000).toFixed(1)}s; HubSpot times out after ${HUBSPOT_TIMEOUT_MS / 1000}s.`
    );
  }

  return { counts, storeErrors, durationMs };
}

module.exports = { processBatch, describeError };
