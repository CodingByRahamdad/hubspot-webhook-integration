// tests/sheets-errors.test.js
//
// Tests src/google/sheetsErrors.js (Phase 2, step 4).
// No network, no files, no environment: pure unit tests.
//
// Run with:  node --test tests/sheets-errors.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GoogleSheetsError,
  GOOGLE_SHEETS_ERROR_CODES,
  classifyApiError,
  isTemporaryNetworkError,
} = require('../src/google/sheetsErrors');

test('every code gives a GoogleSheetsError with a fixed, non-empty message', () => {
  assert.ok(GOOGLE_SHEETS_ERROR_CODES.length > 0);
  for (const code of GOOGLE_SHEETS_ERROR_CODES) {
    const err = new GoogleSheetsError(code);
    assert.ok(err instanceof Error);
    assert.ok(err instanceof GoogleSheetsError);
    assert.equal(err.name, 'GoogleSheetsError');
    assert.equal(err.code, code);
    assert.equal(typeof err.message, 'string');
    assert.ok(err.message.length > 10);
    assert.equal(typeof err.retryable, 'boolean');
  }
});

test('only temporary problems are retryable', () => {
  const retryable = new Set(['AUTH_UNAVAILABLE', 'RATE_LIMITED', 'API_UNAVAILABLE']);
  for (const code of GOOGLE_SHEETS_ERROR_CODES) {
    assert.equal(new GoogleSheetsError(code).retryable, retryable.has(code), code);
  }
});

test('the codes used by the client and the contacts service exist and are not retryable', () => {
  for (const code of ['SHEET_HEADERS_MISMATCH', 'CONTACT_INVALID', 'CONTACT_NOT_FOUND', 'DUPLICATE_CONTACT', 'UNEXPECTED_RESPONSE']) {
    assert.ok(GOOGLE_SHEETS_ERROR_CODES.includes(code), code);
    assert.equal(new GoogleSheetsError(code).retryable, false, code);
  }
});

test('a field name is kept only if it is a plain word (a value can never sneak in through it)', () => {
  assert.equal(new GoogleSheetsError('CONTACT_INVALID', { field: 'email' }).field, 'email');
  assert.equal(new GoogleSheetsError('CONTACT_INVALID', { field: 'bad@example.com' }).field, null);
  assert.equal(new GoogleSheetsError('CONTACT_INVALID', { field: 'two words' }).field, null);
  assert.equal(new GoogleSheetsError('CONTACT_INVALID', { field: 'x'.repeat(31) }).field, null);
  assert.equal(new GoogleSheetsError('CONTACT_INVALID', { field: 7 }).field, null);
  assert.equal(new GoogleSheetsError('CONTACT_INVALID').field, null);
  assert.equal(new GoogleSheetsError('CONTACT_INVALID', { field: 'email' }).message, new GoogleSheetsError('CONTACT_INVALID').message);
});

test('the codes used by the connection status check exist', () => {
  for (const code of [
    'SPREADSHEET_ID_MISSING',
    'SPREADSHEET_ID_INVALID',
    'SPREADSHEET_NOT_FOUND',
    'PERMISSION_DENIED',
    'WORKSHEET_NOT_FOUND',
    'RATE_LIMITED',
    'API_UNAVAILABLE',
  ]) {
    assert.ok(GOOGLE_SHEETS_ERROR_CODES.includes(code), code);
  }
});

// --- classifyApiError --------------------------------------------------------------

const SECRET = 'secret-spreadsheet-id-1234567890 fake-sa@fake-project.iam.gserviceaccount.com';
const apiError = (status, extra = {}) =>
  Object.assign(new Error(`Request failed for ${SECRET}`), { response: { status }, ...extra });

