// resonance-ledger/src/policy.js
// Governance policy v1: role grants, quorum rules, memorial metadata category.
// NOTE (deliberate design boundary): symbolic/memorial content is a protected
// METADATA CATEGORY only. It is never a control input and never an invariant.

export const POLICY_VERSION = 'governance-v1';

export const GOVERNANCE_POLICY = {
  policyVersion: POLICY_VERSION,
  quorum: 2, // distinct authorized approvers required for high-impact actions
  roleGrants: {
    'archive-ingester':      ['ARTIFACT_ADDED'],
    'provenance-verifier':   ['PROVENANCE_VERIFIED'],
    'policy-validator':      ['POLICY_VALIDATED', 'POLICY_UPDATED'],
    'release-publisher':     ['RELEASE_APPROVED', 'RELEASE_PUBLISHED'],
    'indexer':               ['INDEX_BUILT'],
    'notification-agent':    ['NOTICE_SENT'],
    'replay-verifier':       ['REPLAY_VERIFIED'],
    'backup-verifier':       ['BACKUP_VERIFIED'],
    'creative-cataloger':    ['ARTIFACT_CATALOGED'],
    'privacy-guardian':      ['VISIBILITY_SET'],
    'incident-recorder':     ['INCIDENT_RECORDED'],
    'key-rotation-steward':  ['KEY_REGISTERED', 'KEY_REVOKED'],
    'dependency-auditor':    ['DEPENDENCY_AUDITED'],
    'read-only-analyst':     [],           // no write authority at all
    'human-steward-gateway': ['*'],        // may emit any event type, still bound by schema+signature
    'consensus-coordinator': ['QUORUM_STATE_PROPOSED'],
  },
  // High-impact event types require proposal + quorum approval before PUBLISH.
  highImpactTypes: ['RELEASE_PUBLISHED', 'POLICY_UPDATED', 'KEY_REVOKED'],
  invariants: [
    'Every public artifact has provenance metadata.',
    'No private artifact is published without authorized approval.',
    'No agent can alter an immutable original record.',
    'A role cannot approve its own high-impact proposal.',
    'All events carry a monotonic logical-clock value per issuer.',
    'Event IDs are applied at most once.',
    'Revoked keys cannot issue new events; historical evidence is preserved.',
  ],
};

/**
 * Memorial/creative anchor representation — protected metadata, NOT a
 * technical control input. Visibility defaults to consent-controlled.
 */
export function memorialReferenceRecord({ title, purpose, stewardKeyId }) {
  return {
    recordType: 'MEMORIAL_REFERENCE',
    visibility: 'private-or-consent-controlled',
    purpose,
    title,
    interpretation: 'Human-authored symbolic meaning; not a technical control input',
    modificationPolicy: 'Designated steward approval required',
    stewardKeyId,
    createdAtUtc: new Date().toISOString(),
  };
}
