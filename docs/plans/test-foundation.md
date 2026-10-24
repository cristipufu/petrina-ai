# Test foundation and protected delivery

Active implementation plan, agreed with the coordinator on 24 October 2026. This is a work tracker, not a description of guarantees already implemented. Current testing instructions belong in [testing.md](../testing.md); product contracts belong in [design.md](../design.md). When complete, move this tracker to `docs/archive/` and retain the durable rules in their owning documents.

## Resume checkpoint

Read this plan before continuing after a context reset. Verify the checkout, engine status and recorded evidence before treating an item as complete. Update the checkpoint and evidence after each coherent change, review or test run.

- **Working branch:** `repair/test-foundation`, based on main `fb0ac30b011cf103886d368aaa4cf11cb6e8afbe`. The first foundation batch is reviewed for repair-branch publication; inspect Git log/status for its current commit. Main has not advanced.
- **Engine:** paused and drained, rechecked on 24 October 2026 during the structured-evidence work. Do not resume it during this repair.
- **Current work:** steps 2–3, completing isolated fixtures and owned asynchronous teardown; step 4 has baseline measurements and initial schema work.
- **Latest full result:** the fourth complete Mac run passed in 465,231ms (7m45s), with stable inputs and complete file manifests: 2,789 engine passes, 10 existing opt-in/platform skips and no failures. Subsequent audit fixes and revision metadata have focused evidence and await full native CI on the committed candidate.
- **Current checks:** workspace type checks and conventions pass. Teardown, process-boundary, extra-validation and atomic-writer regressions pass. The broader audit and final validation remain required before committing or delivery.
- **Next actions:** publish the reviewed foundation batch to the repair branch for native CI, inspect each platform's results, then continue performance work and the remaining phases. The generic engine/repository boundary is specified below.
- **Later work remains:** Linux root causes, measured suite-cost reduction, actual affected-test execution, environment-aware check reuse, protected candidate delivery, coherent engine promotion and final platform qualification/audit. None is complete merely because a focused test passed.

## North star

A clean checkout produces repeatable results without relying on a developer's accounts or machine settings, gives agents fast feedback, and cannot reach main without complete validation of the actual code being delivered.

Failures must be reproducible, attributable and contained. An environment failure must not become an endless Builder loop. A partial run, affected subset, missing platform run or later diagnostic pass must not silently authorize delivery.

The coordinator implements this repair directly. Petrina remains paused throughout implementation and the final review. Preserve unfinished task branches and unrelated work. Close superseded repair tasks only after their work has actually been integrated and validated. Do not resume scheduling without the user's instruction.

## Design: repository requirements and generic engine behavior

**The engine enforces a product's requirements; each product defines what validation it needs.** Petrina's own testing setup and Petrina's behavior as an engine have separate contracts. The delivery-validation behavior below is planned work, not a guarantee already implemented.

### Petrina's repository

This project supports macOS, Linux and Windows, so its CI must validate those platforms. Its own test runner will provide isolated fixtures, project-specific affected-test feedback and a full-suite delivery check. The supported-platform matrix, browser provisioning and Bun dependency analysis belong to this repository's configuration and tooling. Other products do not inherit them.

Affected-test execution gives early feedback; it cannot substitute for the full configured checks on the actual integrated candidate. Missing platform evidence matters when that platform is required by the product. A developer on macOS obtains required Linux and Windows evidence from provisioned native CI runners rather than being expected to run those operating systems locally.

### Petrina's engine

The engine follows each product's declared requirements without assuming a language, test runner or operating-system matrix:

| Product configuration | Engine behavior |
| --- | --- |
| Local checks, no required remote CI | Run the configured local checks and deliver through the existing gates. No new remote CI requirement is imposed. |
| Direct delivery to a branch requiring CI | Prepare an exact candidate, obtain the required successful CI results, then advance the destination safely. |
| Pull-request delivery | Run local checks, publish the branch and open the PR. The repository controls merging; Petrina never merges it. |
| Optional fast-feedback command | Run the product's command for early feedback; retain its configured full checks for delivery. |

