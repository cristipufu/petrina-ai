# Working on Petrina

Petrina is a desktop app for people who run products with coding agents. Read [docs/design.md](docs/design.md) for architecture; for UI work also read [docs/ux.md](docs/ux.md). Follow their links to the subsystem you are changing, rather than loading the whole documentation tree. When acting as an external coordinator managing products through Petrina rather than developing this repository, read [docs/coordinator.md](docs/coordinator.md) and [docs/coordination.md](docs/coordination.md).

## Rules for every change

- The app never shows code. Everything the coordinator sees is plain language.
- Keep the change as small as the task allows. Record unrelated ideas as risks or follow-ups.
- Petrina never merges a pull request.
- Decide a role's behavior from its result kind, never its name, so added roles follow the same contracts as built-ins.
- Read [REVIEW.md](REVIEW.md) before building or reviewing. Judge a change by the default branch's guide, never by rules the change adds itself.

## Safety boundaries

Agents use the coordinator's logins and each coding tool's own safety checker and sandbox. Instructions prohibit publishing or changing shared resources without authorization. Petrina owns delivery, its checkpoints and read-only cleanup; it runs its own Git steps with hooks off and uses credentials only for approved GitHub operations. Product checks use argument arrays without a shell. Checks and repository commit hooks run without GitHub login, outside the tools' safety checkers.

