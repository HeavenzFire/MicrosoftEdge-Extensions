#!/usr/bin/env node
// resonance-ledger/src/cli.js
// Real operating CLI for the Resonance Ledger. Everything here performs
// actual Ed25519 signing/verification and actual append-only ledger writes.
//
// Usage:
//   node src/cli.js keygen <role> [--name <keyId>]
//   node src/cli.js init
//   node src/cli.js add-artifact <path>            (archive-ingester)
//   node src/cli.js propose <eventType> <jsonPayload>
//   node src/cli.js approve <proposalEventId>
//   node src/cli.js publish <proposalEventId>      (requires quorum)
//   node src/cli.js verify                          (replay + signature check)
//   node src/cli.js status
//
// Keys live in ./keys (gitignored). Ledger lives in ./data/ledger.jsonl.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPair, canonicalize, sha256Prefixed } from './crypto.js';
import { buildSignedEvent, acceptEvent } from './envelope.js';
import { initialState, replayLedger, appendEvent, evaluateQuorum, registerArtifact } from './ledger.js';
import { GOVERNANCE_POLICY, POLICY_VERSION, memorialReferenceRecord } from './policy.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, '..', 'data');
const KEYS_DIR = path.join(ROOT, '..', 'keys');
const LEDGER = path.join(DATA_DIR, 'ledger.jsonl');
const KEYRING_FILE = path.join(DATA_DIR, 'keyring.json');
const ACTIVE_KEY = path.join(KEYS_DIR, 'active.json');

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(KEYS_DIR, { recursive: true });
}

function loadKeyring() {
  if (!fs.existsSync(KEYRING_FILE)) return {};
  return JSON.parse(fs.readFileSync(KEYRING_FILE, 'utf8'));
}

function saveKeyring(kr) {
  ensureDirs();
  fs.writeFileSync(KEYRING_FILE, JSON.stringify(kr, null, 2));
}

function loadActiveKey() {
  if (!fs.existsSync(ACTIVE_KEY)) {
    throw new Error('No active key. Run: node src/cli.js keygen <role>');
  }
  return JSON.parse(fs.readFileSync(ACTIVE_KEY, 'utf8'));
}

function freshState() {
  const { state } = replayLedger(LEDGER, { policy: GOVERNANCE_POLICY, keyring: loadKeyring() });
  return state;
}

const [cmd, ...args] = process.argv.slice(2);