The engine understands required check identities and successful completion, not hardcoded platform names. One repository may require Linux and Windows checks; another may require only a web test job.

Read the destination branch's existing GitHub requirements. Coordinator-owned product settings may add requirements and define how candidate validation is triggered. Agents must not silently weaken those requirements. If CI runs only for PRs, direct delivery needs an explicit supported validation route first. Detect and explain that configuration problem early; do not wait indefinitely or send the Builder through repeated fixes for unavailable validation.

### Exact candidates and concurrent deliveries

For direct delivery requiring remote CI, prepare the candidate against the current destination and push it to a working validation branch. Wait for all required checks to complete successfully on that exact candidate. Missing, failed, cancelled, skipped or incomplete required execution cannot authorize delivery.

Before advancing the destination, verify that the candidate still includes its current tip. If another contributor advances the destination and integration changes the candidate, prepare the updated candidate and obtain fresh evidence before trying again. Advance through a normal, non-forced Git push; a non-fast-forward rejection means a concurrent update won the race and requires reconciliation. Never overwrite another contributor's work or treat an earlier candidate's CI pass as evidence for a different integrated result.

Local-only delivery retains its configured local validation gates. PR delivery remains a separate publishing path and never becomes a Petrina-managed PR merge.

### Implementation boundary and order

1. Finish Petrina's own fixture, reliability and performance work.
2. Add the generic delivery-validation contract: configured requirements, exact candidate identity, required results and handling destination changes.
3. Configure Petrina's own repository to require its supported-platform CI before direct delivery.
4. Qualify local-only projects, projects requiring remote CI and PR delivery separately, including failures, restarts and concurrent deliveries.

Affected-test selection remains project-specific. Petrina's Bun analysis belongs to its repository runner; the engine may execute an optional fast-feedback command but must not apply that analysis to arbitrary Python, Rust or other projects.

## Boundary policy

| Dependency | Required test foundation |
| --- | --- |
| Model providers, quotas, GitHub responses | Scripted fake agents and local protocol servers; no real accounts. |
| Git | Real Git in private repositories with private configuration, identity and local remotes. |
| SQLite | Real private databases; actual files for restart, persistence and durability cases. |
| Processes and shutdown | Small owned real programs for signals, crashes, ownership and cleanup. |
| Scheduling, retries and workflow decisions | Controlled clocks and explicit ready/release/completion events; real waits where a deadline is the behavior being tested. |
| Browsers | Component tests plus selected real-browser tests; provision the matching browser and OS dependencies once before testing. |
| Native coding harnesses | Separate explicit compatibility checks; required ordinary tests never depend on installed harnesses, saved login or available quota. |

Mocks must not erase the Git, SQLite, transport and process interactions that the test is meant to prove. Keep full workflow coverage where the interaction is essential; avoid constructing a complete workflow for every isolated decision.

## Ordered implementation and exit evidence

Statuses: **pending**, **in progress**, **implemented, unverified**, **verified**. Only recorded evidence can advance an item to verified. Update this file after each coherent change or validation result; a context reset is not a reason to restart completed work.

### 1. Establish the baseline and review saved work — in progress

- [x] Confirm Petrina is paused and drained through `engine status`.
- [x] Confirm the starting checkout is clean and record its revision.
- [x] Create one repair branch, `repair/test-foundation`.
- [x] Read the current guide, architecture, safety contract, testing instructions, CI and runner/fixture code.
- [x] Record a fresh full baseline with environment/input fingerprint, per-suite timing and slowest 20 tests; continue setup/teardown attribution during performance work.
- [x] Review and integrate useful non-clock work from task-96018 (machine-independent fixtures) and task-140486 (process completion during heavy setup). Native qualification is tracked separately.
- [ ] Assess task-91172's production process-ownership changes separately, including its remaining findings.
- [x] Read task-111176's fixture consolidation requirements as the audit checklist; preserve all other task branches. Completing that checklist still requires native qualification and the remaining ownership/assertion audit.

