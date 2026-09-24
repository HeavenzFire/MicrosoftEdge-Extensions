// resonance-ledger/src/crypto.js
// Real Ed25519 signing/verification + canonical JSON serialization.
// No simulation: signatures produced here are verifiable by any standard
// Ed25519 implementation (RFC 8032).

import * as crypto from 'node:crypto';
import * as ed25519 from '@noble/ed25519';

// Node's synchronous sha512 is not exposed via webcrypto.subtle, so bind it directly.
ed25519.etc.sha512Sync = (...m) =>
  crypto.createHash('sha512').update(Buffer.concat(m)).digest();

/**
 * RFC 8785-style canonical JSON: sorted keys, no insignificant whitespace,
 * deterministic UTF-8. Required so signers and verifiers hash identical bytes.
 */
export function canonicalize(obj) {
  return stableStringify(obj);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    if (value[k] === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(value[k]));
  }
  return '{' + parts.join(',') + '}';
}

export function sha256Hex(input) {
  const data = typeof input === 'string' ? input : canonicalize(input);
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

export function sha256Prefixed(input) {
  return 'sha256:' + sha256Hex(input);
}

/** Generate a new Ed25519 keypair. Returns base64url-encoded material. */
export function generateKeyPair() {
  const privRaw = ed25519.utils.randomPrivateKey();
  const pubRaw = ed25519.getPublicKey(privRaw);
  return {
    algorithm: 'Ed25519',
    secretKey: b64url(privRaw),
    publicKey: b64url(pubRaw),
  };
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function unb64url(s) {
  return Uint8Array.from(Buffer.from(s, 'base64url'));
}

/** Sign canonical bytes of an object (excluding its own `signature` field). */
export function signObject(obj, secretKeyB64url) {
  const payload = { ...obj };
  delete payload.signature;
  const bytes = Buffer.from(canonicalize(payload), 'utf8');
  const sig = ed25519.sign(bytes, unb64url(secretKeyB64url));
  return b64url(sig);
}

/** Verify signature over canonical bytes of an object (excluding `signature`). */
export function verifySignedObject(signedObj) {
  const { signature, ...rest } = signedObj;
  if (typeof signature !== 'string') return false;
  try {
    const bytes = Buffer.from(canonicalize(rest), 'utf8');
    return ed25519.verify(unb64url(signature), bytes, unb64url(rest.publicKey ?? rest.issuerPublicKey ?? ''));
  } catch {
    return false;
  }
}

/** Verify against an explicitly supplied public key (preferred path). */
export function verifyWithPublicKey(signedObj, publicKeyB64url) {
  const { signature, ...rest } = signedObj;
  if (typeof signature !== 'string' || typeof publicKeyB64url !== 'string') return false;
  try {
    const bytes = Buffer.from(canonicalize(rest), 'utf8');
    return ed25519.verify(unb64url(signature), bytes, unb64url(publicKeyB64url));
  } catch {
    return false;
  }
}
