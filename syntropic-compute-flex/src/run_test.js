'use strict';
// Phase-1 measured test runner: baseline → controlled event (real SIGSTOP on a
// real spawned class-4 busy worker) → recovery. Writes hash-chained event log
// and a report stating ONLY what was measured.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { snapshot } = require('./telemetry');
const { WorkloadQueue } = require('./workloads');
const { LocalEnforcer } = require('./enforcement');
const { SchedulerPolicy } = require('./scheduler');
const { EventLog } = require('./eventlog');
const { buildTestReport } = require('./report');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASELINE_S = Number(process.env.BASELINE_S || 6);
const CONTROL_S = Number(process.env.CONTROL_S || 6);
const RECOVERY_S = Number(process.env.RECOVERY_S || 4);
const SAMPLE_MS = 500;

async function sampleWindow(seconds, label, log, extra = {}) {
  const rows = [];
  let prev = null;
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < seconds) {
    await sleep(SAMPLE_MS);
    const s = snapshot(prev); prev = s._prevTimes;
    const row = { phase: label, tS: +((Date.now() - t0) / 1000).toFixed(2),
      cpuUtilizationPct: s.cpuUtilizationPct, loadAvg1m: s.loadAvg1m,
      memoryUsedBytes: s.memoryUsedBytes, thermalZones: s.thermal.length,
      gpuPresent: s.gpu != null, powerW: null, ...extra };
    rows.push(row);
    log.append({ type: 'TELEMETRY_SAMPLE', phase: label, ...row });
  }
  return rows;
}

async function main() {
  const outDir = path.join(__dirname, '..', 'data');
  fs.mkdirSync(outDir, { recursive: true });
  const logPath = path.join(outDir, `test-run-${Date.now()}.jsonl`);
  const log = new EventLog(logPath);
  const queue = new WorkloadQueue();
  const enforcer = new LocalEnforcer();
  const sched = new SchedulerPolicy({ queue, enforcer, eventLog: log });

  log.append({ type: 'TEST_START', asset: require('os').hostname(), mode: 'local authorized workload test',
    controlAction: 'SIGSTOP/SIGCONT on explicitly spawned class-4 child process',
    powerMeter: 'NONE_CONFIGURED — watts will be reported as null, not estimated' });

  // Spawn a real, bounded, non-critical CPU worker (class 4). It self-terminates after 90s max.
  const workerSrc = `
    const end = Date.now() + 90000; let x = 0;
    const tick = () => { const s = Date.now(); while (Date.now() - s < 40) x += Math.sqrt(x + 1); if (Date.now() < end) setImmediate(tick); else process.exit(0); };
    process.on('SIGTERM', () => process.exit(0)); tick();`;
  const child = spawn(process.execPath, ['-e', workerSrc], { stdio: 'ignore' });
  const jobId = queue.submit({ name: 'cpu-spin-experiment', class: 4, runFn: () => {} });
  const job = queue.get(jobId);
  job.pid = child.pid;
  queue.start(jobId);
  log.append({ type: 'JOB_BOUND', jobId, pid: child.pid, class: 4, note: 'explicitly registered by this operator-owned test script' });

  console.log(`[test] baseline window (${BASELINE_S}s), worker pid ${child.pid} running…`);
  const baseline = await sampleWindow(BASELINE_S, 'baseline', log);

  const cmdT0 = Date.now();
  console.log('[test] controlled event: scheduler curtailment request → SIGSTOP');
  const execResults = sched.respondToCurtailmentRequest({ requestedReductionPct: 100, eligibleJobIds: [jobId] });
  const timeToTargetMs = Date.now() - cmdT0;
  const pauseResult = execResults.find(e => e.type === 'CURTAIL_EXECUTED');

  const control = await sampleWindow(CONTROL_S, 'control_paused', log,
    { elapsedSinceCommandS: null });
  control.forEach(r => r.elapsedSinceCommandS = +((Date.now() - cmdT0) / 1000).toFixed(2));

  console.log('[test] recovery: restore → SIGCONT');
  sched.restoreAfterEvent();
  const recovery = await sampleWindow(RECOVERY_S, 'recovery_resumed', log);

  // Job integrity: verify the OS-level state actually flipped (read /proc again post-resume)
  const procState = fs.existsSync(`/proc/${child.pid}/stat`)
    ? fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').match(/\)\s+(\S)/)[1] : 'EXITED';
  child.kill('SIGTERM');
  await sleep(300);

  const report = buildTestReport({
    asset: require('os').hostname(),
    mode: 'local authorized workload test',
    baselineSamples: baseline, controlSamples: control, recoverySamples: recovery,
    workloadOutcome: procState !== 'T' ? 'resumed then terminated cleanly' : 'FAILED_TO_RECOVER',
  });
  report.timeToTargetS = +(timeToTargetMs / 1000).toFixed(3);
  report.pauseVerification = pauseResult?.enforcerResult?.outcome || 'MISSING';
  report.postResumeProcState = procState; // 'R'/'S' = running again, 'T' = still stopped
  report.eventLog = path.basename(logPath);
  report.eventLogIntegrity = EventLog.verifyFile(logPath);

  fs.writeFileSync(path.join(outDir, 'last-report.json'), JSON.stringify(report, null, 2));
  console.log('\n===== MEASURED TEST REPORT =====');
  console.log(JSON.stringify(report, null, 2));
}

require('os'); // ensure available
const os = require('os');
main().catch(e => { console.error(e); process.exit(1); });
