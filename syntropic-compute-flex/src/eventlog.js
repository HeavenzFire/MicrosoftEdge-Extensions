'use strict';
// Append-only, hash-chained event log (reuses the resonance-ledger pattern).
// Every telemetry sample, proposal, and executed action links to its predecessor.

const crypto = require('crypto');
const fs = require('fs');

class EventLog {
  constructor(path) { this.path = path; this.prevHash = 'GENESIS'; this.seq = 0; }

  append(event) {
    const rec = { seq: ++this.seq, atUtc: new Date().toISOString(), prevHash: this.prevHash, ...event };
    const body = JSON.stringify(rec);
    rec.hash = crypto.createHash('sha256').update(this.prevHash + '|' + body).digest('hex');
    this.prevHash = rec.hash;
    if (this.path) fs.appendFileSync(this.path, JSON.stringify(rec) + '\n');
    return rec;
  }

  static verifyFile(path) {
    const lines = fs.readFileSync(path, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let prev = 'GENESIS';
    for (const r of lines) {
      const { hash, ...rest } = r;
      const expect = crypto.createHash('sha256').update(prev + '|' + JSON.stringify(rest)).digest('hex');
      if (r.prevHash !== prev || hash !== expect) return { ok: false, brokenAtSeq: r.seq };
      prev = hash;
    }
    return { ok: true, records: lines.length };
  }
}

module.exports = { EventLog };
