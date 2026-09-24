# Syntropic Compute Flex Platform — Phase 1 (one real node)

Honest scope: this platform measures, schedules, and curtails **only explicitly
registered class-4 workloads on the operator's own machine**. The sole actuator
path is POSIX SIGSTOP/SIGCONT to child processes this software itself spawned.
No utility, BESS, HVAC, substation, inverter, breaker, or market interface exists.
Physical-grid claim: none. Market participation: none.

## Components (`src/`)
| Module | Function |
|---|---|
| `telemetry.js` | Real OS metrics: CPU utilization from `/proc/stat` jiffies (with `os.cpus()` fallback), loadavg, memory, thermal zones, nvidia-smi GPU telemetry — absence reported as `null`, never guessed |
| `workloads.js` | Class 1–4 job queue; protected classes refuse deferral/interruption in code |
| `enforcement.js` | LocalEnforcer: signals only class-4 registered pids; verifies state via `/proc/<pid>/stat`; honest GPU-cap probe |
| `scheduler.js` | Policy engine `flex-policy-v1`: refuse ≤2, escalate 3, act on 4; logs every proposal AND execution |
| `eventlog.js` | Append-only hash-chained JSONL ledger with tamper detection |
| `report.js` | Verified event report — watts stay `null` without a meter source |
| `run_test.js` | Phase-1 measured test: baseline → SIGSTOP control event → recovery |

## Run
```bash
node --test tests/            # 9/9 passing
node src/run_test.js          # ~16s measured experiment + signed-style report
```

## First measured result (this container, 2-core kernel, no power meter)
```text
Asset: c-6ab48394…  (containerized Linux, Intel Xeon @ 2.50GHz, 2 cores)
Test mode: local authorized workload test
Baseline CPU utilization: 50.9 %   During pause: 1.0 %   (real /proc deltas)
Time to target: 0.001 s · Pause verified at OS level: OK_VERIFIED (state T)
Recovery: post-resume proc state R · workload resumed then terminated cleanly
Power measurement source: NONE_CONFIGURED → watts reported null, not estimated
Event log integrity: chain OK, 37 records
Physical-grid claim: none · Market participation: none
```

## Known measurement caveats (documented, not hidden)
- This kernel exposes coarse `os.cpus()` ticks; `/proc/stat` is used instead.
- No thermal sensors or IPMI/rPDU exposed in this container → those fields are absent/null.
- Recovery rebound window (4 s) is too short to show full ramp in loadavg; visible in per-sample utilization.

## Next steps toward Phase 2 (each requires a real prerequisite)
1. **Meter integration** — plug-in wattmeter / smart PDU / UPS telemetry you own; add an authenticated meter reader feeding `powerW` samples. Only then do kW-reduction claims exist.
2. **GPU node** — run on NVIDIA hardware; `gpuTelemetry()` and the capped-power path activate automatically (probe already honest).
3. **Fleet** — sign telemetry events with Ed25519 keys (reuse `../resonance-ledger` envelope: issuer keys, sequence numbers, Lamport clocks) into the read-only collector.
4. **Facility** — requires owner authorization + approved interval meter; measure P_facility = P_compute + P_cooling + P_other rather than assuming it.
5. **DR pilot** — only via utility/aggregator contract, qualification test, approved baseline; failure mode: declare unavailable.
