# Measuring test cost

Run from the repository root, with no other full suite running:

```sh
bun run test:resources
```

This uses the required runner's complete file manifest, execution order, scripts, checks and normal worker settings. It adds private native-worker observers, a Vitest reporter and a process-tree sampler. It does not rewrite test files, contact accounts, retry tests or change assertions and deadlines. Profiling adds overhead: use an ordinary `bun run test` for delivery evidence. Resource runs are explicitly marked `resource-diagnostic`, `deliveryEligible: false`, and do not update the required-run duration cache.

Reports live in a unique ignored `.test-results/resources/` directory. Keep its path when comparing revisions. Rebuild rankings from retained events without rerunning tests:

```sh
bun run test:resources --report .test-results/resources/<run>
```

| Artifact | What it records |
|---|---|
| `run.json` | Full-run outcome, runtime/OS/CPU count, elapsed time, explicitly copied root-child driver counters and sampling limits/errors. |
| `summary.json` | Top twenty observed cases and case-attributed file totals by duration/work, native launch calls, observed child CPU and largest individual child RSS; command-family and Git-operation counts. Vitest heap readings are separately ranked as case-end worker snapshots. |
| `samples.jsonl` | One-second observations of the full runner's process tree, including already observed orphans. Aggregate RSS sums shared pages. |
| `events-*.jsonl` | Bounded per-worker native case boundaries, instrumented launch/exit observations and available child resource usage. |
| `vitest-cases.jsonl` | Vitest's own case/module timing and available heap diagnostics. |
| `full.stdout.log`, `full.stderr.log` | The full runner's retained output. Its normal exact-file reports remain in their separately announced directory. |

Interpret each measurement within its scope:

- Native elapsed case time includes contention and awaits inside the callback, but excludes surrounding hooks. Unfinished cases remain visible.
- File callback-time totals sum available case durations, which can overlap; they are not elapsed file time. Duration-reading and native-case counts expose partial coverage; missing durations stay absent and uninstrumented files stay out of native launch rankings. Native entries use the worker's actual entry file. Completed worker records also let the report correct formatted stack labels in earlier captured events without changing raw logs.
- Launch calls cover instrumented `Bun.spawn`, `Bun.spawnSync` and `node:child_process` APIs in the native worker. A returned child PID and a failed start are recorded separately from a launch call. Internal launches in uninstrumented descendants, direct native calls and Vitest workers are not included in that count. Module setup and hooks may have no case owner; they remain unattributed.
- Observed child CPU is child resource usage, when available. Launch/exit and CPU/RSS-reading counts accompany each case, exposing partial sums. Child CPU can include descendants, so summing it is not exclusive whole-suite CPU. A child RSS value is that child's high-water mark, not a case's aggregate memory peak. Missing metrics stay absent.
- Native test workers share a process. Its own CPU and heap cannot be reliably charged to an individual simultaneous case. Use focused, isolated measurements of the expensive cases to investigate that cost; do not invent a per-case share.
- Vitest's reported heap is a worker snapshot taken after a case, including other retained state. It is neither exclusive allocation by that case nor its peak usage. Rank it to find places to investigate, then confirm with isolated measurements.
- Process samples miss short-lived children. Present process entries include zombies; their count does not mean every entry was actively running. POSIX CPU percentages are rolling estimates; Windows supplies cumulative CPU instead. RSS totals can count shared pages more than once. PID association uses parent and birth observations; POSIX same-second reuse entirely between samples can remain indistinguishable. The observer never signals sampled PIDs.
- Invalid lines, truncated observers, missing exits and sampler errors are retained. They cannot establish that a resource was unused or a process stopped. Resource observers do not replace the fixture's cleanup checks.

Native event files stop explicitly at 16 MiB per worker or 64 KiB per event; Vitest observations, samples and each full-output stream have 32 MiB budgets. The outer command streams its logs without retaining another in-memory copy. Budget exhaustion and observer failures make the observations incomplete; inspect both `run.json` and `summary.json`. The final sample records previously observed processes still present after exit; an empty list cannot prove that no short-lived or unobserved descendant escaped. Raw reports remain ignored artifacts rather than repository files.

Driver counters may be getter-backed objects and CPU integers may be `bigint`. The collector copies available fields explicitly, converting only exactly representable nonnegative integers. Missing counters are listed as unavailable; rebuilding an old report cannot invent counters that were never written.

The portable observation interface and native command/parsing details live in `@petrina/platform/process-metrics`; execution uses the shared owned-command fixture. The native API/case observer and ranking rules live in `@petrina/test-support/resources/`. The root command composes them with the existing test runner. Keep the profiler opt-in and out of application launches and ordinary checks.
