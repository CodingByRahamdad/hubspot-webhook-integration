// tests/oauth-diagnostic.test.js
// TEMPORARY - delete together with the diagnostic block in src/oauth.js.

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const SECRET = 'test-client-secret-value';
const TOKEN = 'SECRET-ACCESS-TOKEN-12345';

// Replace the token service function BEFORE oauth.js is loaded (it destructures at require time).
const tokenService = require('../src/oauth/tokenService');
let tokenImpl;
tokenService.getValidAccessToken = (portalId) => tokenImpl(portalId);

let server;
let port;
const realFetch = globalThis.fetch;
let fetchImpl;
let fetchCalls;

before(async () => {
  process.env.HUBSPOT_CLIENT_SECRET = SECRET;
  const router = require('../src/oauth');
  const app = express();
  app.use('/oauth', router);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  port = server.address().port;
  globalThis.fetch = (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchImpl(url, opts);
  };
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  fetchCalls = [];
  tokenImpl = async () => TOKEN;
  fetchImpl = async () => ({ ok: true, status: 200, body: null });
});

function post(path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, text: data, json: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end();
  });
}

const URL_PATH = '/oauth/diagnostics/token-check';

test('401 without a key, with a wrong key, and with the key in the query string', async () => {
  for (const r of [
    await post(URL_PATH),
    await post(URL_PATH, { 'x-diagnostic-key': 'wrong' }),
    await post(`${URL_PATH}?key=${SECRET}`),
  ]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.json, { message: 'Unauthorized.' });
  }
  assert.equal(fetchCalls.length, 0);
});

test('401 when HUBSPOT_CLIENT_SECRET is unset', async () => {
  delete process.env.HUBSPOT_CLIENT_SECRET;
  try {
    const r = await post(URL_PATH, { 'x-diagnostic-key': '' });
    assert.equal(r.status, 401);
  } finally {
    process.env.HUBSPOT_CLIENT_SECRET = SECRET;
  }
});

test('success: uses portal 247711076 and the contacts URL, returns only four fields', async () => {
  let portalSeen;
  tokenImpl = async (p) => {
    portalSeen = p;
    return TOKEN;
  };
  const r = await post(URL_PATH, { 'x-diagnostic-key': SECRET });
  assert.equal(r.status, 200);
  assert.equal(portalSeen, 247711076);
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, 'https://api.hubapi.com/crm/v3/objects/contacts?limit=1');
  assert.deepEqual(Object.keys(r.json).sort(), ['hubspotRequestOk', 'hubspotStatus', 'message', 'tokenRetrieved']);
  assert.equal(r.json.tokenRetrieved, true);
  assert.equal(r.json.hubspotRequestOk, true);
  assert.equal(r.json.hubspotStatus, 200);
  assert.ok(!r.text.includes(TOKEN) && !r.text.includes(SECRET));
});

test('token failure: no HubSpot call, nothing leaked', async () => {
  tokenImpl = async () => {
    const e = new Error('contains SECRET-ACCESS-TOKEN-12345');
    e.code = 'NOT_CONNECTED';
    throw e;
  };
  const r = await post(URL_PATH, { 'x-diagnostic-key': SECRET });
  assert.equal(r.status, 502);
  assert.deepEqual(r.json, {
    tokenRetrieved: false,
    hubspotRequestOk: false,
    hubspotStatus: null,
    message: 'Could not retrieve a valid token.',
  });
  assert.equal(fetchCalls.length, 0);
  assert.ok(!r.text.includes(TOKEN));
});

test('HubSpot 401: token retrieved, request failed, status reported', async () => {
  fetchImpl = async () => ({ ok: false, status: 401, body: null });
  const r = await post(URL_PATH, { 'x-diagnostic-key': SECRET });
  assert.equal(r.status, 502);
  assert.equal(r.json.tokenRetrieved, true);
  assert.equal(r.json.hubspotRequestOk, false);
  assert.equal(r.json.hubspotStatus, 401);
});

test('HubSpot timeout: safe message, null status', async () => {
  fetchImpl = async () => {
    const e = new Error('The operation was aborted due to timeout');
    e.name = 'TimeoutError';
    throw e;
  };
  const r = await post(URL_PATH, { 'x-diagnostic-key': SECRET });
  assert.equal(r.status, 502);
  assert.equal(r.json.tokenRetrieved, true);
  assert.equal(r.json.hubspotStatus, null);
  assert.match(r.json.message, /timed out/);
});