Exit evidence: named starting revisions and reviewed diffs, retained original failure logs and a comparable timing baseline. Importing saved code alone is not completion.

### 2. Finish shared isolated fixtures — in progress

- [ ] Reuse and consolidate the existing fixture modules; one canonical definition for each setup responsibility, without another testing framework.
- [ ] Private writable repositories, database, temporary files, ports, process ownership and browser state per test.
- [ ] Ordinary engine fixtures refuse accidental fallback to native coding agents, account probes and unrelated native services.
- [ ] Explicit private Git identity/configuration/environment, including newly cloned repositories and engine Git operations.
- [ ] Deterministic cleanup after success, failure, cancellation and restart; unknown process inspection never counts as confirmed stopped.
- [ ] Matching browser binaries and Linux libraries installed during setup; no downloads or missing-browser skips inside tests.
- [ ] Audit subprocess fixtures for undeclared tools, shell assumptions and platform behavior.

Exit evidence: fixture boundary regressions, hostile developer-environment controls, simultaneous independent fixture controls and observable resource cleanup. Run on clean platform environments.

### 3. Resolve known failures by cause — in progress

- [ ] Diagnose the five recorded Linux process/delivery failures separately; do not assume one cause explains them all.
- [x] Diagnose the latest Mac follow-up timeline assertion and extra-validation temporary-file failure; causes, controlled regressions and subsequent complete Mac results are recorded below.
- [ ] Replace incidental sleeps/races with explicit readiness and release barriers.
- [ ] Retain real deadline and process-termination coverage and nearby failure controls.
- [ ] Preserve original failed mandatory results; a passing focused reproduction does not replace them.

Exit evidence: a cause and regression for each confirmed defect, followed by the relevant parallel suite. No retries, skips, enlarged deadlines or worker reductions to manufacture green results.

### 4. Reduce full-suite cost — in progress

- [ ] Profile the slowest 20 tests, including setup, execution and teardown; distinguish parallel contention from isolated cost.
- [ ] Remove redundant expensive setup, reuse immutable seeds with private writable copies, and test isolated decision permutations directly.
- [ ] Keep full interaction coverage for restart, concurrent review, delivery, persistence and cleanup.
- [ ] Keep normal parallelism, assertions and production deadlines.
- [ ] Publish comparable before/after timings with environment and cold/warm setup identified.

Initial targets: focused feedback around 30 seconds and a full Mac suite approaching two minutes. These are targets to investigate, not pre-existing guarantees or justification to weaken coverage.

### 5. Execute affected tests for early feedback — pending

- [ ] Connect Petrina's existing observation selector to a real early execution command; expose a generic optional product command for engine feedback without applying Bun selection to other projects.
- [ ] Static dependencies plus explicit runtime relationships; coverage may add candidates, never justify exclusions by itself.
- [ ] Include changed tests. Unknown relationships, runner/shared fixture/configuration/dependency changes select the full suite.
- [ ] Distinguish subset evidence from complete evidence in reports and agent context.
- [ ] Final delivery still requires the configured full suite on the current integrated candidate.

Exit evidence: deterministic selection/execution tests, conservative fallback controls, full-run comparisons and no path by which subset evidence authorizes final delivery.

### 6. Correct check outcomes and evidence reuse — pending

- [ ] Distinguish code failure, environment/setup failure, interrupted/incomplete execution and complete success.
- [ ] Preflight compiler, runtime and browser prerequisites before expensive checks.
- [ ] Allow a verified setup repair to trigger fresh validation without a meaningless source edit.
- [ ] Bind reuse to code, check definitions/hooks and relevant execution-environment facts.
- [ ] Preserve bounded failure routing without treating unavailable execution as an ordinary code defect.

Exit evidence: setup-repair and unchanged-code regressions, restart/reuse controls, and no false pass or unbounded repair loop.

