// Syntropic Grid — Forecasting and Flexible-Load Planning Console
// Read-only HTTP surface: POST /ingest (measurements only), GET /console, GET /status.
// There is no control endpoint, no actuator path, and no mode-switch route.

'use strict';

const http = require('http');
const { AssetRegistry, Collector } = require('./ingest');
const { aggregate15min, forecast, backtest, recommend } = require('./forecast');

const API_TOKEN = process.env.SG_API_TOKEN || 'dev-token-change-me';
const auth = { verify: (t) => (t === API_TOKEN ? { id: 'local-fixture-v1', kind: 'synthetic-replay' } : null) };

const registry = new AssetRegistry();
registry.register({
  siteId: 'owned-compute-lab-01',
  assetClass: 'FLEXIBLE_COMPUTE_LOAD',
  owner: 'project-steward',
  meterType: 'INTERNAL_NON_REVENUE_GRADE',
  authorizedSources: ['local-fixture-v1'],
});

const collector = new Collector({ registry, auth });

function statusPayload() {
  const siteId = 'owned-compute-lab-01';
  const series = aggregate15min(collector.raw, siteId);
  const fc = forecast(series);
  const bt = series.length > 97 ? backtest(series) : null;
  return {
    title: 'Syntropic Grid — Forecasting and Flexible-Load Planning Console',
    disclaimer: 'Simulation/replay and read-only telemetry. This console does not issue physical dispatches or market bids.',
    modesImplemented: ['SIMULATION', 'LIVE_READ_ONLY'],
    modeNotImplemented: 'AUTHORIZED_LOCAL_CONTROL',
    registeredAsset: registry.get(siteId),
    rawSamplesRetained: collector.raw.length,
    aggregatedIntervals: series.length,
    rejectionsLast20: collector.rejections.slice(-20),
    forecast: fc,
    backtest: bt,
    recommendation: recommend(series, fc),
    physicalActuation: 'disabled',
    marketParticipation: 'none',
    settlementStatus: 'none',
  };
}

const CONSOLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Syntropic Grid — Forecasting Console</title>
<style>body{font-family:system-ui;margin:2rem;background:#0b1020;color:#dbe4ff}pre{background:#131a2e;padding:1rem;border-radius:8px;overflow:auto}
.badge{display:inline-block;padding:.2rem .6rem;border-radius:4px;background:#2a3550;margin-right:.4rem}</style></head>
<body><h1>Syntropic Grid — Forecasting and Flexible-Load Planning Console</h1>
<p class="badge">SIMULATION / LIVE_READ_ONLY only</p><p class="badge">Physical actuation: DISABLED</p><p class="badge">Market participation: NONE</p>
<div id="dash"></div>
<script>
async function refresh(){
  const s = await (await fetch('/status')).json();
  const f = s.forecast || {};
  document.getElementById('dash').innerHTML = '<pre>' + JSON.stringify(s, null, 2) + '</pre>';
  if (f.point == null) {
    document.getElementById('dash').insertAdjacentHTML('afterbegin',
      '<h2>No telemetry window has been accepted.</h2>' +
      '<p>Mode: SIMULATION or LIVE_READ_ONLY required. This console does not issue physical dispatches or market bids.</p>' +
      '<ol><li>Select a registered site/asset (siteId — substationId is reserved for authorized utility substations).</li>' +
      '<li>Submit at least 96 valid 15-minute observations, or load an explicitly labelled replay dataset.</li>' +
      '<li>Verify timestamp, unit, and source-quality checks.</li>' +
      '<li>Review forecast accuracy (backtest MAE/RMSE vs persistence) before enabling any flexible-compute recommendation workflow.</li></ol>');
  } else {
    document.getElementById('dash').insertAdjacentHTML('afterbegin',
      '<h2>Forecast: $' + f.point + '/MWh <small>(95% interval $' + f.interval[0] + '–$' + f.interval[1] + ')</small></h2>' +
      '<p>Model: OLS v1 · Horizon: 15 min · Window: ' + f.windowIntervals + ' intervals · Status: baseline · Input freshness bucket: ' + f.inputFreshnessBucket + '</p>');
  }
}
refresh(); setInterval(refresh, 15000);
</script></body></html>`;

const server = http.createServer((req, res) => {
  const send = (code, obj, type = 'application/json') => {
    res.writeHead(code, { 'Content-Type': type });
    res.end(type === 'application/json' ? JSON.stringify(obj, null, 2) : obj);
  };
  if (req.method === 'GET' && req.url === '/console') return send(200, CONSOLE_HTML, 'text/html');
  if (req.method === 'GET' && req.url === '/status') return send(200, statusPayload());
  if (req.method === 'POST' && req.url === '/ingest') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let envelope;
      try { envelope = JSON.parse(body); }
      catch { return send(400, { accepted: false, reason: 'INVALID_JSON' }); }
      const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      const result = collector.ingest(envelope, token);
      return send(result.accepted ? 200 : 422, result);
    });
    return;
  }
  // Control paths deliberately do not exist.
  if (/^\/(dispatch|control|actuate|bid|command)/.test(req.url)) {
    return send(404, { error: 'No control interface exists in this system.' });
  }
  send(404, { error: 'not found' });
});

if (require.main === module) {
  const port = process.env.PORT || 4173;
  server.listen(port, () => console.log(`Syntropic Grid console (read-only): http://localhost:${port}/console`));
}

module.exports = { server, collector, registry, statusPayload };
