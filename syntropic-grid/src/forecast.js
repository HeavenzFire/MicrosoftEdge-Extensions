// Syntropic Grid — aggregation, OLS baseline forecast, backtest, recommendations.
// Forecasts are advisory only. No dispatch, no bids, no actuation anywhere here.

'use strict';

const MIN_INTERVALS_FOR_FORECAST = 96; // 24h of 15-min intervals

// ---- 15-minute aggregation ---------------------------------------------------
// Raw samples (any declared interval) -> aligned 900s buckets per site.
function aggregate15min(rawRecords, siteId) {
  const buckets = new Map(); // bucketStartMs -> {sums, counts}
  for (const r of rawRecords) {
    if ((r.siteId || r.substationId) !== siteId) continue;
    const t = Date.parse(r.observedAtUtc);
    const start = Math.floor(t / 900000) * 900000;
    let b = buckets.get(start);
    if (!b) { b = { n: 0, loadKw: 0, priceSum: 0, priceN: 0, solarMw: 0 }; buckets.set(start, b); }
    b.n += 1;
    b.loadKw += r.siteImportKw ?? (isNum(r.loadMw) ? r.loadMw * 1000 : 0);
    if (isNum(r.spotPriceUsdPerMwh)) { b.priceSum += r.spotPriceUsdPerMwh; b.priceN += 1; }
    if (isNum(r.projectedSolarMw)) b.solarMw += r.projectedSolarMw;
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([start, b]) => ({
      bucketStartUtc: new Date(start).toISOString(),
      samples: b.n,
      meanLoadKw: round(b.loadKw / b.n, 4),
      meanPriceUsdPerMwh: b.priceN ? round(b.priceSum / b.priceN, 4) : null,
      projectedSolarMw: round(b.solarMw / b.n, 6),
    }));
}
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function round(v, d) { const m = 10 ** d; return Math.round(v * m) / m; }

// ---- OLS baseline v1 -----------------------------------------------------------
// p_hat(t+1) = b0 + b1*L_t + b2*G_t + b3*p_t   (ridge-lambda=1e-8, window W)
function fitOls(series, window = 96) {
  const rows = series.filter(s => s.meanPriceUsdPerMwh != null);
  if (rows.length < window + 1) {
    return { status: 'INSUFFICIENT_HISTORY', observations: rows.length, required: window + 1 };
  }
  const use = rows.slice(-(window + 1));
  const X = [], y = [];
  for (let i = 0; i < use.length - 1; i++) {
    X.push([1, use[i].meanLoadKw, use[i].projectedSolarMw, use[i].meanPriceUsdPerMwh]);
    y.push(use[i + 1].meanPriceUsdPerMwh);
  }
  let beta;
  try {
    beta = solveNormalEquations(X, y);
  } catch (err) {
    // Degenerate design (e.g. constant features). Fall back to persistence-anchored fit:
    // p_hat(t+1) = mean + slope*(p_t - mean), load/solar terms zero.
    if (!/singular|unstable/.test(err.message)) throw err;
    const m = y.reduce((a, b) => a + b, 0) / y.length;
    const slope = slopeThroughOrigin(X.map(x => x[3] - m), y.map(v => v - m));
    beta = [m - slope * m, 0, 0, slope]; // prediction = m + slope*(p_t - m)
  }
  // residuals on the fitted window -> prediction interval
  const resid = X.map((x, i) => y[i] - dot(x, beta));
  const sigma = Math.sqrt(resid.reduce((a, r) => a + r * r, 0) / Math.max(1, resid.length - beta.length));
  return { status: 'BASELINE', beta: beta.map(b => round(b, 6)), sigma: round(sigma, 4), window: use.length, last: use[use.length - 1] };
}

function dot(a, b) { return a.reduce((s, v, i) => s + v * b[i], 0); }

function solveNormalEquations(X, y) {
  const k = X[0].length;
  // Standardize non-intercept columns so normal equations stay well-conditioned
  // for large-magnitude features (e.g. prices ~50, loads ~12).
  const mean = new Array(k).fill(0), scale = new Array(k).fill(1);
  for (let j = 1; j < k; j++) {
    mean[j] = X.reduce((s, x) => s + x[j], 0) / X.length;
    const varr = X.reduce((s, x) => s + (x[j] - mean[j]) ** 2, 0) / X.length;
    scale[j] = Math.sqrt(varr) || 1;
  }
  const Z = X.map(x => x.map((v, j) => j === 0 ? v : (v - mean[j]) / scale[j]));
  const yMean = y.reduce((a, b) => a + b, 0) / y.length;

  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < Z.length; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += Z[i][a] * (y[i] - yMean);
      for (let b = 0; b < k; b++) XtX[a][b] += Z[i][a] * Z[i][b];
    }
  }
  for (let a = 0; a < k; a++) XtX[a][a] += 1e-8; // tiny ridge for stability
  const gamma = gaussSolve(XtX, Xty);
  if (gamma.some(v => !Number.isFinite(v))) throw new Error('unstable solve');
  // Unstandardize: beta_0 absorbs intercept shift; beta_j = gamma_j / scale_j.
  const beta = gamma.map((g, j) => j === 0 ? g + yMean - gamma.slice(1).reduce((s, gj, idx) => s + gj * mean[idx + 1] / scale[idx + 1], 0) : g / scale[j]);
  return beta;
}