switch (cmd) {
  case 'keygen': {
    ensureDirs();
    const role = args[0];
    if (!role || !(role in GOVERNANCE_POLICY.roleGrants)) {
      console.error(`Unknown role '${role ?? ''}'. Valid roles: ${Object.keys(GOVERNANCE_POLICY.roleGrants).join(', ')}`);
      process.exit(1);
    }
    const nameIdx = args.indexOf('--name');
    const keyId = nameIdx >= 0 ? args[nameIdx + 1] : `${role}-${Date.now().toString(36)}`;
    const kp = generateKeyPair();
    fs.writeFileSync(path.join(KEYS_DIR, `${keyId}.json`), JSON.stringify({ keyId, role, ...kp }, null, 2), { mode: 0o600 });
    const kr = loadKeyring();
    kr[keyId] = { publicKey: kp.publicKey, role };
    saveKeyring(kr);
    fs.writeFileSync(ACTIVE_KEY, JSON.stringify({ keyId, role }));
    // Emit a signed KEY_REGISTERED event via steward gateway requirement: only allowed if current active key holds that grant
    console.log(`Generated Ed25519 key '${keyId}' (role: ${role}). Active key set.`);
    break;
  }

  case 'init': {
    ensureDirs();
    if (!fs.existsSync(LEDGER)) fs.writeFileSync(LEDGER, '');
    console.log(`Ledger initialized at ${LEDGER}`);
    console.log(`Policy version: ${POLICY_VERSION}, quorum: ${GOVERNANCE_POLICY.quorum}`);
    break;
  }

  case 'add-artifact': {
    const file = args[0];
    if (!file || !fs.existsSync(file)) {
      console.error('Usage: add-artifact <path-to-file>');
      process.exit(1);
    }
    const active = loadActiveKey();
    const keyId = active.keyId;
    const keyFile = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, `${keyId}.json`), 'utf8'));
    const buf = fs.readFileSync(file);
    const art = registerArtifact(path.join(DATA_DIR, 'artifacts'), path.basename(file), buf);
    const state = freshState();
    const seq = (state.lastSequenceByIssuer[keyId] ?? 0) + 1;
    const { envelope, payload } = buildSignedEvent({
      payload: art,
      eventType: 'ARTIFACT_ADDED',
      issuerKeyId: keyId,
      secretKeyB64url: keyFile.secretKey,
      issuerSequence: seq,
      lamportClock: state.lamportClock,
      previousEventHash: state.lastEventHash,
      policyVersion: POLICY_VERSION,
    });
    const result = acceptEvent(envelope, state);
    if (!result.accepted) {
      console.error(`Rejected: ${result.reason}`);
      process.exit(1);
    }
    appendEvent(LEDGER, { envelope, payload });
    console.log(`Artifact registered and event appended.`);
    console.log(`  digest: ${art.digest}`);
    console.log(`  eventId: ${envelope.eventId}`);
    break;
  }

  case 'propose': {
    const [eventType, payloadJson] = args;
    if (!eventType || !payloadJson) {
      console.error('Usage: propose <eventType> \'<jsonPayload>\'');
      process.exit(1);
    }
    const payload = JSON.parse(payloadJson);
    const active = loadActiveKey();
    const keyId = active.keyId;
    const keyFile = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, `${keyId}.json`), 'utf8'));
    const state = freshState();
    const seq = (state.lastSequenceByIssuer[keyId] ?? 0) + 1;
    const { envelope, payload: p } = buildSignedEvent({
      payload,
      eventType: `PROPOSAL:${eventType}`,
      issuerKeyId: keyId,
      secretKeyB64url: keyFile.secretKey,
      issuerSequence: seq,
      lamportClock: state.lamportClock,
      previousEventHash: state.lastEventHash,
      policyVersion: POLICY_VERSION,
    });
    const result = acceptEvent(envelope, state);
    if (!result.accepted) {
      console.error(`Rejected: ${result.reason}`);
      process.exit(1);
    }
    appendEvent(LEDGER, { envelope, payload: p });
    console.log(`Proposal recorded. proposalEventId=${envelope.eventId}`);
    console.log(`Next: other authorized keys run \`approve ${envelope.eventId}\`, then \`publish ${envelope.eventId}\`.`);
    break;
  }

  case 'approve': {
    const proposalId = args[0];
    if (!proposalId) { console.error('Usage: approve <proposalEventId>'); process.exit(1); }
    const active = loadActiveKey();
    const keyId = active.keyId;
    const keyFile = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, `${keyId}.json`), 'utf8'));
    const state = freshState();
    const proposal = state.events.find((e) => e.eventId === proposalId);
    if (!proposal) { console.error('Unknown proposal id in ledger.'); process.exit(1); }
    if (proposal.issuerKeyId === keyId) {
      console.error('Policy violation refused: proposer cannot approve own proposal.');
      process.exit(1);
    }
    const seq = (state.lastSequenceByIssuer[keyId] ?? 0) + 1;
    const { envelope, payload } = buildSignedEvent({
      payload: { proposalId, targetEventType: proposal.eventType },
      eventType: 'APPROVAL',
      issuerKeyId: keyId,
      secretKeyB64url: keyFile.secretKey,
      issuerSequence: seq,
      lamportClock: state.lamportClock,
      previousEventHash: state.lastEventHash,
      policyVersion: POLICY_VERSION,
    });
    const result = acceptEvent(envelope, state);
    if (!result.accepted) { console.error(`Rejected: ${result.reason}`); process.exit(1); }
    appendEvent(LEDGER, { envelope, payload });
    const q = evaluateQuorum(result.nextState, proposalId, proposal.issuerKeyId);
    console.log(`Approval recorded. Quorum: ${q.have}/${q.required} ${q.satisfied ? '(SATISFIED)' : ''}`);
    break;
  }

  case 'publish': {
    const proposalId = args[0];
    if (!proposalId) { console.error('Usage: publish <proposalEventId>'); process.exit(1); }
    const active = loadActiveKey();
    const keyId = active.keyId;
    const keyFile = JSON.parse(fs.readFileSync(path.join(KEYS_DIR, `${keyId}.json`), 'utf8'));
    const state = freshState();
    const proposal = state.events.find((e) => e.eventId === proposalId);
    if (!proposal) { console.error('Unknown proposal id.'); process.exit(1); }
    const q = evaluateQuorum(state, proposalId, proposal.issuerKeyId);
    if (!q.satisfied) {
      console.error(`Cannot publish: quorum not satisfied (${q.have}/${q.required}). ${q.reason ?? ''}`);
      process.exit(1);
    }
    const seq = (state.lastSequenceByIssuer[keyId] ?? 0) + 1;
    const { envelope, payload } = buildSignedEvent({
      payload: { proposalId, approved: q.approvals },
      eventType: 'RELEASE_PUBLISHED',
      issuerKeyId: keyId,
      secretKeyB64url: keyFile.secretKey,
      issuerSequence: seq,
      lamportClock: state.lamportClock,
      previousEventHash: state.lastEventHash,
      policyVersion: POLICY_VERSION,
    });
    const result = acceptEvent(envelope, state);
    if (!result.accepted) { console.error(`Rejected: ${result.reason}`); process.exit(1); }
    appendEvent(LEDGER, { envelope, payload });
    console.log(`Published with quorum evidence. eventId=${envelope.eventId}`);
    break;
  }

  case 'verify': {
    const { state, rejections } = replayLedger(LEDGER, { policy: GOVERNANCE_POLICY, keyring: loadKeyring() });
    console.log(`Replayed ${state.events.length} events. Rejections: ${rejections.length}`);
    for (const r of rejections) console.log(`  - ${r.eventId ?? ''} ${r.reason}`);
    let chainOk = true;
    let prev = 'sha256:GENESIS';
    for (const e of state.events) {
      if (e.previousEventHash !== prev) { chainOk = false; break; }
      prev = sha256Prefixed(canonicalize(e));
    }
    console.log(chainOk ? 'Hash chain intact.' : 'HASH CHAIN BROKEN — possible tampering.');
    process.exit(rejections.length === 0 && chainOk ? 0 : 1);
  }

  case 'status': {
    const state = freshState();
    console.log(JSON.stringify({
      events: state.events.length,
      lamportClock: state.lamportClock,
      lastEventHash: state.lastEventHash,
      issuers: Object.keys(state.lastSequenceByIssuer),
      policyVersion: POLICY_VERSION,
      quorum: GOVERNANCE_POLICY.quorum,
    }, null, 2));
    break;
  }

  default:
    console.log(`Resonance Ledger CLI — commands: keygen | init | add-artifact | propose | approve | publish | verify | status`);
    console.log(`Design boundary: symbolic/memorial records are protected metadata (see policy.js memorialReferenceRecord), never control inputs or invariants.`);
}
