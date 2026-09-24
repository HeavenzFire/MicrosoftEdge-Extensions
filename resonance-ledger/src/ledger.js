// resonance-ledger/src/ledger.js
// Append-only JSONL ledger with hash chaining, replay verification,
// quorum approval workflow, and content-addressed artifact registry.

import fs from 'node:fs';
import path from 'node:path';
import { canonicalize, sha256Prefixed } from './crypto.js';
import { acceptEvent, buildSignedEvent, validateEnvelope } from './envelope.js';

export function initialState({ policy, keyring }) {
  return {
    lamportClock: 0,
    seenEventIds: new Set(),
    lastSequenceByIssuer: {},
    lastEventHash: 'sha256:GENESIS',
    events: [],
    policy,
    keyring, // issuerKeyId -> { publicKey, role, revokedAtUtc? }
  };
}

/** Replay a JSONL ledger file through the reducer to rebuild state deterministically. */
export function replayLedger(filePath, { policy, keyring }) {
  const state = initialState({ policy, keyring });
  const rejections = [];
  if (!fs.existsSync(filePath)) {
    return { state, rejections: [{ reason: 'Ledger file not found — starting empty' }] };
  }
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      rejections.push({ reason: 'Corrupt line (not valid JSON)' });
      continue;
    }
    const result = acceptEvent(record.envelope ?? record, state);
    if (result.accepted) {
      Object.assign(state, result.nextState);
    } else {
      rejections.push({ eventId: record?.envelope?.eventId ?? record?.eventId, reason: result.reason });
    }
  }
  return { state, rejections };
}

/** Append one signed event to the ledger (file is append-only; never rewritten). */
export function appendEvent(filePath, record) {
  if (!validateEnvelope(record.envelope ?? record)) {
    throw new Error('Refusing to append invalid envelope');
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf8');
}

/**
 * Quorum approval: an APPROVAL event satisfies a pending PROPOSAL only if
 * `quorum` distinct authorized approver keys have approved that proposalId,
 * and no approver approves their own proposal (self-approval ban).
 */
export function evaluateQuorum(state, proposalId, proposerKeyId) {
  const approvals = new Set();
  for (const e of state.events) {
    if (e.eventType === 'APPROVAL' && e.payloadRef?.proposalId === proposalId) {
      if (e.issuerKeyId === proposerKeyId) {
        return { satisfied: false, reason: 'Self-approval detected — prohibited by policy', approvals: [...approvals] };
      }
      approvals.add(e.issuerKeyId);
    }
  }
  const required = state.policy?.quorum ?? 1;
  return {
    satisfied: approvals.size >= required,
    approvals: [...approvals],
    required,
    have: approvals.size,
  };
}

/** Register a content-addressed artifact (digest computed over actual bytes). */
export function registerArtifact(artifactDir, name, contentsBuffer) {
  const digest = sha256Prefixed(contentsBuffer.toString('base64'));
  const target = path.join(artifactDir, digest.replace(':', '_'));
  fs.mkdirSync(artifactDir, { recursive: true });
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, contentsBuffer);
  }
  return { name, digest, sizeBytes: contentsBuffer.length, path: target };
}

/** Verify a stored artifact still matches its digest (tamper-evidence check). */
export function verifyArtifact(digest, buffer) {
  return sha256Prefixed(buffer.toString('base64')) === digest;
}

export { buildSignedEvent, canonicalize };
