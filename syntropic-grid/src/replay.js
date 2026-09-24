// Syntropic Grid — labelled replay driver.
// Submits a synthetic 15-minute price/load trajectory for owned-compute-lab-01,
// clearly marked SIMULATION + synthetic-replay provenance. Advisory output only.

'use strict';

const { collector } = require('./server');
const TOKEN = process.env.SG_API_TOKEN || 'dev-token-change-me';

const N = parseInt(process.argv[2] || '120', 10); // intervals (>=97 to unlock forecast)
const t0 = Math.floor(Date.now() / 900000) * 900000 - N * 900000;

for (let i = 0; i < N; i++) {
  const price = 50 + 5 * Math.sin(i / 6) + (((i * 37) % 11) - 5);
  const env = {
    schemaVersion: 1,
    environment: 'SIMULATION',
    siteId: 'owned-compute-lab-01',
    assetClass: 'FLEXIBLE_COMPUTE_LOAD',
    observedAtUtc: new Date(t0 + i * 900000).toISOString(),
    intervalSeconds: 900,
    siteImportKw: +(12 + Math.sin(i / 9)).toFixed(3),
    gpuPowerKw: 8.1, coolingPowerKw: 2.0, otherPowerKw: 2.3,
    projectedSolarMw: 0.02,
    spotPriceUsdPerMwh: +price.toFixed(2),
    source: { kind: 'synthetic-replay', sourceId: 'local-fixture-v1', quality: 'SIMULATED' },
    sourceSequence: i + 1,
  };
  const r = collector.ingest(env, TOKEN);
  if (!r.accepted) { console.error('rejected at', i, r.reason, r.detail); process.exit(1); }
}

console.log(`Replayed ${N} labelled SIMULATION intervals (source: local-fixture-v1, quality: SIMULATED).`);
console.log('This is synthetic replay data — not live telemetry, not market data.');
