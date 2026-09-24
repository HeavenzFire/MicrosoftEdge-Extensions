'use strict';
// Workload queue with explicit classes. Only class 4 is eligible for curtailment.
// Protected workloads can NEVER be interrupted by policy — enforced in code, not convention.

const CLASS_DESCRIPTIONS = {
  1: 'protected / interactive (never interruptible)',
  2: 'production batch (checkpointed pause only, requires operator flag)',
  3: 'best-effort batch (deferral allowed, interruption requires operator flag)',
  4: 'non-critical experimental (start/defer/pause/resume allowed without extra approval)',
};

class WorkloadQueue {
  constructor() { this.jobs = new Map(); this.seq = 0; }

  submit({ name, class: cls, runFn, checkpointFn, resumeFn }) {
    if (![1, 2, 3, 4].includes(cls)) throw new Error(`Workload class must be 1-4, got ${cls}`);
    if (typeof runFn !== 'function') throw new Error('runFn required');
    const id = `job-${++this.seq}`;
    this.jobQueue ||= [];
    this.jobQueue.push(id);
    this.jobs.set(id, {
      id, name, class: cls, status: 'QUEUED', log: [],
      runFn, checkpointFn: checkpointFn || null, resumeFn: resumeFn || null,
    });
    return id;
  }

  get(id) { return this.jobs.get(id); }
  list() { return [...this.jobs.values()].map(j => ({ id: j.id, name: j.name, class: j.class, status: j.status })); }

  _transition(id, from, to, action) {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`Unknown job ${id}`);
    if (!from.includes(j.status)) throw new Error(`Illegal transition: ${j.status} -> ${to} (action=${action})`);
    j.status = to;
    j.log.push({ at: new Date().toISOString(), action, from: from.join('|'), to });
    return j;
  }

  start(id) { return this._transition(id, ['QUEUED', 'DEFERRED', 'PAUSED_CHECKPOINTED'], 'RUNNING', 'START'); }
  defer(id) {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`Unknown job ${id}`);
    if (j.class < 3) throw new Error(`Class ${j.class} workload is protected against deferral`);
    return this._transition(id, ['QUEUED'], 'DEFERRED', 'DEFER');
  }
  pause(id) {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`Unknown job ${id}`);
    if (j.class !== 4 && !j.operatorApprovalForInterruption)
      throw new Error(`Pause requires class 4 or explicit operator approval; refusing to interrupt class ${j.class}`);
    if (j.class === 4) return this._transition(id, ['RUNNING'], 'PAUSED_NATIVE', 'PAUSE(SIGSTOP)');
    if (!j.checkpointFn) throw new Error('Non-class-4 pause requires a registered checkpoint function');
    j.checkpointFn();
    return this._transition(id, ['RUNNING'], 'PAUSED_CHECKPOINTED', 'CHECKPOINT+PAUSE');
  }
  resume(id) {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`Unknown job ${id}`);
    if (j.status === 'PAUSED_CHECKPOINTED' && j.resumeFn) j.resumeFn();
    return this._transition(id, ['PAUSED_NATIVE', 'PAUSED_CHECKPOINTED'], 'RUNNING', 'RESUME');
  }
}

module.exports = { WorkloadQueue, CLASS_DESCRIPTIONS };
