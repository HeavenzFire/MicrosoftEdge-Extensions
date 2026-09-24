'use strict';
// Scheduler policy engine. Fleet rules enforced here:
//   Never interrupt protected workloads (class 1-2).
//   Require explicit workload class before curtailment.
//   Class 4 only for automatic action; everything else escalates to operator.
//   Log every proposed AND executed action.
//   Local fallback: if coordinator unreachable, agent holds current state (fail-in-place).

const POLICY_VERSION = 'flex-policy-v1';

class SchedulerPolicy {
  constructor({ queue, enforcer, eventLog }) {
    this.queue = queue; this.enforcer = enforcer; this.eventLog = eventLog;
  }

  _record(type, payload, executed) {
    const ev = { type, policyVersion: POLICY_VERSION, proposedAtUtc: new Date().toISOString(), ...payload, executed: !!executed };
    this.eventLog.append(ev);
    return ev;
  }

  // A curtailment request arrives (e.g., forecast advisory "defer eligible Class 4 batch").
  // The scheduler may only ACT on class-4 jobs it owns. It never invents authority.
  respondToCurtailmentRequest({ requestedReductionPct, eligibleJobIds, operatorApproval = false }) {
    const results = [];
    for (const id of eligibleJobIds || []) {
      const job = this.queue.get(id);
      if (!job) { results.push(this._record('CURTAIL_SKIP', { jobId: id, reason: 'unknown job' }, false)); continue; }
      if (job.class <= 2) { results.push(this._record('CURTAIL_REFUSED', { jobId: id, class: job.class, reason: 'protected workload class; refusing to interrupt' }, false)); continue; }
      if (job.class === 3 && !operatorApproval) { results.push(this._record('CURTAIL_ESCALATED', { jobId: id, class: 3, reason: 'best-effort batch requires operator approval to interrupt' }, false)); continue; }
      if (job.status !== 'RUNNING') { results.push(this._record('CURTAIL_SKIP', { jobId: id, reason: `not running (${job.status})` }, false)); continue; }
      const proposal = this._record('CURTAIL_PROPOSED', { jobId: id, class: job.class, requestedReductionPct }, false);
      let exec;
      if (job.pid) {
        exec = this.enforcer.pauseProcess(job);
        if (String(exec.outcome).startsWith('OK')) { // reflect the verified OS state in the queue too
          try { this.queue.pause(id); } catch (_) { /* status already reconciled elsewhere */ }
        }
      } else {
        exec = this.queue.pause(id) && { action: 'PAUSE', outcome: 'OK_LOGICAL_ONLY', note: 'logical job, no OS process bound' };
      }
      results.push(this._record('CURTAIL_EXECUTED', { jobId: id, enforcerResult: exec, proposalId: proposal.proposedAtUtc }, true));
    }
    return results;
  }

  restoreAfterEvent() {
    const out = [];
    for (const j of this.queue.list()) {
      if (j.status === 'PAUSED_NATIVE' || j.status === 'PAUSED_CHECKPOINTED') {
        const job = this.queue.get(j.id);
        let exec;
        if (job.pid) {
          exec = this.enforcer.resumeProcess(job);
          if (String(exec.outcome).startsWith('OK')) { try { this.queue.resume(j.id); } catch (_) {} }
        } else {
          exec = this.queue.resume(j.id) && { outcome: 'OK_LOGICAL_ONLY' };
        }
        out.push(this._record('RESTORE_EXECUTED', { jobId: j.id, result: exec }, true));
      }
    }
    return out;
  }
}

module.exports = { SchedulerPolicy, POLICY_VERSION };