test('classifyApiError maps HTTP statuses to codes', () => {
  const table = [
    [400, 'INVALID_INPUT'],
    [401, 'AUTH_FAILED'],
    [403, 'PERMISSION_DENIED'],
    [404, 'SPREADSHEET_NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'API_UNAVAILABLE'],
    [503, 'API_UNAVAILABLE'],
    [418, 'INTERNAL_ERROR'],
  ];
  for (const [status, code] of table) {
    assert.equal(classifyApiError(apiError(status)).code, code, String(status));
  }
});

test('classifyApiError finds the status in the other places the Google library puts it', () => {
  assert.equal(classifyApiError(Object.assign(new Error('x'), { status: 404 })).code, 'SPREADSHEET_NOT_FOUND');
  assert.equal(classifyApiError(Object.assign(new Error('x'), { code: 403 })).code, 'PERMISSION_DENIED');
  assert.equal(classifyApiError(Object.assign(new Error('x'), { code: '429' })).code, 'RATE_LIMITED');
});

test('classifyApiError: a 403 with a rate/quota reason is RATE_LIMITED', () => {
  assert.equal(classifyApiError(apiError(403, { errors: [{ reason: 'rateLimitExceeded' }] })).code, 'RATE_LIMITED');
  assert.equal(
    classifyApiError(apiError(403, { response: { status: 403, data: { error: { errors: [{ reason: 'quotaExceeded' }] } } } })).code,
    'RATE_LIMITED'
  );
  assert.equal(classifyApiError(apiError(403, { errors: [{ reason: 'forbidden' }] })).code, 'PERMISSION_DENIED');
});

test('classifyApiError: network problems and timeouts are API_UNAVAILABLE (retryable)', () => {
  for (const code of ['ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EAI_AGAIN']) {
    const err = classifyApiError(Object.assign(new Error('x'), { code }));
    assert.equal(err.code, 'API_UNAVAILABLE', code);
    assert.equal(err.retryable, true);
  }
  assert.equal(classifyApiError(Object.assign(new Error('x'), { name: 'TimeoutError' })).code, 'API_UNAVAILABLE');
  assert.equal(isTemporaryNetworkError(Object.assign(new Error('x'), { name: 'AbortError' })), true);
  assert.equal(isTemporaryNetworkError(new Error('x')), false);
  assert.equal(isTemporaryNetworkError(null), false);
});

test('classifyApiError never keeps the original message, and passes our own errors through', () => {
  for (const thrown of [apiError(404), apiError(403), apiError(503), 'a string', 42, null, undefined, {}]) {
    const err = classifyApiError(thrown);
    assert.ok(err instanceof GoogleSheetsError);
    const text = [err.message, err.stack, JSON.stringify(err)].join('\n');
    assert.ok(!text.includes('secret-spreadsheet-id'), 'no spreadsheet ID');
    assert.ok(!text.includes('fake-sa@'), 'no e-mail address');
  }
  const own = new GoogleSheetsError('WORKSHEET_NOT_FOUND');
  assert.equal(classifyApiError(own), own);
});

test('an unknown code becomes INTERNAL_ERROR', () => {
  const err = new GoogleSheetsError('SOMETHING_ELSE');
  assert.equal(err.code, 'INTERNAL_ERROR');
  assert.equal(err.retryable, false);
});

test('the message does not depend on the reason', () => {
  const plain = new GoogleSheetsError('AUTH_FAILED');
  const withReason = new GoogleSheetsError('AUTH_FAILED', { reason: 'ECONNRESET' });
  assert.equal(plain.message, withReason.message);
  assert.equal(withReason.reason, 'ECONNRESET');
  assert.equal(plain.reason, null);
});

test('a reason is kept only if it looks like a short code (no messages can sneak in)', () => {
  assert.equal(new GoogleSheetsError('AUTH_FAILED', { reason: 'invalid_grant: private key abc' }).reason, null);
  assert.equal(new GoogleSheetsError('AUTH_FAILED', { reason: 'has spaces' }).reason, null);
  assert.equal(new GoogleSheetsError('AUTH_FAILED', { reason: 'x'.repeat(41) }).reason, null);
  assert.equal(new GoogleSheetsError('AUTH_FAILED', { reason: 42 }).reason, null);
  assert.equal(new GoogleSheetsError('AUTH_FAILED', { reason: 'ENOENT' }).reason, 'ENOENT');
});

test('messages never contain paths, keys or tokens', () => {
  for (const code of GOOGLE_SHEETS_ERROR_CODES) {
    const { message } = new GoogleSheetsError(code);
    assert.doesNotMatch(message, /BEGIN|PRIVATE KEY|Bearer|[A-Za-z]:\\|\/etc\/|\.json/i, code);
  }
});

test('the error list is frozen so it cannot be changed by accident', () => {
  assert.ok(Object.isFrozen(GOOGLE_SHEETS_ERROR_CODES));
});
