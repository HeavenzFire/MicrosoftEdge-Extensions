// Syntropic Grid — authenticated, validated, read-only telemetry ingestion.
// Modes are explicit and never silently change: SIMULATION | LIVE_READ_ONLY.
// AUTHORIZED_LOCAL_CONTROL is intentionally NOT implemented in this version.
// The collector accepts measurements only. It has no command path at all.

'use strict';

const crypto = require('crypto');

const MODES = Object.freeze(['SIMULATION', 'LIVE_READ_ONLY']);

// Field names that indicate a control/command payload. Presence = hard reject.
const FORBIDDEN_KEYS = new Set([
  'command', 'setpoint', 'dispatch', 'actuate', 'control', 'targetTempC',
  'curtailKw', 'bidMw', 'offerMw', 'preCoolTo', 'startGenset',
]);

// Clock-skew and freshness policy (seconds).
const MAX_FUTURE_SKEW_S = 120;
const MAX_STALE_AGE_S = 3600;
const ALLOWED_INTERVALS = new Set([60, 300, 900]);

// ---- asset registry ---------------------------------------------------------
// Defaults: controls false, market participation none. Owner must be explicit.
class AssetRegistry {
  constructor() { this.assets = new Map(); }

  register({ siteId, assetClass, owner, meterType, authorizedSources, timezone = 'UTC' }) {
    if (!siteId || !owner) throw new Error('siteId and owner required');
    this.assets.set(siteId, {
      siteId,
      assetClass: assetClass || 'FLEXIBLE_COMPUTE_LOAD',
      owner,
      meterType: meterType || 'INTERNAL_NON_REVENUE_GRADE',
      authorizedSources: new Set(authorizedSources || []),
      timezone,
      // Capability flags — every one defaults off and cannot be set here.
      controlCapable: false,
      marketParticipation: false,
      settlement: false,
    });
    return this.assets.get(siteId);
  }

  get(siteId) { return this.assets.get(siteId); }
}

// ---- helpers ----------------------------------------------------------------
function isFiniteNumber(v) { return typeof v === 'number' && Number.isFinite(v); }

