// src/security/redactHeaders.js
// Returns a COPY of the headers that is safe to print: values of sensitive
// headers become "[REDACTED]". Harmless headers stay for debugging.

// Pattern-based, so future names (e.g. X-HubSpot-Signature-v4) are covered too.
const SENSITIVE_NAME = /signature|token|secret|key|password|auth|cookie|credential/i;

function redactHeaders(headers) {
  const safe = {};
  for (const [name, value] of Object.entries(headers || {})) {
    safe[name] = SENSITIVE_NAME.test(name) ? '[REDACTED]' : value;
  }
  return safe;
}

module.exports = { redactHeaders };
