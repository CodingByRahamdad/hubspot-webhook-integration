// src/google/sheetsErrors.js
// One error class for everything the Google Sheets integration can go wrong with
// (see docs/23). Same idea as TokenServiceError / TokenCryptoError for HubSpot:
//
//   - every error has a FIXED message and a short, safe CODE;
//   - it never carries (or wraps) the original error, a file path, a private key,
//     a token or any credential content;
//   - "retryable" tells the caller whether trying again later could help.
//
// Callers decide what to do from err.code / err.retryable, never from the message.

const ERRORS = {
  CONFIG_MISSING: {
    message: 'Google Sheets is not configured. The service-account key file path is missing.',
    retryable: false,
  },
  CREDENTIALS_FILE_NOT_FOUND: {
    message: 'The Google service-account key file was not found at the configured path.',
    retryable: false,
  },
  CREDENTIALS_FILE_UNREADABLE: {
    message: 'The Google service-account key file could not be read.',
    retryable: false,
  },
  CREDENTIALS_INVALID_JSON: {
    message: 'The Google service-account key file is not valid JSON.',
    retryable: false,
  },
  CREDENTIALS_INVALID: {
    message: 'The Google service-account key file does not look like a service-account key.',
    retryable: false,
  },
  AUTH_FAILED: {
    message: 'Google rejected the service-account authentication.',
    retryable: false,
  },
  AUTH_UNAVAILABLE: {
    message: 'Google authentication is temporarily unavailable.',
    retryable: true,
  },
  SPREADSHEET_ID_MISSING: {
    message: 'Google Sheets is not configured. The spreadsheet ID is missing.',
    retryable: false,
  },
  SPREADSHEET_ID_INVALID: {
    message: 'The configured spreadsheet ID does not look like a Google spreadsheet ID.',
    retryable: false,
  },
  SPREADSHEET_NOT_FOUND: {
    message: 'Google could not find the spreadsheet.',
    retryable: false,
  },
  PERMISSION_DENIED: {
    message: 'Google denied access to the spreadsheet.',
    retryable: false,
  },
  WORKSHEET_NOT_FOUND: {
    message: 'The configured worksheet does not exist in the spreadsheet.',
    retryable: false,
  },
  RATE_LIMITED: {
    message: 'Google is limiting requests right now.',
    retryable: true,
  },
  API_UNAVAILABLE: {
    message: 'The Google Sheets API is temporarily unavailable.',
    retryable: true,
  },
  SHEET_HEADERS_MISMATCH: {
    message: 'The first row of the worksheet does not match the expected contact columns.',
    retryable: false,
  },
  CONTACT_INVALID: {
    message: 'The contact data is not valid.',
    retryable: false,
  },
  CONTACT_NOT_FOUND: {
    message: 'No contact with that Contact ID exists in the worksheet.',
    retryable: false,
  },
  DUPLICATE_CONTACT: {
    message: 'That Contact ID is already in the worksheet, so the request is ambiguous or would create a duplicate.',
    retryable: false,
  },
  UNEXPECTED_RESPONSE: {
    message: 'Google returned a response in an unexpected format.',
    retryable: false,
  },
  INVALID_INPUT: {
    message: 'Invalid input for the Google Sheets integration.',
    retryable: false,
  },
  INTERNAL_ERROR: {
    message: 'Unexpected Google Sheets integration error.',
    retryable: false,
  },
};

const GOOGLE_SHEETS_ERROR_CODES = Object.freeze(Object.keys(ERRORS));

class GoogleSheetsError extends Error {
  // reason: optional short code from a lower layer (for example "ECONNRESET").
  // It is accepted only if it looks like a code, so a message can never sneak in.
  // field: optional NAME of the input that was wrong (for example "email"), never its value.
  constructor(code, { reason = null, field = null } = {}) {
    const info = ERRORS[code] || ERRORS.INTERNAL_ERROR;
    super(info.message);
    this.name = 'GoogleSheetsError';
    this.code = ERRORS[code] ? code : 'INTERNAL_ERROR';
    this.retryable = info.retryable;
    this.reason = typeof reason === 'string' && /^[A-Z0-9_]{1,40}$/.test(reason) ? reason : null;
    this.field = typeof field === 'string' && /^[A-Za-z]{1,30}$/.test(field) ? field : null;
  }
}

// ---------------------------------------------------------------------------
// Classifying failures that come from the Google libraries / network
// ---------------------------------------------------------------------------

// Network-type problems are temporary.
const TEMPORARY_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNABORTED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function shortCode(err) {
  return err && typeof err.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(err.code) ? err.code : null;
}

function isTemporaryNetworkError(err) {
  const code = shortCode(err);
  if (code && TEMPORARY_NETWORK_CODES.has(code)) return true;
  return Boolean(err) && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

// The HTTP status of a Google API failure (gaxios puts it in several places), or null.
function httpStatus(err) {
  if (!err || typeof err !== 'object') return null;
  if (err.response && Number.isInteger(err.response.status)) return err.response.status;
  if (Number.isInteger(err.status)) return err.status;
  if (Number.isInteger(err.code)) return err.code;
  if (typeof err.code === 'string' && /^[1-5][0-9]{2}$/.test(err.code)) return Number(err.code);
  return null;
}

// Google reports quota problems with 403 and a "reason" such as "rateLimitExceeded".
// Only used to CHOOSE a code; the text itself is never kept.
function looksRateLimited(err) {
  const reasons = [];
  if (Array.isArray(err.errors)) reasons.push(...err.errors.map((e) => e && e.reason));
  const data = err.response && err.response.data && err.response.data.error;
  if (data && Array.isArray(data.errors)) reasons.push(...data.errors.map((e) => e && e.reason));
  return reasons.some((r) => typeof r === 'string' && /rate|quota/i.test(r));
}

// Turns anything thrown while calling the Sheets API into a safe GoogleSheetsError.
// Uses only the HTTP status and short codes: never the message text, which can quote
// the account email, the spreadsheet ID or other details.
function classifyApiError(err) {
  if (err instanceof GoogleSheetsError) return err;
  const reason = shortCode(err);
  const status = httpStatus(err);

  if (status === 401) return new GoogleSheetsError('AUTH_FAILED', { reason });
  if (status === 403) {
    return new GoogleSheetsError(looksRateLimited(err) ? 'RATE_LIMITED' : 'PERMISSION_DENIED', { reason });
  }
  if (status === 404) return new GoogleSheetsError('SPREADSHEET_NOT_FOUND', { reason });
  if (status === 400) return new GoogleSheetsError('INVALID_INPUT', { reason });
  if (status === 429) return new GoogleSheetsError('RATE_LIMITED', { reason });
  if ((status !== null && status >= 500) || isTemporaryNetworkError(err)) {
    return new GoogleSheetsError('API_UNAVAILABLE', { reason });
  }
  return new GoogleSheetsError('INTERNAL_ERROR', { reason });
}

module.exports = { GoogleSheetsError, GOOGLE_SHEETS_ERROR_CODES, classifyApiError, isTemporaryNetworkError };
