# Testing Petrina

Development guidance for coding agents. Product contracts live in [design.md](design.md) and [ux.md](ux.md); contribution rules live in [AGENTS.md](../AGENTS.md#checks-and-test-cost).

## Required checks

Run from the repository root after installing dependencies with `bun install --frozen-lockfile`:

```sh
bun run typecheck
bun run test
```

Core and desktop use Vitest; engine tests use Bun. Keep the required engine suite fully parallel. Before a full run, check whether another full suite is already running on the machine; investigate with focused runs while it finishes. An isolated timing failure passing alone does not rule out a race.

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

## Engine fixtures

- `test/support.ts` supplies `makeWorld`, local GitHub stand-ins through `EngineOptions.gh` and `remote`, scripted engines, and wait helpers. Configure agents with `Fakes.scenario`.
- Import fixture `Engine` from `test/engine.ts`. It disables every provider's live account reader by default; usage tests supply their own `usageCommands`. Production defaults must not contact the developer's accounts during an unrelated test.
- Scripted agents get no browser. A test that checks browsing, capture folders or report pictures opts in with `makeWorld(name, { browser: true })`, `EngineOptions.browser` and `browserTempRoot`, or the harness's `--browser-root`. Its short private folder comes from `testBrowserRoot()`, inside the runner's browser folder; pass the same folder to every engine, browser and recovery of the fixture, and remove it afterwards.
- Use the fake agent's default plan for parallel reviewers. Its short plan has one reviewer. A fixture that holds agents must still let the Check finder finish.
- `waitFor`, `until` and `waitForFile` already apply the machine's `SLOW` factor. Stretch hang-catching limits under contention; do not stretch assertions about an actual timing guarantee.
- Restart tests wait for the engine to record activity, not just for the fake agent to mark itself working.
- When asserting persisted state, stop the fixture's engine before opening another writable Store. A state notification does not mean its SQLite writer has released the database.
- Tests requiring a particular tool must wait for its readiness check to finish; another Ready tool can be admitted while that check is still running.
- Change a running fake GitHub through its shared update helper, so simultaneous readers retain one consistent answer.
- Pass `testGitEnv()` explicitly to test-owned Git child processes; environment cleanup alone does not remove inherited push protections.
- After local delivery the working copy may be removed. Read the delivered commit from the product clone using the task branch.
- Engine helpers can be imported by standalone Bun diagnostics outside the checkout. Do not register test-runner-only hooks at import time in those helpers.
- With asymmetric matchers, Bun's `toMatchObject` can overwrite checked fields. Use `toEqual`, or check a copy.
- For rejected operations use `expectRejection` or `rejectionOf` from `test/rejections.ts`. These await ordinary Promises before asserting; Bun's `.rejects`/`.resolves` matchers re-enter the I/O dispatcher and can lose subprocess or pipe notifications ([upstream issue](https://github.com/oven-sh/bun/issues/33261)). Keep the same error, message and type assertions.
- Derive verifier counts from the ready tools; do not assume two voters.

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
