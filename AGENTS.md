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
- Full suites run inside tasks' automated checks. Use focused tests while investigating, and avoid overlapping full runs on this machine. Commands, fixtures and platform notes are in [docs/testing.md](docs/testing.md).
- Use the isolated `test/engine.ts` fixture for engine tests and `test/fixtures.ts` for lightweight helpers; native accounts and services require explicit integration opt-in. `bun run test:conventions` enforces the fixture and Bun assertion rules. Affected-test reports are observations only: delivery still needs the full configured checks on its current integrated tree.
- Exercise the smallest workflow that proves the behavior. Keep full-path coverage where the interaction is what is being tested; omit unrelated design, planning or check discovery from focused regression fixtures.
- Reuse immutable fixture data through existing helpers, with separate writable repositories and engine state per test. Use controlled clocks, signals or release events for time-independent decisions; keep real waits for assertions about deadlines and process termination.
- Measure expensive new tests and fixture changes in the fully parallel suite. Preserve assertions, isolation and worker counts; do not hide costs or flakes with retries, skips or shorter production deadlines.

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
- In engine tests where a child process writes a file that the test reads as soon as it appears, write it under a temporary name and rename it: a just-created file can be read empty, which happens on this machine under load.
- Bun hides passing test lines when it detects a coding agent (CLAUDECODE, AGENT or REPL_ID set); a test that reads another Bun run's results should use its junit report, which records every outcome.