### 7. Protect main and promote a coherent engine version — pending

- [ ] Implement product-defined delivery validation: preserve local-only gates, discover required destination checks, support coordinator-owned additional requirements/validation triggers and explain unsupported direct-delivery CI routes early.
- [ ] Validate an exact candidate prepared against the current destination before advancing it when remote CI is required; do not impose Petrina's own platform matrix on other products.
- [ ] Configure Petrina's repository with native Mac/Linux CI and Windows CI while Windows remains supported; local Linux containers are reproduction tools, not substitutes for its required platform evidence.
- [ ] Required CI must execute completely: missing, cancelled, skipped or partial required jobs cannot authorize delivery.
- [ ] Reconcile concurrent destination updates and revalidate changed candidates; use normal non-forced pushes, preserve direct delivery and Petrina's rule against merging PRs.
- [ ] Use engine-owned approved GitHub operations rather than credentials in arbitrary product-check commands.
- [ ] Controller and helper programs come from one stable version; drain before promotion and retain a known-good rollback version.

Exit evidence: separate local-only, remote-CI and PR-delivery controls; gate regressions for configuration errors, stale/missing/partial required evidence, restarts and concurrent landings; successful required native runs for Petrina's actual candidate; and a demonstrated coherent-version launch/promotion path. A post-main CI run alone does not protect main.

### 8. Enforce conventions, review and qualify — pending

- [ ] Mechanical checks for fixture use, accidental native agents/services, shared mutable resources, unsafe global mutations and incomplete reports where statically enforceable.
- [ ] Concise durable rules in AGENTS.md; detailed architecture/setup in docs/testing.md and owning product contracts; no task history pasted into agent instructions.
- [ ] Builder/reviewer prompts state focused verification and evidence requirements without duplicated static instructions.
- [ ] Review each coherent fix before committing; audit the entire batch, including prompts, check routing, CI and cleanup; fix findings.
- [ ] Repeated independent clean qualification runs with normal parallelism; retain every result, timing and required platform artifact.
- [ ] Check for leftover owned processes/files and unintended developer-setting changes.
- [ ] Integrate only after the gate is proved; close superseded task cards only after actual landing; keep Petrina paused.

Completion requires both a reliable test foundation and a delivery gate that protects main. One green suite or affected-only execution is insufficient.

## Current evidence and next action

Updated: 24 October 2026, during structured-evidence implementation.