function canonicalize(obj) {
  if (Array.isArray(obj)) return '[' + obj.map(canonicalize).join(',') + ']';
  if (obj && typeof obj === 'object') {
    return '{' + Object.keys(obj).sort()
      .map(k => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
  }
  return JSON.stringify(obj);
}

function eventIdFor(envelope) {
  return 'sha256:' + crypto.createHash('sha256').update(canonicalize(envelope)).digest('hex');
}

// ---- collector ----------------------------------------------------------------
class Collector {
  constructor({ registry, auth }) {
    this.registry = registry;
    this.auth = auth;            // { verify(token) -> sourceIdentity | null }
    this.raw = [];               // immutable raw accepted samples (append-only)
    this.seenEventIds = new Set();
    this.lastSeqBySource = new Map();  // `${sourceId}:${siteId}` -> seq
    this.rejections = [];
  }

  ingest(envelope, authToken) {
    const reject = (reason, detail) => {
      const r = { reason, detail, at: new Date().toISOString() };
      this.rejections.push(r);
      return { accepted: false, ...r };
    };

    // 1. Authenticated source identity.
    const source = this.auth.verify(authToken);
    if (!source) return reject('UNAUTHENTICATED', 'missing or invalid API token');

    // 2. No commands, ever. Scan deeply for forbidden keys.
    const stack = [envelope];
    while (stack.length) {
      const cur = stack.pop();
      if (cur && typeof cur === 'object') {
        for (const k of Object.keys(cur)) {
          if (FORBIDDEN_KEYS.has(k.toLowerCase()) || FORBIDDEN_KEYS.has(k)) {
            return reject('CONTROL_FIELD_PROHIBITED', `field "${k}" not accepted by read-only collector`);
          }
          if (typeof cur[k] === 'object') stack.push(cur[k]);
        }
      }
    }

    // 3. Schema version.
    if (envelope.schemaVersion !== 1) return reject('BAD_SCHEMA_VERSION', String(envelope.schemaVersion));

    // 4. Explicit mode; AUTHORIZED_LOCAL_CONTROL not implemented.
    if (!MODES.includes(envelope.environment)) {
      return reject('BAD_ENVIRONMENT', String(envelope.environment));
    }

    // 5. Known/allowlisted site + authorization of this source for it.
    const siteId = envelope.siteId || envelope.substationId;
    if (!siteId) return reject('MISSING_SITE_ID', 'siteId required');
    if (envelope.substationId && !envelope.siteId) {
      return reject('MISLABELD_ASSET', 'substationId reserved for authorized utility substations; use siteId');
    }
    const asset = this.registry.get(siteId);
    if (!asset) return reject('UNKNOWN_SITE', siteId);
    if (!asset.authorizedSources.has(source.id)) return reject('SOURCE_NOT_AUTHORIZED', source.id);

    // Mode consistency with asset reality: live claims on synthetic sources rejected.
    if (envelope.environment === 'LIVE_READ_ONLY' && source.kind === 'synthetic-replay') {
      return reject('MODE_MISMATCH', 'synthetic source cannot declare LIVE_READ_ONLY');
    }

    // 6. Timestamps: UTC, bounded skew, not stale.
    //    Replay datasets are accepted with historical timestamps; the skew
    //    bound applies to non-replay sources only.
    const observed = Date.parse(envelope.observedAtUtc);
    if (Number.isNaN(observed)) return reject('BAD_TIMESTAMP', String(envelope.observedAtUtc));
    const isReplaySource = !!(envelope.source && ['historical-replay', 'synthetic-replay'].includes(envelope.source.kind));
    const now = Date.now();
    if (!isReplaySource && (observed - now) / 1000 > MAX_FUTURE_SKEW_S) {
      return reject('FUTURE_DATED', 'exceeds clock-skew bound');
    }
    if ((now - observed) / 1000 > MAX_STALE_AGE_S * 24 * 30) {
      // replay datasets may be old; require explicit provenance for that
      if (!envelope.source || !['historical-replay', 'synthetic-replay'].includes(envelope.source.kind)) {
        return reject('STALE_WITHOUT_PROVENANCE', 'old timestamps require replay provenance');
      }
    }

    // 7. Declared interval.
    if (!ALLOWED_INTERVALS.has(envelope.intervalSeconds)) {
      return reject('BAD_INTERVAL', String(envelope.intervalSeconds));
    }

    // 8. Units + physical sanity per contract shape.
    const values = {};
    if (isFiniteNumber(envelope.loadMw)) values.loadMw = envelope.loadMw;
    if (isFiniteNumber(envelope.siteImportKw)) values.siteImportKw = envelope.siteImportKw;
    if (isFiniteNumber(envelope.gpuPowerKw)) values.gpuPowerKw = envelope.gpuPowerKw;
    if (isFiniteNumber(envelope.coolingPowerKw)) values.coolingPowerKw = envelope.coolingPowerKw;
    if (isFiniteNumber(envelope.otherPowerKw)) values.otherPowerKw = envelope.otherPowerKw;
    if (isFiniteNumber(envelope.projectedSolarMw)) values.projectedSolarMw = envelope.projectedSolarMw;
    if (isFiniteNumber(envelope.spotPriceUsdPerMwh)) values.spotPriceUsdPerMwh = envelope.spotPriceUsdPerMwh;

    for (const [k, v] of Object.entries(values)) {
      if (v < 0 && k !== 'spotPriceUsdPerMwh') return reject('NEGATIVE_PHYSICAL_VALUE', `${k}=${v}`);
    }
    const nonPrice = Object.keys(values).filter(k => k !== 'spotPriceUsdPerMwh');
    if (nonPrice.length === 0) return reject('NO_VALID_MEASUREMENTS', 'all fields missing/non-finite');
    // Reject stringly-typed numerics like "high" or nulls the caller meant as numbers.
    for (const k of ['loadMw', 'siteImportKw', 'spotPriceUsdPerMwh']) {
      if (k in envelope && envelope[k] !== undefined && !isFiniteNumber(envelope[k])) {
        return reject('NON_NUMERIC_FIELD', `${k}=${JSON.stringify(envelope[k])}`);
      }
    }

    // 9. Declared provenance + quality.
    if (!envelope.source || !envelope.source.kind || !envelope.source.sourceId || !envelope.source.quality) {
      return reject('MISSING_PROVENANCE', 'source{kind,sourceId,quality} required');
    }
    if (envelope.environment === 'LIVE_READ_ONLY' && envelope.source.quality === 'SIMULATED') {
      return reject('QUALITY_MODE_CONFLICT', 'SIMULATED quality cannot be declared LIVE');
    }

    // 10. Monotonic per-source sequence + idempotency.
    if (!Number.isInteger(envelope.sourceSequence) || envelope.sourceSequence < 1) {
      return reject('BAD_SEQUENCE', String(envelope.sourceSequence));
    }
    const seqKey = `${source.id}:${siteId}`;
    const lastSeq = this.lastSeqBySource.get(seqKey) || 0;
    if (envelope.sourceSequence <= lastSeq) {
      // could be replay/idempotent retry — allow exact-duplicate event ids below
      const eid = eventIdFor(envelope);
      if (this.seenEventIds.has(eid)) {
        return { accepted: true, duplicate: true, eventId: eid };
      }
      return reject('NON_MONOTONIC_SEQUENCE', `${envelope.sourceSequence} <= ${lastSeq}`);
    }

    // 11. Idempotency key / event id.
    const eventId = envelope.eventId || eventIdFor(envelope);
    if (this.seenEventIds.has(eventId)) return { accepted: true, duplicate: true, eventId };

    // Accept — store raw immutably, tagged with mode + server-side provenance.
    const record = Object.freeze({
      eventId,
      ...envelope,
      _ingest: Object.freeze({
        acceptedAtUtc: new Date(now).toISOString(),
        sourceIdentity: source.id,
        environment: envelope.environment,
        meterType: asset.meterType,
      }),
    });
    this.raw.push(record);
    this.seenEventIds.add(eventId);
    this.lastSeqBySource.set(seqKey, envelope.sourceSequence);
    return { accepted: true, eventId, stored: this.raw.length };
  }
}

module.exports = { MODES, AssetRegistry, Collector, eventIdFor, canonicalize };
