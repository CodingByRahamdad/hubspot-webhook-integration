// src/webhooks/errors.js
// Lets an event handler say whether a failure is worth retrying (see docs/21).
//
//   throw new Error(...)                -> RETRYABLE (default). Receiver answers
//                                          500 and HubSpot sends the batch again.
//   throw new PermanentEventError(...)  -> retrying can never help (for example the
//                                          event data is unusable). The event is stored
//                                          as "rejected" and HubSpot is told OK, so it
//                                          stops retrying that event.
//
// When unsure, throw a normal Error: a wasted retry is safer than a lost event.

class PermanentEventError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermanentEventError';
  }
}

module.exports = { PermanentEventError };
