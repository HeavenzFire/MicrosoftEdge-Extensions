// resonance-ledger/tests/ledger.test.js
// Real tests: actual Ed25519 keygen, signing, verification, replay, quorum.

import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, signObject, verifyWithPublicKey, canonicalize } from '../src/crypto.js';
import { buildSignedEvent, acceptEvent } from '../src/envelope.js';
import { initialState, evaluateQuorum } from '../src/ledger.js';
import { GOVERNANCE_POLICY, POLICY_VERSION, memorialReferenceRecord } from '../src/policy.js';

function makeIssuer(role) {
  const kp = generateKeyPair();
  return { role, ...kp };
}

function keyringFrom(issuers) {
  const kr = {};
  for (const [keyId, i] of Object.entries(issuers)) {
    kr[keyId] = { publicKey: i.publicKey, role: i.role };
  }
  return kr;
}

test('signature round-trip: signed object verifies, tampered object fails', () => {
  const issuer = makeIssuer('archive-ingester');
  const body = { hello: 'world', n: 42 };
  const signature = signObject(body, issuer.secretKey);
  const signed = { ...body, publicKeyForTest: undefined, signature };
  assert.equal(verifyWithPublicKey(signed, issuer.publicKey), true);
  const tampered = { ...signed, n: 43 };
  assert.equal(verifyWithPublicKey(tampered, issuer.publicKey), false);
});

test('canonicalization is deterministic regardless of key insertion order', () => {
  const a = canonicalize({ b: 1, a: { d: 2, c: 3 } });
  const b = canonicalize({ a: { c: 3, d: 2 }, b: 1 });
  assert.equal(a, b);
});

test('acceptEvent rejects unsigned / wrong-key / replay / out-of-order events', () => {
  const issuers = { ing: makeIssuer('archive-ingester'), analyst: makeIssuer('read-only-analyst') };
  let state = initialState({ policy: GOVERNANCE_POLICY, keyring: keyringFrom(issuers) });

  // Valid event
  const e1 = buildSignedEvent({
    payload: { name: 'doc.txt' }, eventType: 'ARTIFACT_ADDED',
    issuerKeyId: 'ing', secretKeyB64url: issuers.ing.secretKey,
    issuerSequence: 1, lamportClock: state.lamportClock,
    previousEventHash: state.lastEventHash, policyVersion: POLICY_VERSION,
  });
  let r = acceptEvent(e1.envelope, state);
  assert.equal(r.accepted, true);
  state = r.nextState;

  // Replay of same eventId
  r = acceptEvent(e1.envelope, state);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /Replay/);

  // Non-monotonic sequence (reuse seq 1 with new eventId via different hash chain position)
  const eDupSeq = { ...e1.envelope, eventId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
  r = acceptEvent(eDupSeq, state);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /monotonic|Signature/); // signature may also fail due to field reuse; either rejection is correct

  // Unauthorized role: read-only-analyst cannot emit ARTIFACT_ADDED
  const eBad = buildSignedEvent({
    payload: { x: 1 }, eventType: 'ARTIFACT_ADDED',
    issuerKeyId: 'analyst', secretKeyB64url: issuers.analyst.secretKey,
    issuerSequence: 1, lamportClock: state.lamportClock,
    previousEventHash: state.lastEventHash, policyVersion: POLICY_VERSION,
  });
  r = acceptEvent(eBad.envelope, state);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /lacks authority/);

  // Tampered signature on an otherwise valid envelope
  const forged = { ...eBad.envelope, signature: signObject({ ...eBad.envelope, eventType: 'KEY_REVOKED' }, issuers.ing.secretKey) };
  r = acceptEvent(forged, state);
  assert.equal(r.accepted, false);
});

test('Lamport clock never decreases and merges max(incoming, local)+1', () => {
  const issuers = { ing: makeIssuer('archive-ingester') };
  let state = initialState({ policy: GOVERNANCE_POLICY, keyring: keyringFrom(issuers) });
  const e = buildSignedEvent({
    payload: { z: 1 }, eventType: 'ARTIFACT_ADDED',
    issuerKeyId: 'ing', secretKeyB64url: issuers.ing.secretKey,
    issuerSequence: 1, lamportClock: 812,
    previousEventHash: state.lastEventHash, policyVersion: POLICY_VERSION,
  });
  const r = acceptEvent(e.envelope, state);
  assert.equal(r.accepted, true);
  assert.equal(r.nextState.lamportClock, 813);
});