- Starting main: `fb0ac30b011cf103886d368aaa4cf11cb6e8afbe`. The checkout was clean before this repair branch was created.
- Supported CLI confirmed `status: paused`, `drained: true`, no active agents/checks or extra validations; pause operation `coord-user-pause-everything-regroup-20261024` completed.
- Reviewed the saved task diffs. Imported the non-clock fixture changes from task-96018 and the cooperative setup helper plus its two callers from task-140486 into the working tree. Mac focused coverage now passes; these changes remain uncommitted and have no new full/native-Linux qualification.
- Did not import task-96018's readiness clock: it spies on global Date/timer functions and patches private engine methods. Assess a scoped clock seam instead of adding that approach to the foundation.
- Implemented `fixtureEngineOptions` as the shared policy for in-process engines and the app-mode harness. Missing/empty agent commands are rejected through one engine command resolver, including turns, tool checks, profile probes and follow-up matching. Fake availability no longer depends on native installation. Terminal takeover also refuses native discovery in fixture mode.
- Implemented `test/environment.ts`: private home/settings/Git identity, allowlisted inherited environment, no accounts/provider configuration, and access only to provisioned browser binaries through the isolated cache path. `createTestRun` owns allocation and cleanup for both the full-workspace runner and focused engine runner. No duplicated environment setup.
- Added and preserved boundary regressions, including nested/simultaneous runs, failed-run cleanup, interrupts, Git identity and native-fallback rejection. Restored the pre-existing usage-reader assertions while extending their test file.
- Earlier Mac evidence, before the shutdown-ownership changes: workspace type checks, conventions and `git diff --check` passed. Focused environment/fixture/repository run: 23 passed in 2.33s. Setup/usage/acceptance/runtime/profile/setup-step run: 91 passed in 49.76s. Browser/delivery/conversation/process boundaries: 162 passed, 3 existing opt-in skips, 0 failed in 52.39s. Runner/selection/convention controls: 44 passed in 5.68s. Final native-fallback/Git controls: 9 passed in 0.384s. Log files are under ignored `.test-results/foundation-*.log`. These earlier passes do not describe the latest unfinished convention work.
- Focused checks exposed two errors in newly written assertions (the request argument shape and the existing missing-tool wording); both were corrected and the relevant controls pass. These were test-authoring failures, not waived required failures.
- Removed the imported helper's Perl dependency. The shared `defunctProcess` fixture uses Bun and the system sleep executable to create a real POSIX defunct child/process-group boundary. Its first revision replaced the holder with sleep; review found that cleanup then relied on PID 1 to reap the child, which is unsafe in minimal Linux containers. The current holder pauses before the child ends, then resumes and reaps its own child during cleanup. An initial attempt to resume through Bun's subprocess kill handle failed; a controlled native/handle comparison confirmed CONT was not delivered by that handle, so the fixture uses the native signal for its observed live holder. Retain `.test-results/foundation-owned-zombie.log`, `foundation-owned-zombie-probe.log` and `foundation-owned-zombie-probe-fixed.log` as failed diagnostic evidence. Current focused controls pass: 12 tests in 7.68s, including setup interruption, real zombie/group observations and the lost-check-exit path (`foundation-owned-zombie-fixed.log`). Native Linux qualification is still required.
- The shutdown-ownership convention exposed widespread unawaited asynchronous engine teardown. Migrated 215 ordinary cleanup calls across 29 files in the first pass, then 70 additional calls and the reviewed overlap cases. Preserve intentional replacement-before-drain cases by retaining the old shutdown promise and collecting it after assertions or in final cleanup. The synchronous idle-sleep assertion still verifies immediate release before awaiting its result. Mac regression run: 98 passed, 0 failures in 61.77s, including recovery, terminal takeover, work log, screen review and review continuation. Repository conventions pass. Evidence: `.test-results/foundation-cleanup-migration.json`, `.test-results/foundation-teardown-review.log`, `.test-results/foundation-shutdown-conventions.log`.
- Reproduced the extra-validation temporary-file boundary with a fake client held after preparing metadata and before publishing it as a container. Its old staging location could leave a `.tmp` in the active-container namespace on SIGKILL. Staging now belongs to the client's owned snapshot, so normal interruption cleanup removes it without inventing a container. The controlled interruption and six save-failure/restart cases pass: 7 tests in 6.60s. The initial new test incorrectly expected `did not finish` for explicit cancellation; corrected it to the existing `stopped` contract, retaining process, queue and filesystem assertions. Evidence: `.test-results/foundation-container-publication.log` (initial failure) and `.test-results/foundation-container-publication-fixed.log`.
- Updated AGENTS.md and docs/testing.md to describe the implemented fixture boundaries and setup. No phase is marked complete, and no task has been cancelled, resumed or closed.

The first complete run finished with stable inputs: `.test-results/2026-10-24T06-34-47-091Z-aa44ad9f/`. Total 536,015ms (8m56s): core 15,291ms, desktop 23,537ms, engine 496,054ms. Engine recorded 2,736 passed, 10 existing skips and 5 failures. Raw output is `.test-results/foundation-full-baseline.log`; `.test-results/foundation-full-baseline.json` retains timings, fingerprint and the slowest 20. The slowest completed case was the shared reviewer-conversation/main-update scenario at 119,820ms. This was a diagnostic baseline, not a successful delivery gate.

Causes and subsequent work:

