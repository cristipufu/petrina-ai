# Testing Petrina

Development guidance for coding agents. Product contracts live in [design.md](design.md) and [ux.md](ux.md); contribution rules live in [AGENTS.md](../AGENTS.md#checks-and-test-cost).

## Required checks

Run from the repository root after installing dependencies with `bun install --frozen-lockfile`:

```sh
bun run typecheck
bun run test
```

Core and desktop use Vitest; engine tests use Bun. Keep the required engine suite fully parallel. Before a full run, check whether another full suite is already running on the machine; investigate with focused runs while it finishes. An isolated timing failure passing alone does not rule out a race.

`bun run test` first enforces test conventions and exits before writing reports if they fail. It then runs the quick core and desktop suites one after the other, both even when the first fails, and starts the long engine suite only when both pass: a zero exit status and a readable structured report naming no failed file. Otherwise engine is recorded as not run and the command fails, so the Builder gets every quick failure without waiting for engine. Every suite keeps its normal parallel workers, assertions and deadlines, with no retries. The command passes only when every configured workspace ran and passed in that one invocation and its inputs were unchanged when it finished; results from separate runs are never combined, and inputs are compared only at the end. It closes with one plain line per suite: passed, failed (with its failing files), incomplete (a missing, unreadable or contradictory report), or not run and why. These lines never begin like a runner's failure marker, so each suite's own failing tests remain the diagnostic. A stop signal is passed to the running suite; nothing later starts and no summary is printed.

Each run saves `impact.json` and `results.json` in a unique ignored `.test-results/` folder. `results.json` lists every workspace, either with its exit code, duration and failed files, or with `notRun` and the reason; its `scope` is `complete` only when every workspace ran without interruption. A partial observation says nothing about the failures or selection misses of suites that did not run. The report identifies failed files outside the predicted selection, or explicitly says attribution was unavailable. It never changes which tests run.

Petrina runs this as one Tests check. A failed quick phase is an ordinary failed check, returned to the Builder under the same rules, failure reuse and two-return allowance; only a later complete pass ends the failure episode. Petrina's forced stop ends the runner without a final report, and its own stopped-check record is the evidence. Each CI platform runs the same command independently, so an engine failure specific to one platform appears once that platform's quick suites pass.

UI changes also need light and dark and all three demos: `?demo`, `?demo=portfolio`, `?demo=first-run`.

## Keep checks fast without losing coverage

Every full run adds to task and review-loop duration. Use direct core tests for decisions and focused engine fixtures for effects. Run a complete workflow when its interactions are what the test proves; do not send every reviewer regression through unrelated design or check discovery.

Use explicit progress/release signals instead of sleeps and controlled clocks for time-independent decisions. Actual startup deadlines and stopping stubborn child processes need real wall-clock coverage. Measure costly new integration cases and the fully parallel run after fixture changes; report the results with the change. Do not trade away assertions, isolation or workers, or add retries and skips to obtain a faster result.

The engine runner owns workers' temporary files and private Git helpers, reclaiming them after success, failure or interruption; Bun's isolated workers bypass exit hooks. On macOS it puts each run under `~/.petrina/test-tmp` when the temporary parent is the normal session folder or system fallback, including their canonical paths and aliases. A custom temporary parent, including one inherited from an enclosing run, stays in place; only the run's own folder is removed. Real agents' browser files stay separately under `~/.petrina/b` for short socket paths and browser-owned recovery and cleanup. Engine tests' private browser folders go in a short folder the runner also owns in the system's temporary folder, reclaimed the same way. Repository helpers copy immutable prepared seeds into independent object stores, refs and configuration. Never share mutable repositories, alternates or engine instances between tests.

## Choose a focused test

```sh
bun run --cwd packages/engine test test/name.test.ts
bun run --cwd packages/core test test/name.test.ts -t 'test name'
bun run --cwd apps/desktop test test/name.test.tsx -t 'test name'
```

Core stops at the first failure; filter by name to investigate later cases. Core modules have no runtime dependencies: diagnostic scripts can import their source by absolute path without the whole suite. Keep those scripts, their working directory and `TMPDIR` in an uncrowded home folder on this Mac; moving just one leaves Bun's startup delay. Use the command tool's deadline; this Mac has no `timeout` program.

## Engine test time limits

Run engine tests through the runner, as above: `test/run.ts` owns their fallback limit. It passes Bun `--timeout=720000` (twelve minutes) before your options, because Bun fixes a test's limit when it starts while fixture waits stretch up to eight times as the machine gets busier. Bun uses the last `--timeout`, written `--timeout 30000` or `--timeout=30000`, so a limit you pass replaces the fallback. A test's own limit, `it(name, fn, ms)`, beats both, shorter or longer. Bun ignores a `timeout` in `bunfig.toml`. Direct `bun test` without the runner, a `--timeout` or a test's own limit stops each test after Bun's five-second default, whatever helpers it imports; pass `--timeout` when a direct run needs longer.

Shared helpers never set limits: a `setDefaultTimeout` in an imported helper replaces an explicit `--timeout`, and in one Bun process only for the first file that loads it, so the limit would depend on imports and file order.

For a bounded focused diagnostic, give each test an explicit short limit and also bound the whole command outside Bun:

```sh
bun run --cwd packages/engine test test/name.test.ts -t 'test name' --timeout=30000
```

Run it under the command tool's execution deadline, normally two minutes. Bun's limit stops only a running test: it does not cover slow startup, a stuck or CPU-starved process, or a test with its own longer limit. A test that Bun reports as "timed out after 30000ms" is that test's result; a command stopped by the outer deadline is an incomplete check. Confirm the processes it started have stopped before trying again.

## Affected-test observation

`bun run test:impact [base-ref]` reports candidates from the current import/export graph, including changed tests and transitive dependents. The default base is the locally available `origin/main`; no network fetch or test execution occurs. Full runs use `PETRINA_TEST_BASE` when supplied. The report records the resolved base, HEAD and a content fingerprint of current inputs, including uncommitted files. Deleted or unmapped files, shared fixtures, configuration, dependencies, runner changes and unknown mappings conservatively select the full suite. Unresolved or computed imports include all their known test consumers. Invalid or unavailable Git information in the full runner falls back to the full suite.

This graph is not complete runtime coverage: subprocess entrypoints, file reads, generated programs, native code and external services can create additional relationships. No passing observation authorizes skips. Keep workflow integration tests for those interactions and use direct module tests for isolated decisions; lightweight engine helpers live in `test/fixtures.ts`, so they do not implicitly import the complete Engine.

Optional engine-file coverage can supplement the graph:

```sh
bun run test:coverage packages/engine/test/rejections.test.ts
```

This runs one exact test file through the isolated parallel engine runner and records executed-file LCOV edges after a pass on unchanged inputs. Collect files serially; each report belongs to its source, Bun version, platform and explicit browser-integration setting. Coverage only adds candidates. Missing coverage is labelled absent; stale coverage triggers a full selection. Coverage from spawned processes is not inferred, and a file-level map does not prove that every branch or scenario was exercised. Core and desktop retain Vitest's normal focused commands; no coverage package or selection mode is injected into them.

Selection remains in observation mode until representative changes and full-run results establish its limits, including misses and unclassified failures. The final delivery gate always requires every configured full check and hook on the current integrated tree and check definition. Reusing a pass requires unchanged inputs; a changed main tree or changed commands/hooks require verification again. Local landings serialize per product and reprepare if the destination moved. This repository's regression includes two changes that pass separately but fail together: the second cannot land on its old evidence. Petrina does not merge pull requests.

## Engine fixtures

- `test/support.ts` supplies `makeWorld`, local GitHub stand-ins through `EngineOptions.gh` and `remote`, scripted engines, and wait helpers. Configure agents with `Fakes.scenario`.
- Use `test/fixtures.ts` for private repositories, waits, temporary folders and fake-agent records without the Engine. Import `test/support.ts` when a complete workflow fixture or engine process is needed. Keep new tests named `*.test.ts` or `*.test.tsx` in their workspace's test folder.
- Import fixture `Engine` from `test/engine.ts`. It disables every provider's live account reader by default; usage tests supply their own `usageCommands`. Production defaults must not contact the developer's accounts during an unrelated test.
- A failed check looks for recorded machine sleep. Fixture `Engine`, the harness and `runChecks` from `test/fixtures.ts` supply no sleep records, so synthetic failures never read this Mac's power log. Interruption tests give each engine or run its own records through `EngineOptions.machineRecords` or `runChecks`'s last argument: `powerLogSleep` lines, `heldMachineRecords` for delayed, cancellable reads, or a failing source for unavailable records. Do not mock the shared reader. Test the native reader's command with a fake executor; a test that truly needs the live log passes `livePowerRecords` explicitly.
- Scripted agents get no browser. A test that checks browsing, capture folders or report pictures opts in with `makeWorld(name, { browser: true })`, `EngineOptions.browser` and `browserTempRoot`, or the harness's `--browser-root`. Its short private folder comes from `testBrowserRoot()`, inside the runner's browser folder; pass the same folder to every engine, browser and recovery of the fixture, and remove it afterwards.
- Compare a fixture's paths with the product's in the product's canonical spelling. On Windows, Bun's `realpathSync` keeps a short name such as `RUNNER~1`, while `realpath` from `node:fs/promises` and `realpathSync.native` expand it. `testBrowserRoot()` returns the native form.
- Use the fake agent's default plan for parallel reviewers. Its short plan has one reviewer. A fixture that holds agents must still let the Check finder finish.
- `waitFor`, `until` and `waitForFile` already apply the machine's `SLOW` factor. Stretch hang-catching limits under contention; do not stretch assertions about an actual timing guarantee.
- To check a timed engine wait, such as a full model's retry, hold it from the moment the engine records it, check the delay the engine chose, then end it (`model-capacity.test.ts`). Do not try to catch the task's status before the real timer ends: with parallel peers, the task waits only once every peer has finished. Waiting to reach a step deep in the workflow covers every step before it, so give it the whole task's allowance.
- Restart tests wait for the engine to record activity, not just for the fake agent to mark itself working.
- When asserting persisted state, stop the fixture's engine before opening another writable Store. A state notification does not mean its SQLite writer has released the database.
- Tests requiring a particular tool must wait for its readiness check to finish; another Ready tool can be admitted while that check is still running.
- Change a running fake GitHub through its shared update helper, so simultaneous readers retain one consistent answer.
- Pass `testGitEnv()` explicitly to test-owned Git child processes; environment cleanup alone does not remove inherited push protections.
- After local delivery the working copy may be removed. Read the delivered commit from the product clone using the task branch.
- Engine helpers can be imported by standalone Bun diagnostics outside the checkout. Do not register test-runner-only hooks, such as time limits, at import time in those helpers.
- With asymmetric matchers, Bun's `toMatchObject` can overwrite checked fields. Use `toEqual`, or check a copy.
- For rejected operations use `expectRejection` or `rejectionOf` from `test/rejections.ts`. These await ordinary Promises before asserting; Bun's `.rejects`/`.resolves` matchers re-enter the I/O dispatcher and can lose subprocess or pipe notifications ([upstream issue](https://github.com/oven-sh/bun/issues/33261)). Keep the same error, message and type assertions.
- Derive verifier counts from the bounded panel: at most two initial voters from the ready tools, plus one third answer when both say a finding does not block and three or more tools were usable. Do not assume one voter per ready tool.

`bun run test:conventions` parses test source and rejects direct production Engine and `runChecks` imports, Bun promise matchers in engine tests, and exclusive test selection across all workspaces. The fixtures' own production imports are the only exceptions. The guard does not prove that arbitrary subprocesses are isolated: review test-owned commands, writable resources, cleanup and native opt-ins as part of the change. Do not bypass the guard with dynamic or generated code.

## Desktop and demo fixtures

- happy-dom defaults to 1024px, where the inbox overlays the board. For a docked-inbox test, set a viewport of at least 1200px inside `act()` and restore it afterwards.
- Set focus explicitly when simulating an outside click; happy-dom's click helper does not reproduce browser focus behavior. Keyboard events alone do not produce a browser's automatic clicks; use a headless browser for those interactions.
- A task card's invisible `.card-open::after` layer owns its click area. A positioned control above it needs its own click handling.
- Demo builders cache by time. Reuse a fixed time in tests. `createDemoState` has no Analytics work log; use `createDemo` with its log, open work, quirks and triggers when testing Analytics.
- The portfolio demo uses different task IDs; locate cards by visible text or state. Stop the demo clock for stable captures; pausing the pool still lets active steps finish.

## Browser and native-tool checks

The engine can serve the built app: `bun run build`, then start it against a temporary Petrina folder on a free port. A front end without an engine runs the simulator. Keep disposable data and package installs outside this checkout.

Scripted browser tests cover isolated storage, capture paths, image validation, permissions and cleanup. Native Chromium cases stay skipped unless `PETRINA_BROWSER_CHECK` is enabled; a default passing suite does not establish those checks. See the browser and capture tests under `packages/engine/test/` for the relevant cases.

When changing a connector, also verify the installed tool's model/effort selection, existing login, resume/load and a real headless page interaction. Opening ACP alone does not prove browser execution. Check new, resumed and replacement conversations, capture names/locations and cleanup. Report an unavailable browser or sandbox check as incomplete. Stop all verification processes.

Claude Code's Mac sandbox can refuse `ps`, even when local test servers work; its session settings cannot grant that access. Agents rely on Petrina's own checks for the full engine suite. Installed connector/SDK sources can be inspected in Bun's package cache rather than downloaded again.

## Manual platform checks

Use these when changing first run, desktop ownership or terminal takeover; they supplement automated coverage, not undocumented claims about every platform.

- On an installed Mac app launched from the Dock, verify login-shell PATH discovery, initial tool status, the first Planner, offline GitHub behavior and startup times. Target under 60 seconds from first opening to the Planner; an unavailable GitHub connection should add no more than about 30 seconds while planning from the local clone. First run must not trigger Documents/Desktop/Downloads permission prompts or Apple's developer-tools installer. Guide links open in the user's browser.
- On Windows and Linux desktops, verify platform-specific installation guidance, clone discovery, pasted paths and external guide links.
- On Windows, verify takeover with Windows Terminal and with the PowerShell fallback; accented paths; npm-installed tool launchers; normal exit and closing the window; concurrent copied commands and Reopen terminal. Only one tool instance may open and hand-back must wait for it.
- On macOS or Linux, a launcher diagnostic can import `launchPlan` from `terminal.ts` and run the generated script with `sh` outside the checkout. It avoids executing a freshly written program directly, which macOS may hold for first-run checks.
