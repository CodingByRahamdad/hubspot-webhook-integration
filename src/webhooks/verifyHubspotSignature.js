// src/webhooks/verifyHubspotSignature.js
// Verifies HubSpot "Signature v3" before any webhook event is processed.
// See docs/19-webhook-signature-validation.md for a beginner explanation.
//
// HubSpot signs:  METHOD + URI + RAW_BODY + TIMESTAMP
// using HMAC-SHA256 with the app's client secret, then Base64-encodes it.
//
// This file never logs or returns the secret, the signature, or the body.

const crypto = require('crypto');

const MAX_AGE_MS = 5 * 60 * 1000; // HubSpot: requests older than 5 minutes are invalid

// The ONLY percent-encoded sequences HubSpot wants decoded before signing.
// (%3D and everything else must stay encoded.)
const DECODE_MAP = {
  '%3A': ':',
  '%2F': '/',
  '%3F': '?',
  '%40': '@',
  '%21': '!',
  '%24': '$',
  '%27': "'",
  '%28': '(',
  '%29': ')',
  '%2A': '*',
  '%2C': ',',
  '%3B': ';',
};

// Decodes only the characters in DECODE_MAP (case-insensitive hex digits).
function decodeHubspotUri(uri) {
  return uri.replace(/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi, (match) => DECODE_MAP[match.toUpperCase()]);
}

// Builds the public URL HubSpot called, e.g.
// https://abc.ngrok-free.dev/webhooks/simulate?x=1
// Behind ngrok the local request is plain http, but HubSpot signs the https URL,
// so the scheme is always https. PUBLIC_BASE_URL (optional) overrides the host.
function buildExternalUrl(req) {
  const override = process.env.PUBLIC_BASE_URL;
  if (override) {
    return override.replace(/\/+$/, '') + req.originalUrl;
  }
  const forwardedHost = req.headers['x-forwarded-host'];
  const host =
    (typeof forwardedHost === 'string' && forwardedHost.split(',')[0].trim()) || req.headers.host || '';
  return `https://${host}${req.originalUrl}`;
}

function computeSignature({ secret, method, uri, rawBody, timestamp }) {
  const source = `${method}${uri}${rawBody}${timestamp}`;
  return crypto.createHmac('sha256', secret).update(source, 'utf8').digest('base64');
}

// Constant-time comparison. timingSafeEqual THROWS if lengths differ, so check first.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function reject(res, status, message) {
  return res.status(status).json({ status: 'error', message });
}

function verifyHubspotSignature(req, res, next) {
  const secret = process.env.HUBSPOT_CLIENT_SECRET;
  if (!secret) {
    // Fail closed: never skip validation because of missing configuration.
    console.error('Signature check: HUBSPOT_CLIENT_SECRET is not set. Rejecting request.');
    return reject(res, 500, 'Webhook signature validation is not configured.');
  }

  const signature = req.headers['x-hubspot-signature-v3'];
  const timestamp = req.headers['x-hubspot-request-timestamp'];
  if (typeof signature !== 'string' || !signature || typeof timestamp !== 'string' || !timestamp) {
    console.warn('Signature check: missing signature header(s). Rejected.');
    return reject(res, 401, 'Missing HubSpot signature headers.');
  }

  if (!/^\d+$/.test(timestamp)) {
    console.warn('Signature check: timestamp is not numeric. Rejected.');
    return reject(res, 401, 'Invalid request timestamp.');
  }
  // Reject stale requests (replay protection) and timestamps far in the future.
  if (Math.abs(Date.now() - Number(timestamp)) > MAX_AGE_MS) {
    console.warn('Signature check: timestamp outside the 5-minute window. Rejected.');
    return reject(res, 401, 'Request timestamp is expired.');
  }

  // rawBody is saved by express.json({ verify }) in server.js.
  const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
  const uri = decodeHubspotUri(buildExternalUrl(req));
  const expected = computeSignature({ secret, method: req.method, uri, rawBody, timestamp });

  if (!safeEqual(expected, signature)) {
    console.warn('Signature check: signature mismatch. Rejected.');
    return reject(res, 401, 'Invalid HubSpot signature.');
  }

  return next();
}

module.exports = {
  verifyHubspotSignature,
  decodeHubspotUri,
  buildExternalUrl,
  computeSignature,
  safeEqual,
  MAX_AGE_MS,
};
