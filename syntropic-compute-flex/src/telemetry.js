'use strict';
// Node telemetry agent — honest measurement only.
// Reads real OS metrics; never estimates or fabricates power numbers.

const os = require('os');
const fs = require('fs');

function readCpuTimes() {
  const cpus = os.cpus();
  let user = 0, nice = 0, sys = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0;
  for (const c of cpus) {
    user += c.times.user; nice += c.times.nice; sys += c.times.system; idle += c.times.idle;
    iowait += c.times.iowait || 0; irq += c.times.irq || 0; softirq += c.times.softirq || 0;
    steal += c.times.steal || 0;
  }
  return { user, nice, sys, idle, iowait, irq, softirq, steal,
           total: user + nice + sys + idle + iowait + irq + softirq + steal };
}

// CPU utilization via /proc/stat delta when available, else os.cpus() delta.
function cpuUtilization(prev, curr) {
  const busyDelta = (curr.total - curr.idle - curr.iowait) - (prev.total - prev.idle - prev.iowait);
  const totalDelta = curr.total - prev.total;
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(1, busyDelta / totalDelta));
}

// Preferred source: aggregate "cpu" line of /proc/stat (USER_HZ jiffies).
// On some virtualized kernels os.cpus().times is quantized far too coarsely
// to yield usable deltas; /proc/stat remains exact. Returns null if absent.
function readProcStat() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    if (!line.startsWith('cpu ')) return null;
    const n = line.trim().split(/\s+/).slice(1).map(Number);
    if (n.length < 4 || n.some(v => !Number.isFinite(v))) return null;
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = n;
    return { user, nice, sys: system, idle, iowait, irq, softirq, steal,
             total: user + nice + system + idle + iowait + irq + softirq + steal };
  } catch (_) { return null; }
}

function thermalReadings() {
  // Real kernel thermal sensors under /sys/class/thermal, if present.
  const out = [];
  const base = '/sys/class/thermal';
  try {
    for (const z of fs.readdirSync(base)) {
      const tzPath = `${base}/${z}/temp`;
      if (fs.existsSync(tzPath)) {
        const milli = parseInt(fs.readFileSync(tzPath, 'utf8').trim(), 10);
        if (Number.isFinite(milli)) out.push({ zone: z, celsius: +(milli / 1000).toFixed(2) });
      }
    }
  } catch (_) { /* no thermal zones on this platform */ }
  return out;
}

function gpuTelemetry() {
  // nvidia-smi if present; otherwise honestly report absence. Never guess.
  try {
    const { execFileSync } = require('child_process');
    const csv = execFileSync('nvidia-smi',
      ['--query-gpu=utilization.gpu,memory.used,memory.total,power.draw,power.limit,temperature.gpu',
       '--format=csv,noheader,nounits'],
      { timeout: 3000, encoding: 'utf8' });
    return csv.trim().split('\n').map((line, i) => {
      const [util, memUsed, memTotal, powerDraw, powerLimit, temp] = line.split(',').map(s => parseFloat(s.trim()));
      return { index: i, utilPct: util, memUsedMiB: memUsed, memTotalMiB: memTotal,
               powerDrawW: Number.isFinite(powerDraw) ? powerDraw : null,
               powerLimitW: Number.isFinite(powerLimit) ? powerLimit : null,
               tempC: Number.isFinite(temp) ? temp : null };
    });
  } catch (_) {
    return null; // no NVIDIA GPU / driver on this node — reported as absent, not zero
  }
}

function snapshot(prevTimes) {
  // Prefer /proc/stat (exact jiffies); fall back to os.cpus() on other platforms.
  const curr = readProcStat() || readCpuTimes();
  const loadAvg = os.loadavg();
  const mem = { totalBytes: os.totalmem(), freeBytes: os.freemem() };
  return {
    observedAtUtc: new Date().toISOString(),
    hostname: os.hostname(),
    cores: os.cpus().length,
    cpuUtilizationPct: prevTimes ? +(cpuUtilization(prevTimes, curr) * 100).toFixed(2) : null,
    loadAvg1m: loadAvg[0],
    memoryUsedBytes: mem.totalBytes - mem.freeBytes,
    thermal: thermalReadings(),
    gpu: gpuTelemetry(),
    _prevTimes: curr,
  };
}

module.exports = { snapshot, readCpuTimes, readProcStat, cpuUtilization, thermalReadings, gpuTelemetry };
