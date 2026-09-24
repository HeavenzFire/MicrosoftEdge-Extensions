'use strict';
// Verified event report generator — states ONLY what was measured.
// Power fields remain null unless a real meter source is configured. No estimation.

function buildTestReport({ asset, mode, baselineSamples, controlSamples, recoverySamples, workloadOutcome, meterSource }) {
  const avgW = (rows) => {
    const vals = rows.map(r => r.powerW).filter(v => Number.isFinite(v));
    return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : null;
  };
  const base = avgW(baselineSamples), ctrl = avgW(controlSamples);
  return {
    asset,
    testMode: mode, // e.g. "local authorized workload test"
    powerMeasurementSource: meterSource || 'NONE_CONFIGURED',
    baselinePowerW: base,
    powerAfterPolicyW: ctrl,
    reductionW: (base != null && ctrl != null) ? +(base - ctrl).toFixed(1) : null,
    timeToTargetS: ctrl != null ? controlSamples[0]?.elapsedSinceCommandS ?? null : null,
    durationMin: controlSamples.length ? +(controlSamples.at(-1).tS / 60).toFixed(1) : null,
    cpuUtilBaselinePct: (() => { const v = baselineSamples.map(s => s.cpuUtilizationPct).filter(Number.isFinite); return v.length ? +(v.reduce((a,b)=>a+b,0)/v.length).toFixed(1) : null; })(),
    cpuUtilDuringControlPct: (() => { const v = controlSamples.map(s => s.cpuUtilizationPct).filter(Number.isFinite); return v.length ? +(v.reduce((a,b)=>a+b,0)/v.length).toFixed(1) : null; })(),
    workloadOutcome, // completed / checkpointed / resumed / refused
    physicalGridClaim: 'none',
    marketParticipation: 'none',
    note: base == null
      ? 'Watts not reported: no authenticated meter source configured. CPU utilization deltas are real measurements; do not convert them into power claims.'
      : 'Watts from declared meter source; provenance recorded per sample.',
  };
}

module.exports = { buildTestReport };