1. **Follow-up live-state snapshot:** the fixture recorded its baseline before consuming the controlled fake planner's plan notification. That legitimate notification added a timeline entry during the assertion window. Now wait for the engine-recorded `planner is working` to-do before the snapshot; keep the full unchanged-state assertion.
2. **Profile cleanup unit host:** the initial command guard was a Kernel method, unnecessarily expanding the host contract. Moved it into the standalone `agentCommandFor` helper in tools.ts, shared by every engine-owned start, and narrowed ProfileChoiceReader's host to the fields it actually needs. Its controlled startup-failure/cleanup test again exercises its original behavior without an unsafe Kernel cast.
3. **Two deadline probes:** nested runner controls used an unnamespaced environment variable that the new allowlist correctly excluded. Renamed the private control to `PETRINA_TEST_DEADLINE_PROBE_WORKERS`; do not admit arbitrary inherited production variables.
4. **CLI lifecycle log race:** production CLI tests started real Codex account readers. Exposed the existing parser as `runCli` with launch/client injection. `test/cli.ts` runs the production parser/launcher with `fixtureEngineOptions`; `test/client.ts` retains the production client's start/ownership code but points it at that CLI, including CLI/MCP starts and restarts. Migrated test client imports and added an enforced import convention. No production environment switch enables the test policy.

Subsequent Mac evidence: 67 baseline-repair tests passed in 7.90s; 39 CLI/lifecycle/ownership/recovery tests passed in 15.49s; 50 runner/convention/instance controls passed in 6.96s. Engine type checks and convention checks passed. These focused passes do not replace the failed full run.

Performance work started with real SQLite schema initialization. Store/history schema setup and WorkLog schema setup now each use one transaction, rolling back partial creation on failure and closing a failed Store's owned connection. SQLite journal/durability settings are unchanged. Added rollback/ownership controls; 50 schema/history/worklog/SQL-log tests passed in 4.76s. A five-sample isolated diagnostic under `~/.petrina/coordinator-diagnostics/test-revamp/` recorded warm median startup around 5.14ms before and 3.52ms after, with variable/slower cold samples. **This does not establish a full-suite speedup.** The next full measurement must determine the effect under normal parallelism.

GitHub read-only inspection confirmed `main.protected: false` and no applicable branch rules. No protection or remote configuration has been changed yet. The candidate-validation flow and repository-level enforcement remain required work, not existing guarantees.

The second full run (`.test-results/2026-10-24T07-19-11-274Z-abfb61db/`, raw `foundation-full-after-isolation.log`, summary `foundation-full-after-isolation.json`) recorded 2,744 engine passes, 10 existing skips and one failure. A defunct child now leads its own group, just as a real check does. The old check cleanup treated the still-present zombie group as live because signal-zero succeeded. Moved the existing final group-state confirmation into `process-tree.ts` and reused it for checks and agent cleanup: only a complete positive observation of all remaining members as defunct confirms an existing group ended. Unreadable lists, live members and inconsistent absence remain unconfirmed. The checks/process-tree/agent-lifetime run passed 101 tests in 50.70s after this fix. Type checks and conventions pass.

That full run showed no material suite speedup yet. Near the end, 13 workers were idle while the serial extra-validation file finished; its 153 native cases took about 194.8s cumulatively. Divided those unchanged test bodies into eight focused files using one `ExtraFixtures` owner, retaining sequential cases within each isolated file and all existing assertions. A structural inventory (`foundation-extra-split.json`) confirms no test body was omitted or changed by the split. Focused parallel evidence: 153 passed, one existing Windows-only case skipped, 0 failed, 2,277 assertions in 33.01s (`foundation-extra-split.log`, `foundation-extra-split.xml`). This focused duration is not a full-suite comparison. The full runner now records Bun's per-file wall times beside its case report; 43 quality-runner/convention tests pass in 5.28s (`foundation-timing-runner.log`).

