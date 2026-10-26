# Local stepped load-test sample

This is a reproducible local baseline for the assignment's load-test evidence, not a production-capacity claim.

## Test setup

- Host: Windows, Node.js `v24.18.0`
- Target: internal Telemetry Service `GET /telemetry/VAX-1001`
- Persistence: isolated in-memory SQLite seeded with the demo batches
- Load tool: `scripts/loadtest.js`
- Stages: 10 seconds each at concurrency 1, 5, and 10
- Scope: loopback service reads only; no gateway, writes, external weather calls, or public endpoints were load-tested

## Observed results

| Concurrent clients | Requests | Failed requests | Requests/second | p50 latency (ms) | p95 latency (ms) | p99 latency (ms) | Max latency (ms) |
|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 713 | 0 | 71.28 | 15.39 | 16.18 | 16.54 | Not recorded |
| 5 | 6,271 | 0 | 626.41 | 9.11 | 15.92 | 16.34 | Not recorded |
| 10 | 54,031 | 0 | 5,402.56 | 1.62 | 2.31 | 8.41 | Not recorded |

## Interpretation and limitations

Throughput increased at each concurrency step, with no failed/non-2xx requests in this run. The jump in throughput and decrease in reported latency at concurrency 10 should be interpreted cautiously; these are short local runs and not a production benchmark. Max latency was not recorded for this run. These figures only describe this local development machine and a small in-memory seeded-data read. They are not a service-level objective or evidence of cloud, gateway, database-persistence, write, or external-provider capacity. Repeat the profile on the presentation machine, preserve the output, and discuss any differences. Confirm with the instructor that this Node-based utility is an acceptable equivalent to the named load-testing tools.
