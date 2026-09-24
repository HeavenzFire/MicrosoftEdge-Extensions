'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const os = require('os');
const fs = require('fs');
const { WorkloadQueue } = require('../src/workloads');
const { LocalEnforcer } = require('../src/enforcement');
const { SchedulerPolicy } = require('../src/scheduler');
const { EventLog } = require('../src/eventlog');
const { snapshot, cpuUtilization, readCpuTimes } = require('../src/telemetry');
const { buildTestReport } = require('../src/report');

const sleep = ms => new Promise(r => setTimeout(r, ms));
function mk() { return { queue: new WorkloadQueue(), enf: new LocalEnforcer(), log: new EventLog(null) }; }

test('class 4 job full lifecycle', () => {
  const { queue } = mk();
  const id = queue.submit({ name: 'j', class: 4, runFn: () => {} });
  queue.start(id); assert.equal(queue.get(id).status, 'RUNNING');
  queue.pause(id); assert.equal(queue.get(id).status, 'PAUSED_NATIVE');
  queue.resume(id); assert.equal(queue.get(id).status, 'RUNNING');
});

test('protected classes refuse deferral and interruption', () => {
  const { queue } = mk();
  for (const cls of [1, 2]) {
    const id = queue.submit({ name: `p${cls}`, class: cls, runFn: () => {} });
    assert.throws(() => queue.defer(id), /protected/i);
    queue.start(id);
    assert.throws(() => queue.pause(id), /class 4 or explicit operator approval/i);
  }
});

test('illegal transitions rejected', () => {
  const { queue } = mk();
  const id = queue.submit({ name: 'x', class: 4, runFn: () => {} });
  assert.throws(() => queue.pause(id), /Illegal transition/); // QUEUED -> PAUSED not allowed
});

test('scheduler refuses class-1/2, escalates class-3, acts on class-4', async () => {
  const { queue, enf, log } = mk();
  const sched = new SchedulerPolicy({ queue, enforcer: enf, eventLog: log });
  const c1 = queue.submit({ name: 'db', class: 1, runFn: () => {} }); queue.start(c1);
  const c3 = queue.submit({ name: 'etl', class: 3, runFn: () => {} }); queue.start(c3);
  const workerSrc = 'let x=0;setInterval(()=>{const s=Date.now();while(Date.now()-s<30)x+=Math.sqrt(x+1);},5);setTimeout(()=>process.exit(0),6000);';
  const child = spawn(process.execPath, ['-e', workerSrc], { stdio: 'ignore' });
  let childDone = false;
  child.on('exit', () => { childDone = true; });
  const killChild = () => { try { process.kill(child.pid, 'SIGCONT'); } catch {} try { child.kill('SIGKILL'); } catch {} };
  const c4 = queue.submit({ name: 'exp', class: 4, runFn: () => {} }); queue.get(c4).pid = child.pid; queue.start(c4);
  await sleep(200);
  const res = sched.respondToCurtailmentRequest({ requestedReductionPct: 50, eligibleJobIds: [c1, c3, c4] });
  assert.ok(res.some(e => e.type === 'CURTAIL_REFUSED' && e.jobId === c1));
  assert.ok(res.some(e => e.type === 'CURTAIL_ESCALATED' && e.jobId === c3));
  const exec = res.find(e => e.type === 'CURTAIL_EXECUTED' && e.jobId === c4);
  assert.ok(exec, 'class-4 executed');
  const readState = () => { try { return fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8').match(/\)\s+(\S)/)[1]; } catch { return null; } };
  let state = null; for (let i = 0; i < 20 && state !== 'T'; i++) { state = readState(); if (state !== 'T') await sleep(25); }
  try {
    assert.equal(state, 'T', 'OS-level SIGSTOP verified via /proc');
    sched.restoreAfterEvent();
    let state2 = 'T'; for (let i = 0; i < 20 && state2 === 'T'; i++) { state2 = readState(); await sleep(25); }
    assert.ok(state2 !== 'T' && state2 !== null, 'process resumed at OS level');
  } finally {
    killChild();
    for (let i = 0; i < 40 && !childDone; i++) await sleep(25);
  }
});

test('enforcer refuses signals to non-class-4 jobs even with a pid', () => {
  const { queue, enf } = mk();
  const id = queue.submit({ name: 'prot', class: 1, runFn: () => {} });
  queue.get(id).pid = process.pid; // attacker-ish binding: our own pid
  const r = enf.pauseProcess(queue.get(id));
  assert.equal(r.outcome, 'REFUSED');
  assert.equal(r.reason.includes('not eligible'), true);
});

test('gpu power cap honestly reports unavailability without nvidia-smi', () => {
  const { enf } = mk();
  const r = enf.gpuPowerCapAttempt(100);
  assert.ok(['UNAVAILABLE', 'FAILED'].includes(r.outcome) || os.platform() === 'linux');
  if (!fs.existsSync('/usr/bin/nvidia-smi') && !spawnSyncExists()) assert.equal(r.outcome, 'UNAVAILABLE');
  function spawnSyncExists() { try { require('child_process').execFileSync('which', ['nvidia-smi'], {stdio:'ignore'}); return true; } catch { return false; } }
});

test('event log hash chain verifies and detects tampering', () => {
  const p = '/tmp/flex-test-log.jsonl';
  try { fs.unlinkSync(p); } catch {}
  const log = new EventLog(p);
  for (let i = 0; i < 5; i++) log.append({ type: 'TEST', i });
  assert.deepEqual(EventLog.verifyFile(p), { ok: true, records: 5 });
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  lines[2] = JSON.stringify({ ...JSON.parse(lines[2]), i: 999 });
  fs.writeFileSync(p, lines.join('\n') + '\n');
  assert.equal(EventLog.verifyFile(p).ok, false);
});

test('telemetry returns real measured values', async () => {
  const a = snapshot(null); const prev = a._prevTimes;
  const busyStart = Date.now(); while (Date.now() - busyStart < 300) Math.sqrt(Math.random());
  const b = snapshot(prev);
  // Coarse-precision platforms may report zero jiffies in a short window; poll up to ~1s.
  let util = b.cpuUtilizationPct, pprev = b._prevTimes, tries = 0;
  while ((!Number.isFinite(util) || util <= 0) && tries++ < 6) { await sleep(150); const t = snapshot(pprev); pprev = t._prevTimes; util = t.cpuUtilizationPct; }
  assert.ok(Number.isFinite(util) && util > 0, `expected positive measured CPU utilization, got ${util}`);
  assert.equal(typeof b.hostname, 'string');
  assert.ok(Array.isArray(b.thermal));
});

test('report never fabricates watts', () => {
  const rep = buildTestReport({ asset: 'a', mode: 'm', baselineSamples: [{ cpuUtilizationPct: 50 }], controlSamples: [{ cpuUtilizationPct: 10, tS: 6 }], recoverySamples: [], workloadOutcome: 'resumed' });
  assert.equal(rep.baselinePowerW, null);
  assert.equal(rep.reductionW, null);
  assert.match(rep.note, /do not convert them into power claims/);
});