function gaussSolve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    if (Math.abs(M[c][c]) < 1e-12) throw new Error('singular design matrix');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((row, i) => row[n] / row[i][i]);
}

// Least-squares fit through origin: y ≈ slope * x (used as degenerate fallback).
function slopeThroughOrigin(xs, ys) {
  const num = xs.reduce((s, x, i) => s + x * ys[i], 0);
  const den = xs.reduce((s, x) => s + x * x, 0);
  return den > 1e-12 ? num / den : 0;
}

// ---- forecast ------------------------------------------------------------------
function forecast(series, window = 96) {
  const fit = fitOls(series, window);
  if (fit.status !== 'BASELINE') {
    return { ...fit, point: null, interval: null, message:
      `Need ${fit.required} labeled 15-min intervals; have ${fit.observations}. Forecast withheld.` };
  }
  const L = fit.last.meanLoadKw, G = fit.last.projectedSolarMw, p = fit.last.meanPriceUsdPerMwh;
  const point = round(fit.beta[0] + fit.beta[1] * L + fit.beta[2] * G + fit.beta[3] * p, 2);
  const lo = round(point - 1.96 * fit.sigma, 2), hi = round(point + 1.96 * fit.sigma, 2);
  return {
    model: 'OLS v1', horizonMinutes: 15, windowIntervals: fit.window,
    point, interval: [lo, hi], sigma: fit.sigma,
    inputFreshnessBucket: fit.last.bucketStartUtc,
    status: 'baseline',
  };
}

// ---- backtest: walk-forward MAE/RMSE/bias/coverage vs persistence ----------------
function backtest(series, { window = 96, steps = 24 } = {}) {
  const rows = series.filter(s => s.meanPriceUsdPerMwh != null);
  const results = { ols: { abs: [], sq: [], err: [], covered: 0, n: 0 }, persistence: { abs: [], sq: [] } };
  for (let i = window; i < rows.length; i++) {
    const train = rows.slice(Math.max(0, i - window - 1), i + 1);
    const fit = fitOls(train, Math.min(window, train.length - 1));
    if (fit.status !== 'BASELINE') continue;
    const actual = rows[i].meanPriceUsdPerMwh;
    const prev = rows[i - 1];
    const pred = fit.beta[0] + fit.beta[1] * prev.meanLoadKw + fit.beta[2] * prev.projectedSolarMw + fit.beta[3] * prev.meanPriceUsdPerMwh;
    const e = actual - pred;
    results.ols.abs.push(Math.abs(e)); results.ols.sq.push(e * e); results.ols.err.push(e); results.ols.n++;
    if (actual >= pred - 1.96 * fit.sigma && actual <= pred + 1.96 * fit.sigma) results.ols.covered++;
    const pe = actual - prev.meanPriceUsdPerMwh;
    results.persistence.abs.push(Math.abs(pe)); results.persistence.sq.push(pe * pe);
    if (results.ols.n >= steps) break;
  }
  const summarize = (arr) => arr.length ? round(arr.reduce((a, b) => a + b, 0) / arr.length, 4) : null;
  return {
    evaluatedSteps: results.ols.n,
    ols: {
      mae: summarize(results.ols.abs),
      rmse: results.ols.sq.length ? round(Math.sqrt(results.ols.sq.reduce((a, b) => a + b, 0) / results.ols.sq.length), 4) : null,
      bias: summarize(results.ols.err),
      intervalCoverage95: results.ols.n ? round(results.ols.covered / results.ols.n, 3) : null,
    },
    persistenceBenchmark: { mae: summarize(results.persistence.abs) },
    note: 'Accuracy metrics become informative after several weeks of data, not days.',
  };
}

// ---- recommendations (text only — never commands) --------------------------------
function recommend(series, fc) {
  if (!series.length) return 'No telemetry window accepted. Register a site and submit at least 96 valid 15-minute observations or load a labelled replay dataset.';
  if (!fc || fc.point == null) return `Model status: insufficient history (${fc.observations || 0}/${fc.required || 96} intervals). Forecast and recommendations withheld.`;
  const last = series[series.length - 1];
  if (fc.point > last.meanPriceUsdPerMwh * 1.15) {
    return `Advisory only: next-interval modeled price ($${fc.point}/MWh) exceeds current by >15%. Eligible Class 4 batch work could be deferred ~15 minutes. No action taken; physical actuation disabled.`;
  }
  if (fc.point < last.meanPriceUsdPerMwh * 0.85) {
    return `Advisory only: modeled price dip detected. Eligible Class 4 batch work could be advanced into this window. No action taken; physical actuation disabled.`;
  }
  return 'Advisory only: modeled price within ±15% of current. No scheduling recommendation. Physical actuation disabled; market participation none.';
}

module.exports = { aggregate15min, fitOls, forecast, backtest, recommend, MIN_INTERVALS_FOR_FORECAST };