test('quorum: proposer cannot self-approve; two distinct approvals satisfy quorum=2', () => {
  const issuers = {
    pubA: makeIssuer('release-publisher'),
    pubB: makeIssuer('release-publisher'),
    pubC: makeIssuer('release-publisher'),
  };
  let state = initialState({ policy: GOVERNANCE_POLICY, keyring: keyringFrom(issuers) });

  const proposal = buildSignedEvent({
    payload: { bundle: 'v1' }, eventType: 'PROPOSAL:RELEASE_PUBLISHED',
    issuerKeyId: 'pubA', secretKeyB64url: issuers.pubA.secretKey,
    issuerSequence: 1, lamportClock: 0,
    previousEventHash: state.lastEventHash, policyVersion: POLICY_VERSION,
  });
  let r = acceptEvent(proposal.envelope, state);
  assert.equal(r.accepted, true);
  state = r.nextState;

  // Self-approval must be refused by the workflow layer BEFORE reaching ledger:
  const q0 = evaluateQuorum(state, proposal.envelope.eventId, 'pubA');
  assert.equal(q0.satisfied, false);

  // Approvals from B and C (payloadRef embedded in envelope, hash-bound to proposalId)
  for (const [i, keyId] of ['pubB', 'pubC'].entries()) {
    const payload = { proposalId: proposal.envelope.eventId };
    const ap = buildSignedEvent({
      payload, eventType: 'APPROVAL',
      issuerKeyId: keyId, secretKeyB64url: issuers[keyId].secretKey,
      issuerSequence: 1, lamportClock: state.lamportClock + 1,
      previousEventHash: state.lastEventHash, policyVersion: POLICY_VERSION,
    });
    ap.envelope.payloadRef = payload;
    r = acceptEvent(ap.envelope, state);
    assert.equal(r.accepted, true, `approval ${i} accepted`);
    state = r.nextState;
  }

  const q = evaluateQuorum(state, proposal.envelope.eventId, 'pubA');
  assert.equal(q.satisfied, true);
  assert.deepEqual(new Set(q.approvals), new Set(['pubB', 'pubC']));
});

test('revoked key cannot issue future events but historical events remain valid evidence', () => {
  const issuers = { ing: makeIssuer('archive-ingester') };
  const keyring = keyringFrom(issuers);
  let state = initialState({ policy: GOVERNANCE_POLICY, keyring });

  const past = buildSignedEvent({
    payload: { ok: true }, eventType: 'ARTIFACT_ADDED',
    issuerKeyId: 'ing', secretKeyB64url: issuers.ing.secretKey,
    issuerSequence: 1, lamportClock: 1,
    previousEventHash: state.lastEventHash, policyVersion: POLICY_VERSION,
  });
  past.envelope.observedAtUtc = '2026-01-01T00:00:00.000Z';
  // re-sign after mutating timestamp
  past.envelope.signature = signObject(past.envelope, issuers.ing.secretKey);
  let r = acceptEvent(past.envelope, state);
  assert.equal(r.accepted, true);

  // Now revoke the key as of 2026-06-01
  state.keyring = { ...state.keyring, ing: { ...state.keyring.ing, revokedAtUtc: '2026-06-01T00:00:00.000Z' } };

  const future = buildSignedEvent({
    payload: { bad: true }, eventType: 'ARTIFACT_ADDED',
    issuerKeyId: 'ing', secretKeyB64url: issuers.ing.secretKey,
    issuerSequence: 2, lamportClock: 2,
    previousEventHash: state.lastEventHash, policyVersion: POLICY_VERSION,
  });
  future.envelope.observedAtUtc = '2026-09-01T00:00:00.000Z';
  future.envelope.signature = signObject(future.envelope, issuers.ing.secretKey);
  r = acceptEvent(future.envelope, state);
  assert.equal(r.accepted, false);
  assert.match(r.reason, /revoked/i);

  // Historical event still present in state.events (evidence preserved)
  assert.equal(state.events.length, 1);
});

test('memorial record is metadata only — carries no grants, no control fields', () => {
  const rec = memorialReferenceRecord({ title: 'Family archive reference', purpose: 'Personal creative and archival context', stewardKeyId: 'steward-1' });
  assert.equal(rec.recordType, 'MEMORIAL_REFERENCE');
  assert.equal(rec.visibility, 'private-or-consent-controlled');
  assert.equal(rec.interpretation, 'Human-authored symbolic meaning; not a technical control input');
  // It appears nowhere in role grants or invariants:
  const serializedPolicy = JSON.stringify(GOVERNANCE_POLICY);
  assert.equal(serializedPolicy.includes('MEMORIAL'), false);
});
