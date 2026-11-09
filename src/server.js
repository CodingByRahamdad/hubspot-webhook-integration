// src/server.js
// A very simple Express server that receives JSON webhooks
// and prints them to the terminal.

// Load variables from .env into process.env (must run before they are read).
require('dotenv').config();

const express = require('express');
const oauthRouter = require('./oauth');
const { routeEvent } = require('./webhooks/router');
const { verifyHubspotSignature } = require('./webhooks/verifyHubspotSignature');
const { localOnly, isLocalDevelopment } = require('./security/localOnly');
const { redactHeaders } = require('./security/redactHeaders');
const { processBatch } = require('./webhooks/processBatch');
const { getEventStore, closeEventStore } = require('./idempotency/eventStore');
const { describeError } = require('./webhooks/processBatch');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware: reads JSON request bodies and puts the result in req.body.
// The "verify" hook runs BEFORE parsing and keeps the exact raw bytes in
// req.rawBody, which HubSpot signature validation needs (docs/19).
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// GET /health - lets us check that the server is alive.
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'Webhook server is running.',
  });
});

// POST /webhooks/test - LOCAL DEVELOPMENT ONLY. Receives a JSON payload and logs it.
// Registered only outside production, and only answers requests from this machine
// (localOnly returns 404 to anything arriving through ngrok). See docs/19.
function handleTest(req, res) {
  console.log('\n=== Webhook received ===');
  console.log('Method:', req.method);
  // Sensitive headers (authorization, cookies, signatures, tokens...) are redacted.
  console.log('Headers:', JSON.stringify(redactHeaders(req.headers), null, 2));
  console.log('Payload:', JSON.stringify(req.body, null, 2));

  res.status(200).json({
    status: 'success',
    message: 'Webhook received.',
  });
}
if (isLocalDevelopment()) {
  app.post('/webhooks/test', localOnly, handleTest);
}

// ---------------------------------------------------------------------------
// CLASSIC HubSpot webhook events (real or simulated)
//
// The classic HubSpot format sends ONE HTTP request containing an ARRAY of
// event objects. Each event has a "subscriptionType" such as "contact.creation".
// Supported: creation, propertyChange and deletion for contacts, companies,
// deals and tickets. The routing lives in src/webhooks/ (see docs/16).
// NOTE: HubSpot's newer generic "object.*" format uses different property
// names and is NOT handled here.
// ---------------------------------------------------------------------------

// Validates the body and logs the harmless parts of the request.
// Returns the events array, or null after sending a 400 response.
function readBatch(req, res) {
  const events = req.body;

  // Validation: the body must be a non-empty array.
  if (!Array.isArray(events)) {
    res.status(400).json({
      status: 'error',
      message: 'Payload must be a JSON array of events.',
    });
    return null;
  }

  if (events.length === 0) {
    res.status(400).json({
      status: 'error',
      message: 'Payload must contain at least one event.',
    });
    return null;
  }

  // Log only two harmless headers (not all of them) so we never print
  // authorization or signature values.
  console.log('\n=== Simulated webhook batch received ===');
  console.log('Content-Type:', req.headers['content-type']);
  console.log('User-Agent:', req.headers['user-agent']);
  console.log(`Events in this request: ${events.length}`);
  return events;
}

// Handler for the REAL HubSpot receiver: signature-checked (middleware) AND
// duplicate-protected. HubSpot retries a batch on any 4xx/5xx, so failures
// are reported with real error codes (see docs/20).
function handleHubspotBatch(req, res) {
  const events = readBatch(req, res);
  if (!events) return undefined;

  let result;
  try {
    result = processBatch(events, { store: getEventStore() });
  } catch (err) {
    // The database could not even be opened: nothing was processed.
    console.error(`Idempotency store unavailable (${describeError(err)}). Batch not processed.`);
    return res.status(503).json({
      status: 'error',
      message: 'Event storage is unavailable. Please retry later.',
    });
  }

  const { counts, storeErrors } = result;
  if (storeErrors > 0) {
    return res.status(503).json({ status: 'error', message: 'Event storage error. Please retry later.', ...counts });
  }
  if (counts.failed > 0) {
    return res.status(500).json({ status: 'error', message: 'Some events failed processing. Please retry.', ...counts });
  }
  // Another request is still working on some events. Answering 200 could make
  // HubSpot stop retrying an event whose first attempt then fails (docs/21).
  if (counts.inProgress > 0) {
    return res
      .status(503)
      .json({ status: 'error', message: 'Some events are still being processed. Please retry.', ...counts });
  }
  return res.status(200).json({ status: 'success', message: 'Events routed.', ...counts });
}

