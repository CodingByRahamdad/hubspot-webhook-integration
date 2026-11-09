// src/security/localOnly.js
// Keeps development-only routes (/webhooks/test, /webhooks/local-test) away from
// the public internet.
//
// Why a plain "is the client localhost?" check is NOT enough:
// ngrok runs on THIS machine and connects to Express from 127.0.0.1, so even a
// request from the internet has a loopback socket address. We therefore also
// require that no proxy headers are present (ngrok always adds them and a
// remote caller cannot remove them) and that the Host header is a local name.

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'];

// Routes are registered only outside production.
function isLocalDevelopment() {
  return process.env.NODE_ENV !== 'production';
}

function hostName(hostHeader) {
  if (typeof hostHeader !== 'string') return '';
  // Strip an optional :port (keeping the brackets of an IPv6 literal).
  return hostHeader.toLowerCase().replace(/:\d+$/, '');
}

function isLocalRequest(req) {
  // req.socket.remoteAddress is the real TCP peer; req.ip can be influenced by headers.
  const address = req.socket && req.socket.remoteAddress;
  if (!LOOPBACK_ADDRESSES.has(address)) return false;
  if (PROXY_HEADERS.some((name) => req.headers[name] !== undefined)) return false;
  return LOCAL_HOSTS.has(hostName(req.headers.host));
}

// Non-local callers get the normal 404, so the route's existence is not revealed.
function localOnly(req, res, next) {
  if (isLocalRequest(req)) return next();
  return next('route');
}

module.exports = { localOnly, isLocalDevelopment, isLocalRequest };
