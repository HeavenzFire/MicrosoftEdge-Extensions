// Syntropic Grid — test suite (node --test)
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { AssetRegistry, Collector } = require('../src/ingest');
const { aggregate15min, forecast, backtest, recommend } = require('../src/forecast');

const TOKEN = 't0ken';
const auth = { verify: t => (t === TOKEN ? { id: 'local-fixture-v1', kind: 'synthetic-replay' } : null) };

function makeCollector() {
  const registry = new AssetRegistry();
  registry.register({
    siteId: 'owned-compute-lab-01', owner: 'steward',
    authorizedSources: ['local-fixture-v1'],
  });
  return new Collector({ registry, auth });
}

function baseEnvelope(overrides = {}) {
  return {
    schemaVersion: 1,
    environment: 'SIMULATION',
    siteId: 'owned-compute-lab-01',
    assetClass: 'FLEXIBLE_COMPUTE_LOAD',
    observedAtUtc: new Date().toISOString(),
    intervalSeconds: 900,
    siteImportKw: 12.4,
    gpuPowerKw: 8.1,
    coolingPowerKw: 2.0,
    otherPowerKw: 2.3,
    spotPriceUsdPerMwh: 48.72,
    source: { kind: 'synthetic-replay', sourceId: 'local-fixture-v1', quality: 'SIMULATED' },
    sourceSequence: 1,
    ...overrides,
  };
}

test('rejects unauthenticated ingestion', () => {
  const c = makeCollector();
  const r = c.ingest(baseEnvelope(), 'wrong');
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.reason, 'UNAUTHENTICATED');
});

test('rejects control fields outright (no command path)', () => {
  const c = makeCollector();
  const r = c.ingest(baseEnvelope({ command: 'PRE_COOL_TO_14C' }), TOKEN);
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.reason, 'CONTROL_FIELD_PROHIBITED');
});

test('rejects stringly-typed and null measurements', () => {
  const c = makeCollector();
  let r = c.ingest(baseEnvelope({ loadMw: 'high' }), TOKEN);
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.reason, 'NON_NUMERIC_FIELD');
  r = c.ingest(baseEnvelope({ spotPriceUsdPerMwh: null, siteImportKw: undefined, gpuPowerKw: undefined, coolingPowerKw: undefined, otherPowerKw: undefined }), TOKEN);
  assert.strictEqual(r.accepted, false);
});

test('rejects LIVE mode declared by synthetic source', () => {
  const c = makeCollector();
  const r = c.ingest(baseEnvelope({ environment: 'LIVE_READ_ONLY' }), TOKEN);
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.reason, 'MODE_MISMATCH');
});

test('rejects AUTHORIZED_LOCAL_CONTROL (not implemented)', () => {
  const c = makeCollector();
  const r = c.ingest(baseEnvelope({ environment: 'AUTHORIZED_LOCAL_CONTROL' }), TOKEN);
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.reason, 'BAD_ENVIRONMENT');
});

test('rejects substationId-only payloads as mislabeled assets', () => {
  const c = makeCollector();
  const env = baseEnvelope(); delete env.siteId;
  env.substationId = 'ERCOT Alpha';
  const r = c.ingest(env, TOKEN);
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.reason, 'MISLABELD_ASSET');
});

test('rejects unknown sites, bad intervals, future timestamps, missing provenance', () => {
  const c = makeCollector();
  assert.strictEqual(c.ingest(baseEnvelope({ siteId: 'nope' }), TOKEN).reason, 'UNKNOWN_SITE');
  assert.strictEqual(c.ingest(baseEnvelope({ intervalSeconds: 7 }), TOKEN).reason, 'BAD_INTERVAL');
  // The default test source is a replay source (skew bound exempt); use a live
  // meter identity to verify the clock-skew rule applies to non-replay sources.
  const liveAuth = { verify: t => (t === TOKEN ? { id: 'rack-pdu-01', kind: 'live-meter' } : null) };
  const registry2 = new AssetRegistry();
  registry2.register({ siteId: 'owned-compute-lab-01', owner: 'steward', authorizedSources: ['rack-pdu-01'] });
  const c2 = new Collector({ registry: registry2, auth: liveAuth });
  const env = baseEnvelope({
    environment: 'LIVE_READ_ONLY',
    observedAtUtc: new Date(Date.now() + 3600e3).toISOString(),
    source: { kind: 'pdu', sourceId: 'rack-pdu-01', quality: 'MEASURED' },
  });
  assert.strictEqual(c2.ingest(env, TOKEN).reason, 'FUTURE_DATED');
  const env3 = baseEnvelope(); delete env3.source;
  assert.strictEqual(c.ingest(env3, TOKEN).reason, 'MISSING_PROVENANCE');
});

