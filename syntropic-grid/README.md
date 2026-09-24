# Syntropic Grid — Forecasting and Flexible-Load Planning Console

**Scope (deliberately bounded):** this is a forecasting *and planning-advisory* console.
It is **not** a VPP control plane. It issues no physical dispatches, no market bids,
no setpoints, and has no actuator path. `AUTHORIZED_LOCAL_CONTROL` mode is defined in
the mode taxonomy but **not implemented**, by design.

## Modes (explicit, never silent)

| Mode | Status | Meaning |
|---|---|---|
| `SIMULATION` | implemented | synthetic/replay data, labelled as such in every record |
| `LIVE_READ_ONLY` | implemented | authorized telemetry from assets you own/monitor; measurements only |
| `AUTHORIZED_LOCAL_CONTROL` | **not implemented** | reserved; requires separate authorization review before any build |

Every stored record carries its mode (`_ingest.environment`). No button or endpoint
transitions between modes.

## Pipeline

```text
Authorized/synthetic source
→ authenticated collector (Bearer token)
→ schema/unit/freshness/provenance validation
→ append-only immutable raw store
→ 15-minute aligned aggregation
→ OLS baseline v1 forecast (96-interval minimum history)
→ forecast + 95% prediction interval + provenance
→ advisory recommendation only
```

## Ingestion contract

Accepted shapes (see `src/ingest.js` for the full rule list):

- Simulation: `loadMw`, `spotPriceUsdPerMwh`, `projectedSolarMw` + `source{kind,sourceId,quality}`
- Owned lab/cluster: `siteId`, `assetClass: FLEXIBLE_COMPUTE_LOAD`, `siteImportKw`,
  `gpuPowerKw`, `coolingPowerKw`, `otherPowerKw`, `meterQuality`

`substationId` is rejected unless paired with an actual registered utility substation —
use `siteId` for owned equipment. The example site is honestly named
`owned-compute-lab-01` with meter type `INTERNAL_NON_REVENUE_GRADE`.

The collector rejects: unauthenticated sources, any control/command field (deep scan),
non-finite or stringly-typed numerics, negative physical values, unknown sites,
bad intervals, future-dated non-replay timestamps, missing provenance,
non-monotonic sequences, and `SIMULATED` quality claiming `LIVE_READ_ONLY`.

## Model honesty

- OLS v1: `p̂(t+1) = β₀ + β₁·Lₜ + β₂·Gₜ + β₃·pₜ`, rolling 96-interval window,
  standardized features + ridge for conditioning, persistence-anchored fallback on
  degenerate designs.
- Forecast is **withheld** below 97 labeled intervals (`INSUFFICIENT_HISTORY`).
- Output always includes point + 95% prediction interval + sigma + freshness bucket +
  model status. Never a bare point estimate.
- Walk-forward backtest reports MAE/RMSE/bias/interval-coverage against a **persistence
  benchmark**. On the synthetic fixture: OLS MAE ≈ 3.59 vs persistence ≈ 5.18 — which
  demonstrates the harness works, not that the model predicts real markets. Several
  weeks of real data are needed before accuracy metrics are informative.

## Run

```bash
node --test tests/            # 14 tests
node src/server.js            # http://localhost:4173/console  (read-only dashboard)
# replay labelled synthetic data via POST /ingest (see src/replay.js pattern)
```

## What success looks like (target status block)

```text
Registered asset: owned-compute-lab-01
Mode: LIVE_READ_ONLY
Telemetry source: local rack PDU, internal/non-revenue-grade
Aggregation: 15-minute intervals
Forecast model: OLS baseline v1 · Horizon: 15 minutes
Backtest MAE: <value> vs persistence <value>
Recommendation: defer eligible Class 4 batch queue for 15 minutes   ← advisory text only
Physical actuation: disabled
Market participation: none
Settlement status: none
```

## Build sequence followed / remaining

Done: mode+provenance tagging, asset registry (controls default false), authenticated
idempotent ingestion, immutable raw store, 15-min aggregation, 96-interval threshold,
prediction intervals, walk-forward backtest, advisory-only recommendations, honest empty state.

Next (only when real authorized data exists): register your actual PDU/meter as a
`live-meter` source identity, run several weeks, then evaluate whether flexible-compute
scheduling advisories earn their keep. Control paths stay unbuilt until a separate,
explicit authorization decision.
