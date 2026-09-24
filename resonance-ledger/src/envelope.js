// resonance-ledger/src/envelope.js
// Signed, append-only event envelope: schema validation, replay protection,
// issuer authorization, per-issuer monotonic sequence, Lamport clock.

import { randomUUID } from 'node:crypto';
import { canonicalize, sha256Prefixed, signObject, verifyWithPublicKey } from './crypto.js';

export const SCHEMA_VERSION = 1;

const REQUIRED_FIELDS = [
  'schemaVersion', 'eventId', 'eventType', 'issuerKeyId', 'issuerSequence',
  'lamportClock', 'observedAtUtc', 'previousEventHash', 'payloadHash',
  'policyVersion', 'signatureAlgorithm', 'signature',
];

/**
 * Accept an event into ledger state, or reject with a reason.
 * This is the deterministic reducer guard — it mutates nothing.
 */
export function acceptEvent(event, state) {
  if (!validateEnvelope(event)) {
    return { accepted: false, reason: 'Invalid event schema' };
  }

  // Payload integrity: recomputed hash must match the signed payloadHash.
  if (event.payload !== undefined) {
    const expected = sha256Prefixed(canonicalize(event.payload));
    if (expected !== event.payloadHash) {
      return { accepted: false, reason: 'Payload does not match signed payloadHash' };
    }
  }

  // Replay check first: a duplicate eventId is rejected regardless of chain position.
  if (state.seenEventIds.has(event.eventId)) {
    return { accepted: false, reason: 'Replay detected (duplicate eventId)' };
  }

  const key = state.keyring[event.issuerKeyId];
  if (!key) {
    return { accepted: false, reason: 'Unknown issuer key (not in keyring)' };
  }
  if (key.revokedAtUtc) {
    // Revoked keys may not produce NEW events, but historical events remain valid evidence.
    const eventTime = Date.parse(event.observedAtUtc);
    const revokedTime = Date.parse(key.revokedAtUtc);
    if (!Number.isNaN(eventTime) && !Number.isNaN(revokedTime) && eventTime > revokedTime) {
      return { accepted: false, reason: 'Issuer key revoked before this event was issued' };
    }
  }

  if (!verifyWithPublicKey(event, key.publicKey)) {
    return { accepted: false, reason: 'Signature verification failed' };
  }

  if (!isAuthorizedIssuer(key.role, event.eventType, state.policy)) {
    return { accepted: false, reason: `Role '${key.role}' lacks authority for ${event.eventType}` };
  }

  if (state.seenEventIds.has(event.eventId)) {
    return { accepted: false, reason: 'Replay detected (duplicate eventId)' };
  }

  const previousSequence = state.lastSequenceByIssuer[event.issuerKeyId] ?? 0;
  if (event.issuerSequence <= previousSequence) {
    return { accepted: false, reason: 'Non-monotonic issuer sequence' };
  }

  // Hash-chain continuity is enforced for ALL authenticated events: an event may
  // only be appended at the current ledger head (prevents history rewrite/reorder).
  if (event.previousEventHash !== state.lastEventHash) {
    return { accepted: false, reason: 'previousEventHash does not match ledger head (hash chain break)' };
  }

  // payloadRef (used by APPROVAL events) must match its signed hash.
  if (event.payloadRef !== undefined) {
    const expected = sha256Prefixed(canonicalize(event.payloadRef));
    if (expected !== event.payloadHash) {
      return { accepted: false, reason: 'payloadRef does not match signed payloadHash' };
    }
  }

  if (typeof event.lamportClock !== 'number' || event.lamportClock < 0) {
    return { accepted: false, reason: 'Invalid Lamport clock value' };
  }

  const nextLamport = Math.max(state.lamportClock, event.lamportClock) + 1;

  return {
    accepted: true,
    nextState: {
      ...state,
      lamportClock: nextLamport,
      seenEventIds: new Set([...state.seenEventIds, event.eventId]),
      lastSequenceByIssuer: {
        ...state.lastSequenceByIssuer,
        [event.issuerKeyId]: event.issuerSequence,
      },
      lastEventHash: sha256Prefixed(canonicalize(event)),
      events: [...state.events, event],
    },
  };
}

export function validateEnvelope(event) {
  if (!event || typeof event !== 'object') return false;
  for (const f of REQUIRED_FIELDS) {
    if (!(f in event)) return false;
  }
  if (event.schemaVersion !== SCHEMA_VERSION) return false;
  if (event.signatureAlgorithm !== 'Ed25519') return false;
  if (typeof event.eventId !== 'string' || event.eventId.length < 8) return false;
  if (typeof event.issuerSequence !== 'number' || !Number.isInteger(event.issuerSequence) || event.issuerSequence < 1) return false;
  if (typeof event.lamportClock !== 'number' || !Number.isInteger(event.lamportClock)) return false;
  if (typeof event.payloadHash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(event.payloadHash)) return false;
  if (isNaN(Date.parse(event.observedAtUtc))) return false;
  return true;
}

export function isAuthorizedIssuer(role, eventType, policy) {
  const grants = policy?.roleGrants?.[role];
  if (!grants) return false;
  return grants.includes('*') || grants.includes(eventType);
}

/**
 * Build and sign an event envelope. The caller must supply payload;
 * payloadHash is computed here so signer and verifier agree.
 */
export function buildSignedEvent({ payload, eventType, issuerKeyId, secretKeyB64url, publicKeyB64url, role, issuerSequence, lamportClock, previousEventHash, policyVersion }) {
  const unsignedBody = {
    schemaVersion: SCHEMA_VERSION,
    eventId: randomUUID(),
    eventType,
    issuerKeyId,
    issuerSequence,
    lamportClock,
    observedAtUtc: new Date().toISOString(),
    previousEventHash: previousEventHash ?? 'sha256:GENESIS',
    payloadHash: sha256Prefixed(canonicalize(payload)),
    policyVersion,
    signatureAlgorithm: 'Ed25519',
  };
  const signature = signObject(unsignedBody, secretKeyB64url);
  return { envelope: { ...unsignedBody, signature }, payload };
}