// Handler for /webhooks/local-test: stateless, NO duplicate protection, so the
// same sample payload can be re-sent while experimenting.
function handleEventBatch(req, res) {
  const events = readBatch(req, res);
  if (!events) return undefined;

  let recognized = 0; // supported event types
  let unrecognized = 0; // unsupported or missing event types

  // Route every event individually.
  events.forEach((event, index) => {
    console.log(`\nEvent ${index + 1} of ${events.length}`);
    if (routeEvent(event)) {
      recognized += 1;
    } else {
      unrecognized += 1;
    }
  });

  // Always 200 for a well-formed batch: real senders retry on non-2xx replies.
  res.status(200).json({
    status: 'success',
    message: 'Events routed.',
    received: events.length,
    recognized,
    unrecognized,
  });
}

// POST /webhooks/simulate - the REAL HubSpot receiver (ngrok target URL).
// Requests must carry a valid HubSpot Signature v3; there is no bypass here.
app.post('/webhooks/simulate', verifyHubspotSignature, handleHubspotBatch);

// POST /webhooks/local-test - LOCAL TESTING ONLY, no signature check.
// Use it for Postman/curl. ngrok would expose it publicly, so it is NOT
// registered in production and only answers requests from this machine
// (404 for anything arriving through ngrok). Never point HubSpot at it.
if (isLocalDevelopment()) {
  app.post('/webhooks/local-test', localOnly, handleEventBatch);
}

// OAuth routes: GET /oauth/install and GET /oauth/callback (see src/oauth.js).
app.use('/oauth', oauthRouter);

// 404 handler: runs when no route above matched.
app.use((req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

// Error handler: Express knows it is an error handler because it has 4 parameters.
app.use((err, req, res, next) => {
  // express.json() sets this type when the body is not valid JSON.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid JSON payload.',
    });
  }

  // Errors from Express/body-parser carry their own 4xx code (413 body too large,
  // 415 unsupported encoding, ...). These are the CLIENT's fault: keep the 4xx and
  // do not dump the error object into the log.
  const status = err.status || err.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    const messages = {
      413: 'Payload too large.',
      415: 'Unsupported content encoding or charset.',
    };
    console.warn(`Request rejected (HTTP ${status}${typeof err.type === 'string' ? `, ${err.type}` : ''}).`);
    return res.status(status).json({
      status: 'error',
      message: messages[status] || 'Bad request.',
    });
  }

  // Only the class name is logged here: the full error can include request data.
  console.error(`Unexpected error (${describeError(err)}).`);
  res.status(500).json({
    status: 'error',
    message: 'Internal server error.',
  });
});

// Start listening only when run directly (node src/server.js), so tests can
// import the app without opening a port.
if (require.main === module) {
  const httpServer = app.listen(PORT, () => {
    console.log(`Webhook server listening on http://localhost:${PORT}`);
  });

  // Clean shutdown (Ctrl+C or a stop signal): stop taking requests, close the database.
  const shutdown = (signal) => {
    console.log(`${signal} received: shutting down.`);
    httpServer.close(() => {
      try {
        closeEventStore();
      } catch (err) {
        console.error(`Could not close the event store (${describeError(err)}).`);
      }
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref(); // do not hang forever
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // After an unexpected crash the process state is unreliable: log the class name
  // only (messages may hold data) and exit, so a process manager can restart it.
  process.on('uncaughtException', (err) => {
    console.error(`Uncaught exception (${describeError(err)}). Exiting.`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`Unhandled promise rejection (${describeError(reason)}). Exiting.`);
    process.exit(1);
  });
}

module.exports = app;
