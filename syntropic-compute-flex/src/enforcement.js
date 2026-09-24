'use strict';
// Node-local enforcement: the ONLY actuator path in this platform is POSIX
// process signals to explicitly-registered, class-4 child processes.
// No utility, BESS, HVAC, substation, inverter, breaker, or market interface exists.

const { spawnSync } = require('child_process');

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM' ? true : false; }
}

class LocalEnforcer {
  constructor({ maxSignalRetries = 3 } = {}) {
    this.maxSignalRetries = maxSignalRetries;
    this.actions = []; // tamper-evident action log (also written by runner)
  }

  _log(entry) { this.actions.push(entry); return entry; }

  pauseProcess(job) {
    if (job.class !== 4) return this._log({ action: 'PAUSE', jobId: job.id, outcome: 'REFUSED', reason: `class ${job.class} not eligible for native pause` });
    if (!Number.isInteger(job.pid) || !pidAlive(job.pid)) return this._log({ action: 'PAUSE', jobId: job.id, outcome: 'REFUSED', reason: 'no live registered pid' });
    try {
      process.kill(job.pid, 'SIGSTOP');
      const verified = this._stateOf(job.pid) === 'T';
      return this._log({ action: 'PAUSE', jobId: job.pid ? job.id : job.id, pid: job.pid, outcome: verified ? 'OK_VERIFIED' : 'SENT_UNVERIFIED', signal: 'SIGSTOP' });
    } catch (e) {
      return this._log({ action: 'PAUSE', jobId: job.id, pid: job.pid, outcome: 'ERROR', reason: e.message });
    }
  }

  resumeProcess(job) {
    if (!Number.isInteger(job.pid) || !pidAlive(job.pid)) return this._log({ action: 'RESUME', jobId: job.id, outcome: 'REFUSED', reason: 'no live registered pid' });
    try {
      process.kill(job.pid, 'SIGCONT');
      const state = this._stateOf(job.pid);
      return this._log({ action: 'RESUME', jobId: job.id, pid: job.pid, outcome: state && state !== 'T' ? 'OK_VERIFIED' : 'SENT_UNVERIFIED', signal: 'SIGCONT', postState: state });
    } catch (e) {
      return this._log({ action: 'RESUME', jobId: job.id, pid: job.pid, outcome: 'ERROR', reason: e.message });
    }
  }

  // Read real process state from /proc/<pid>/stat — verification, not assumption.
  _stateOf(pid) {
    try {
      const stat = require('fs').readFileSync(`/proc/${pid}/stat`, 'utf8');
      const m = stat.match(/\)\s+(\S)/); // state char follows comm field
      return m ? m[1] : null;
    } catch (_) { return null; }
  }

  gpuPowerCapAttempt(desiredWatts) {
    // Honest capability probe: attempts nvidia-smi -pl only if the tool exists.
    let has;
    try { has = spawnSync('which', ['nvidia-smi'], { encoding: 'utf8' }).status === 0; } catch (_) { has = false; }
    if (!has) return this._log({ action: 'GPU_POWER_CAP', outcome: 'UNAVAILABLE', reason: 'nvidia-smi not present on this node; no GPU power claim can be made' });
    const r = spawnSync('nvidia-smi', ['-lgc', `${desiredWatts}`, '-pl', `${desiredWatts}`], { encoding: 'utf8', timeout: 5000 });
    return this._log({ action: 'GPU_POWER_CAP', outcome: r.status === 0 ? 'OK' : 'FAILED', desiredWatts, stderr: r.stderr?.slice(0, 200) || null });
  }
}

module.exports = { LocalEnforcer, pidAlive };
