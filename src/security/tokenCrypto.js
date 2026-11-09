// src/security/tokenCrypto.js
// Encrypts and decrypts HubSpot OAuth tokens (see Phase 3 plan).
//
// - AES-256-GCM from Node's built-in "crypto" (no extra dependency).
// - A fresh random 12-byte IV for every encryption.
// - Each ciphertext is bound (as GCM "additional authenticated data") to the
//   key version, the HubSpot portal ID and the token field. A ciphertext copied
//   to another portal or field, or tampered with, fails to decrypt.
// - The key comes from TOKEN_ENCRYPTION_KEY (32 random bytes, base64). If it is
//   missing or malformed we throw: there is NO fallback key and NO plaintext mode.
//
// This module never logs anything. Its errors carry a fixed generic message and a
// short code, never a token, key, IV, tag or ciphertext.

const crypto = require('crypto');

const KEY_ENV_VAR = 'TOKEN_ENCRYPTION_KEY';
const TOKEN_FIELDS = Object.freeze(['access_token', 'refresh_token']);
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // recommended size for GCM
const TAG_BYTES = 16;
const DEFAULT_KEY_VERSION = 1;
const AAD_LABEL = 'hubspot-oauth-token';

const MESSAGES = {
  KEY_MISSING: 'Token encryption key is not configured.',
  KEY_INVALID: 'Token encryption key is invalid.',
  INVALID_INPUT: 'Invalid input for token encryption.',
  INVALID_FORMAT: 'Encrypted token has an invalid format.',
  DECRYPT_FAILED: 'Could not decrypt token.',
};

class TokenCryptoError extends Error {
  constructor(code) {
    super(MESSAGES[code] || 'Token crypto error.');
    this.name = 'TokenCryptoError';
    this.code = code;
  }
}

// Reads and validates the encryption key. Returns a NEW 32-byte Buffer.
// "env" is a parameter so tests never need the real environment.
function loadKey(env = process.env) {
  const raw = env ? env[KEY_ENV_VAR] : undefined;
  if (raw === undefined || raw === null || raw === '') throw new TokenCryptoError('KEY_MISSING');
  if (typeof raw !== 'string') throw new TokenCryptoError('KEY_INVALID');

  const key = Buffer.from(raw, 'base64');
  // Canonical check: rejects stray characters, whitespace, missing padding, hex, etc.
  if (key.length !== KEY_BYTES || key.toString('base64') !== raw) {
    throw new TokenCryptoError('KEY_INVALID');
  }
  // Reject obviously weak keys such as 32 identical bytes (all zeros, all 0xFF...).
  if (key.every((byte) => byte === key[0])) throw new TokenCryptoError('KEY_INVALID');
  return key;
}

// Accepts a caller-supplied key (Buffer) or loads it from the environment.
function resolveKey(key) {
  if (key === undefined) return loadKey();
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) throw new TokenCryptoError('KEY_INVALID');
  return key;
}

function validateContext(portalId, field, keyVersion) {
  const portalOk =
    (typeof portalId === 'string' && portalId.length > 0) ||
    (Number.isSafeInteger(portalId) && portalId > 0);
  if (!portalOk) throw new TokenCryptoError('INVALID_INPUT');
  if (!TOKEN_FIELDS.includes(field)) throw new TokenCryptoError('INVALID_INPUT');
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new TokenCryptoError('INVALID_INPUT');
}

// JSON array encoding is unambiguous, so values cannot be shifted between slots.
function buildAad(portalId, field, keyVersion) {
  return Buffer.from(JSON.stringify([AAD_LABEL, keyVersion, String(portalId), field]), 'utf8');
}

const b64u = (buf) => buf.toString('base64url');

// Returns "v<keyVersion>.<iv>.<tag>.<ciphertext>" (base64url parts).
function encryptToken(plaintext, { portalId, field, key, keyVersion = DEFAULT_KEY_VERSION } = {}) {
  validateContext(portalId, field, keyVersion);
  if (typeof plaintext !== 'string' || plaintext.length === 0) throw new TokenCryptoError('INVALID_INPUT');
  const aesKey = resolveKey(key);

  const iv = crypto.randomBytes(IV_BYTES); // fresh for EVERY encryption
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(buildAad(portalId, field, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `v${keyVersion}.${b64u(iv)}.${b64u(tag)}.${b64u(ciphertext)}`;
}

// Parses the stored string strictly. Returns null if it is not well formed.
function parseBlob(blob) {
  if (typeof blob !== 'string') return null;
  const parts = blob.split('.');
  if (parts.length !== 4) return null;
  const [versionPart, ivPart, tagPart, ctPart] = parts;
  const match = /^v([1-9][0-9]{0,8})$/.exec(versionPart);
  if (!match) return null;

  const decodeStrict = (text) => {
    if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
    const buf = Buffer.from(text, 'base64url');
    return buf.toString('base64url') === text ? buf : null;
  };
  const iv = decodeStrict(ivPart);
  const tag = decodeStrict(tagPart);
  const ciphertext = decodeStrict(ctPart);
  if (!iv || !tag || !ciphertext) return null;
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
  return { keyVersion: Number(match[1]), iv, tag, ciphertext };
}

function decryptToken(blob, { portalId, field, key, keyVersion = DEFAULT_KEY_VERSION } = {}) {
  validateContext(portalId, field, keyVersion);
  const aesKey = resolveKey(key);

  const parsed = parseBlob(blob);
  if (!parsed) throw new TokenCryptoError('INVALID_FORMAT');
  if (parsed.keyVersion !== keyVersion) throw new TokenCryptoError('DECRYPT_FAILED');

  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, parsed.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(buildAad(portalId, field, keyVersion));
    decipher.setAuthTag(parsed.tag);
    const plain = Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    // Wrong key, wrong portal/field, or tampering: deliberately indistinguishable.
    throw new TokenCryptoError('DECRYPT_FAILED');
  }
}

module.exports = { loadKey, encryptToken, decryptToken, TokenCryptoError, TOKEN_FIELDS, KEY_ENV_VAR };