The third full Mac run passed on stable inputs: `.test-results/2026-10-24T07-46-38-268Z-6260514d/`, raw `foundation-full-after-cleanup-split.log`. Total 481,284ms (8m01s): core 14,581ms, desktop 22,924ms, engine 442,357ms. Engine recorded 2,745 passed, 10 existing opt-in/platform skips and no failures across 206 files. This is roughly 10% faster than the first baseline, well short of the performance target. Per-file wall times show repositories, proof requests, acceptance repair/reviews and independence as the next expensive workflows. This run predates the atomic writer and stricter report parser.

Scenario/script/GitHub fixture writers now use the shared `writeFixtureJson`: serialize, write a private sibling, atomically rename, and remove staging on failure. This prevents one fixture's running fake agent reading that fixture's partially rewritten JSON; it does not share data between concurrent tests. Focused fixture/repository/follow-up/recovery evidence: 80 passed in 39.88s; three final atomic-writer controls, workspace type checks and conventions passed (`foundation-atomic-*.log`).

The report-completeness audit found that a valid fragment or omitted file could previously accompany a zero exit code and be accepted. The runner now records an expected file manifest, parses complete XML/JSON, reconciles cases and totals, rejects unfinished/entirely skipped execution and distinguishes complete from incomplete evidence. Final count controls: 83 passed in 10.55s with workspace type checks and conventions passing (`foundation-complete-reports-final*.log`). Replayed all nine structured reports from the three historical full runs through the stricter parser: original pass/failure/skip counts were preserved. These are diagnostics, not replacement delivery evidence for those historical revisions.

The fourth full Mac run passed: `.test-results/2026-10-24T08-22-39-909Z-d352f839/`, raw `foundation-full-complete-evidence.log`. Stable inputs and complete reports: total 465,231ms (7m45s), core 13,932ms, desktop 21,826ms, engine 428,074ms. Engine: 2,789 passed, 10 existing skips, 0 failures across 208 files. This is about 13% faster than the first baseline and remains far above the two-minute target.

Review preserved the production terminal lookup fallback outside fixture mode (9 boundary controls passed). An AST comparison of the changed test files found 7,170 original `expect` calls preserved except the five deliberately rewritten parser assertions; source/outputs are in `foundation-assertion-audit.json`. Reviewed the extracted extra-validation fixture and the shutdown migration, including intentional replacement-before-drain cases. Follow-up audit fixes require positive `ended` state in stopped-command assertions, apply canonical fixture options to generated lifecycle probes, and wait for all teardown promises before propagating an independent failure. The affected command/lifecycle/extra-validation/delivery/conversation run passed 124 tests in 39.09s (`foundation-audit-fixes.log`); workspace type checks passed. The broader assertion and per-test state audit is still open, including the sequential work-log scenario's shared state and conservative cleanup observations.

Reports now retain commit/tree, clean/dirty state, OS/architecture and Bun identity, reject same-content revision movement, and CI uploads platform artifacts. These final controls passed 84 tests in 11.65s with workspace type checks (`foundation-source-evidence*.log`). They were added after the fourth full run and require committed-candidate native CI. No final platform qualification or protected-main guarantee is claimed.

The final convention pass caught an analyzer gap: it did not recognize the project's `completeAll` collector. The analyzer now recognizes its actual runtime import (including an import alias), still requires awaiting the collector and rejects unrelated or shadowed functions with that name. Collector/source/runner controls: 59 passed in 11.83s, with workspace type checks and repository conventions passing (`foundation-collector-*.log`). No blanket convention exception was added.

The foundation batch is prepared for its first repair-branch commit and native CI. Main remains `fb0ac30b011cf103886d368aaa4cf11cb6e8afbe`, confirmed remotely during this audit. Petrina was rechecked paused/drained; boot `12b895de9db7`, no active agents/checks/extra validations. No task cards were changed. Do not resume scheduling.

Next: push the reviewed foundation batch to the repair branch and inspect native results. Native Linux failures, affected execution, environment-aware reuse, main protection, coherent engine promotion, further performance work, platform qualification and the complete final audit remain pending. Do not interpret the focused passes or the full Mac passes as completion of those requirements.