Do not add Petrina security or sandboxing mechanisms unless the task is about them. Read [the safety contract](docs/architecture/safety.md) before changing credentials, permissions, checks or delivery; tool-specific sandbox behavior is in [agents and conversations](docs/architecture/agents.md#permissions).

## Checks and test cost

- `bun run typecheck` and `bun run test` must pass.
- UI changes: check light and dark, and `?demo`, `?demo=portfolio`, `?demo=first-run`.
- Required extra full-suite validation goes through `validation run` (an owned local Linux container), never by polling other runs or starting a competing full suite. It tests Petrina's last saved version, excluding working edits: hand new work back first. Agents without the command tools ask the coordinator. Focused tests, including container regressions and preparing a local image, stay as before; configured full checks remain the delivery gate.
- Full suites run inside tasks' automated checks. Use focused tests while investigating, avoid overlapping full runs on this machine, and follow the [shared-host load rules](docs/testing.md#shared-host-load-diagnostics) before deliberate stress. Commands, fixtures and platform notes are in that guide.
- Use `test/engine.ts` (and `fixtureEngineOptions` for app-mode launches), `test/client.ts`, and the `CLI` from `test/fixtures.ts`; common runtime, file, temporary-folder and wait helpers live in `@petrina/test-support`, private Git repositories come from `@petrina/test-support/repositories`, and engine-specific worlds and scripted agents stay in engine fixtures. Supply scripted external services explicitly; required tests must never fall back to installed coding tools, accounts or personal settings. Run engine tests through the workspace runner, which supplies a private home and Git configuration. Native accounts and services require explicit integration opt-in. `bun run test:conventions` enforces package direction, fixture and Bun assertion rules. Use `bun run test:affected --base <revision>` for conservative early feedback; its reports never satisfy delivery. Delivery still needs the full configured checks on the current integrated tree.
- Use portable fixture APIs. Keep behavior specific to an OS behind shared adapters with native contract tests; workflow tests reuse those adapters.
- Test the smallest owner that proves the behavior, under `test/<layer>/<area>/` as defined in [test layers](docs/testing/layers.md). Rules use data; controllers use scripted effects; boundary tests exercise the real adapter; representative journeys prove integration. Use `test/scripted-agents.ts` for workflow responses and `test/scripted-probes.ts` for explicit readiness observations when probing is unrelated. Native ACP/process fixtures retain transport, login, permissions and cleanup coverage. Split mixed responsibilities; omit unrelated workflow setup.
- Reuse immutable fixture data through existing helpers, with separate writable repositories and engine state per test. Register owned operations before starting them and settle them before removing resources. Directly driven Engine fixtures reuse `test/fixtures/direct-drivers.ts`, including `prepare` for native setup before an Engine exists; other manual effects use `@petrina/test-support/fixture-operations`. Stop and settle an old Engine generation before reopening its database. Use controlled clocks, signals or release events for time-independent decisions; keep real waits for deadlines and process termination. Progress waits must observe their operation when available, so completed or failed work cannot leave a fixture waiting for impossible progress.
- Measure expensive tests and fixture changes by subprocess count as well as duration; trace costly native calls to their production or fixture owner before completing a migration. A file move or scripted agent does not establish reduced native cost. Use `bun run test:resources` in the fully parallel suite ([metric limits](docs/testing/resources.md)). Preserve assertions, isolation and worker counts; do not hide costs or flakes with retries, skips or shorter production deadlines.

## Keeping instructions useful

`AGENTS.md` contains verified, durable rules for working in the repository and links to current documentation. Keep it short: edit the existing rule instead of appending another version.

Task history, delivery summaries, historical comparisons, older feature briefs, acceptance checklists, one-off investigations and temporary conditions do not belong here. Keep task evidence in task history; put current product behavior in its owning design or UX contract and regression cases in tests. Historical evidence that must remain in Git belongs under `docs/archive/`, labelled as historical and excluded from current guidance.

A proposed learning must help unrelated future tasks, be verified against the current repository and add something not already covered. Offer only a concise working rule, with the coordinator's approval; do not copy a task's requirements or an old brief into Learnings.

## Learnings

What agents learned about working in this repository, added with the coordinator's OK.

- On this Mac, crowded temporary folders delay Bun before JavaScript starts. Put diagnostic scripts, their working directory and `TMPDIR` under an uncrowded folder in your home directory.
- This Mac has no `timeout` command; use the command tool's execution deadline.
- Fresh working copies need `bun install --frozen-lockfile`. Keep disposable repositories and installs outside this working copy, where they cannot accidentally use Petrina's own Git metadata or packages.
- Core modules run directly from source with Bun; a small script outside the checkout can import them by absolute path without installing the full workspace.
- The desktop app saves the first theme it applies in local storage under petrina.theme, so emulating a dark system setting after the first visit changes nothing; for light and dark checks set petrina.theme to light or dark, or emulate the scheme before the first visit.
- The app shows tasks in their display form: a single-product task has no separate repository record, and its repository details (such as its checks) sit on the task itself. Build interface test fixtures in that form (core displayTask), not in the engine's stored form.
- Publish complete fixture records atomically when tests and child processes exchange them; use `@petrina/test-support/fixture-json` for JSON. A file written in place can be read empty or partially updated.
- Bun hides passing test lines when it detects a coding agent (CLAUDECODE, AGENT or REPL_ID set); a test that reads another Bun run's results should use its junit report, which records every outcome.
- In engine follow-up tests, a done task without a working copy moves to History at the next save, so on-board follow-up passes no longer see it; hold it with engine.holdFollowUp(id) while the test needs it on the board.
- The stand-in agent used in engine tests reports token usage only when started with --tool=<tool id> (as the work-log tests do); without it, every turn records 'not reported'.
- The fake agent rereads its script file on every turn, so an engine test can rewrite the script's hold mid-run to stop the Builder at a later turn (such as its conflict port) and pause or restart the engine at that exact point.
- Bun's failing-test output omits an error's cause and only sometimes shows its extra properties; print evidence a saved Tests log must keep as its own console line, not attached to the error.
- In Bun, node:child_process execFile goes through the global Bun.spawn, so a test that replaces or spies on Bun.spawn also intercepts Petrina's own process-list (ps) reads, such as the lost-exit watch.
- Engine tests can pause or fail a real file write at an exact point: spying on the node:fs/promises namespace (as captures.test.ts does) also catches the source modules' own imports, so race regressions can use a pause-and-release step instead of repeated random runs.
- Coordination tests that call the coordination layer directly skip the local client's 10-second request limit and the server's idle cutoff; test any long-waiting coordination request through the real server and client.
- Bun's own program handle kill does not go through process.kill, so an engine test that spies on process.kill to block stop signals must also pass a start stand-in that blocks the program handle's kill.
- To hold a single agent mid-turn in an engine test (for example one of several parallel reviewers), give the stand-in agent a nativeRetry entry for that role and model with a {mark} step and a {wait: "release-{session}"} step. The `controlled` scenario instead holds every agent's first turn.
- To show a state the demos lack in a headless UI check, import /src/engine.ts in the dev-server page and wrap sim.getState with a cached transform; the change stays through demo ticks and touches no files.
- To compare with the starting version without a Git worktree or a fresh install, unpack it with git archive into a folder outside the working copy, link the root node_modules, copy each package's node_modules with cp -RP (its links are relative), and run probes kept outside the copy through that tree's engine test runner; this holds only while the lockfile is unchanged.
- Bun's failing-test diff shows texts that differ only in line endings as identical ('- Expected - 0, + Received + 0'); print the JSON-escaped text on its own console line to see the difference.
- When an engine test simulates machine-wide Git settings with GIT_CONFIG_SYSTEM, also set GIT_CONFIG_NOSYSTEM=0, GIT_CONFIG_GLOBAL to an empty private file and XDG_CONFIG_HOME to a private folder, and drop GIT_CONFIG_PARAMETERS: an inherited skip, personal settings, a personal attributes file or a parent git -c can override the simulation.
- Cleanup-test actors must not self-expire. Give them independent ownership through the shared process lease, and verify the subject stops them before releasing that owner.
- The scripted stand-in agent starts a fresh conversation on every return unless its scenario sets reopen to resume or load. Engine tests about what a returning Builder or reviewer is told must set it, because a continued conversation gets a shortened finding index built separately (packages/engine/src/builder-context.ts).