test('enforces monotonic source sequence and idempotent retry', () => {
  const c = makeCollector();
  // Fixed timestamp so the seq-2 envelope and its retry are byte-identical.
  const t = new Date().toISOString();
  assert.strictEqual(c.ingest(baseEnvelope({ sourceSequence: 2, observedAtUtc: t }), TOKEN).accepted, true);
  assert.strictEqual(c.ingest(baseEnvelope({ sourceSequence: 1, observedAtUtc: t }), TOKEN).reason, 'NON_MONOTONIC_SEQUENCE');
  // exact duplicate of seq 2 (same payload) -> idempotent duplicate, not error
  const dup = c.ingest(baseEnvelope({ sourceSequence: 2, observedAtUtc: t }), TOKEN);
  assert.strictEqual(dup.accepted, true);
  assert.strictEqual(dup.duplicate, true);
  assert.strictEqual(c.raw.length, 1);
});

test('accepts a valid simulation envelope and stores raw immutably with mode tag', () => {
  const c = makeCollector();
  const r = c.ingest(baseEnvelope(), TOKEN);
  assert.strictEqual(r.accepted, true);
  assert.strictEqual(c.raw[0]._ingest.environment, 'SIMULATION');
  assert.throws(() => { c.raw[0].siteImportKw = 99; }, TypeError); // frozen record
});

// ---- forecast tests -----------------------------------------------------------
function synthSeries(n = 120) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const price = 50 + 5 * Math.sin(i / 6) + ((i * 37) % 11) - 5; // deterministic pseudo-noise
    rows.push({
      bucketStartUtc: new Date(1700000000000 + i * 900000).toISOString(),
      samples: 15, meanLoadKw: 12 + Math.sin(i / 9), projectedSolarMw: 0.02,
      meanPriceUsdPerMwh: price,
    });
  }
  return rows;
}

test('withholds forecast below 96-interval history threshold', () => {
  const fc = forecast(synthSeries(40));
  assert.strictEqual(fc.point, null);
  assert.strictEqual(fc.status, 'INSUFFICIENT_HISTORY');
  assert.ok(/Forecast withheld/.test(fc.message));
});

test('produces point estimate with 95% prediction interval when history suffices', () => {
  const fc = forecast(synthSeries(120));
  assert.ok(Number.isFinite(fc.point));
  assert.strictEqual(fc.interval.length, 2);
  assert.ok(fc.interval[0] < fc.point && fc.point < fc.interval[1]);
  assert.ok(fc.windowIntervals >= 96);
});

test('aggregation buckets 1-minute samples into aligned 15-minute intervals', () => {
  const c = makeCollector();
  const t0 = Math.floor(Date.now() / 900000) * 900000;
  for (let m = 0; m < 15; m++) {
    const ok = c.ingest(baseEnvelope({
      intervalSeconds: 60,
      observedAtUtc: new Date(t0 + m * 60000).toISOString(),
      sourceSequence: m + 1,
    }), TOKEN);
    assert.strictEqual(ok.accepted, true, JSON.stringify(ok));
  }
  const series = aggregate15min(c.raw, 'owned-compute-lab-01');
  assert.strictEqual(series.length, 1);
  assert.strictEqual(series[0].samples, 15);
});

test('backtest reports MAE/RMSE/bias/coverage and persistence benchmark', () => {
  const bt = backtest(synthSeries(140), { window: 96, steps: 20 });
  assert.ok(bt.evaluatedSteps > 0);
  assert.ok(Number.isFinite(bt.ols.mae));
  assert.ok(Number.isFinite(bt.persistenceBenchmark.mae));
  assert.ok(bt.ols.intervalCoverage95 >= 0 && bt.ols.intervalCoverage95 <= 1);
});

test('recommendations are advisory text only', () => {
  const rec = recommend(synthSeries(120), forecast(synthSeries(120)));
  assert.match(rec, /Advisory only|could be/i);
  assert.doesNotMatch(rec, /\b(PRE_COOL|DISPATCH|START|STOP|BID)\b/);
  const empty = recommend([], forecast([]));
  assert.match(empty, /96 valid 15-minute observations|withheld/i);
});
