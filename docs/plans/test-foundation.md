# Test foundation and protected delivery

Active implementation plan, agreed with the coordinator on 24 October 2026. This is a work tracker, not a description of guarantees already implemented. Current testing instructions belong in [testing.md](../testing.md); product contracts belong in [design.md](../design.md). When complete, move this tracker to `docs/archive/` and retain the durable rules in their owning documents.

## Resume checkpoint

This repair is unfinished. A completed case/owner audit is not completed cost reduction or protected delivery.

- **Runtime and branch:** `repair/test-foundation`; main remains `fb0ac30b011cf103886d368aaa4cf11cb6e8afbe`. Petrina boot `12b895de9db7` remains paused and drained. Do not push main or resume during this repair. Three bounded implementation streams use private checkouts; the root reviews and integrates them, with one full suite at a time.
- **Original behavior audit:** all **290 original TypeScript files and eighteen original Rust test functions** have been read and assigned package-owned layers. Baseline digests/oracles/split owners remain in [the inventory](test-layer-audit.json). This does not certify retained journeys' resource costs. The separate Tauri Mac crate passed30/30; native Linux/Windows qualification remains pending.
- **Latest complete Mac qualification:** clean `1d8c8e90cf4aab8856f69c0ef71c967d3cb23cf4`, tree `00bd07f28e2579dc015f864519576a2a00877d50`, fingerprint `72468f606b97833ff62403ee4231fed3379a39c37792e9108ff5a69ab83b6de5`: **5,195 passed /11 unchanged explicit skips /0 failed, 259,684ms (4m20s)**. Independently verified842 exact files, nine workspaces/four actual executions, fourteen native workers and all raw structured outcomes. All5,071 outcomes from the previous complete run remain, with three explicitly recorded describe relocations and135 additional controls. Report: `.test-results/2026-10-25T18-03-44-518Z-9b922e57/results.json`; verification/case mapping: diagnostic `full-1d8c8e90/`.
- **Retained failed qualification:** preceding `eabc2129` completed in252,833ms with5,194pass/11skip/one failure. A coordinator test aborted its command immediately after requesting a graceful stop; it now uses existing bounded settlement. The correction's26 focused cases, types/conventions and independent review passed before1d's complete run. Original failed reports remain under `full-eabc2129/`.
- **Latest resource baseline:** the same clean1d source, normal workers, all5,195passing cases, no missing file observations/truncation/invalid records/unmatched exits:112,021 observed PID launches,39 separately failed starts, **100,352Git**,7,687Bun and3,830ps. The profiled suite took273,739ms. Samples peaked at168 process entries,10,294,247,424 summed RSS bytes and1268.8% rolling CPU across fourteen logical CPUs. RSS repeats shared pages and child CPU is not exclusive. No processes remained in the final sampled tree; this cannot prove no unobserved child escaped. Artifacts: `.test-results/resources/2026-10-25T18-08-07-116Z-471b771c/`.
- **Cost exit remains open:** Git launches are only about5% lower than the earlier105,888 profile. The top slot-cap case's focused caller trace accounts for744Git launches: nine fixture/support, three product registration and732 actual native stage operations. Its31 literal oracles need scheduling/reservations, not Git results. The actual Driver/Turns/parallel admission owners still need portable execution-effect boundaries; a file move or scripted provider alone is insufficient. Design: diagnostic `workstreams/agent-admission-cost-design/`.
- **Reviewed local cost changes after1d:** the event test now releases fake agents on real progress rather than long-poll expiry (isolated9.320s→1.267s, original oracles/deadline retained). Reviewer browser setup is explicit in four browser-instruction variants instead of29 scenarios; real native controls remain, active Engine/root ownership and atomic script publication are fixed. Operation-scoped fold/save/review version reads reuse exact paired observations and fail conservatively when unavailable. Root integrated86 focused cases across twelve owners (13.17s), all nine types and conventions pass. These are not a new full/resource/platform result.
- **Check execution truth:** a bounded nine-path slice adds native start/exit/pipe/cancellation/cleanup facts and rejects incomplete output as passing. It preserves log persistence separately. Independent review found rejected cancellation could be mistaken for confirmed cleanup; the author corrected that and qualified paired controls. Final peer/root review and integration remain required. Generic outcome routing, declared setup preflight and environment-bound reuse are still open; explicit unchanged-source rerun already exists.
- **Tooling and safety:** private accounts/Git/SQLite/temp fixtures, canonical atomic writers and owned native boundaries are in place, with qualification limits above. The repository-owned resource command and optional bounded Git caller attribution support the cost audit. Native/focused diagnostics remain nondelivery evidence. Vite serves1430 with configured`.tunnelite.com`; it did not resume the engine.
- **Next order:** finish cost-driven production controller separation and measured reductions; complete generic check truth/routing, setup preflight/environment reuse and optional product feedback configuration. Then implement product-defined exact-candidate CI/direct-delivery protection, changing-main/restart/concurrency handling and coherent engine promotion/rollback. Supported-platform qualification, final combined audit and proof that main is protected remain mandatory.

The diagnostic root is `~/.petrina/coordinator-diagnostics/test-revamp`. Preserve failed attempts and exact source-bound reports. Detailed previous migration evidence is [historical](../archive/test-foundation-migration-checkpoint-20261025.md); it is not current guidance.

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

### Portable production and fixture contracts

Production app code and shared tests/fixtures use cross-platform APIs. Where the required behavior has no portable API, keep it behind a small, explicit interface with platform-specific implementations. Filesystem aliases and permissions, process-tree ownership/signals, terminal launchers and native tool probes must not each grow their own platform switch in workflow code or tests. Reuse the existing command, process and environment boundaries rather than building a parallel framework. The coordinator explicitly confirmed that this audit covers both production and tests; finish it before affected-test execution.

Test each adapter's contract with real native controls on its supported platform, including unavailable inspection and failed cleanup. Keep platform-specific behavior tests at that boundary; ordinary workflow tests use the portable contract and private fault injection. An unsupported capability must be explicit, not silently counted as a pass. Native qualification is still necessary because runtime and OS behavior can change; the abstraction contains those changes in one owner.

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
- [ ] Consolidate platform-native fixture operations behind explicit interfaces and qualify each implementation; remove duplicated native setup/cleanup from ordinary workflow tests.

Exit evidence: fixture boundary regressions, hostile developer-environment controls, simultaneous independent fixture controls and observable resource cleanup. Run on clean platform environments.

### 3. Resolve known failures by cause — in progress

- [ ] Diagnose the five recorded Linux process/delivery failures separately; do not assume one cause explains them all.
- [x] Diagnose the latest Mac follow-up timeline assertion and extra-validation temporary-file failure; causes, controlled regressions and subsequent complete Mac results are recorded below.
- [ ] Replace incidental sleeps/races with explicit readiness and release barriers.
- [ ] Retain real deadline and process-termination coverage and nearby failure controls.
- [ ] Preserve original failed mandatory results; a passing focused reproduction does not replace them.

Exit evidence: a cause and regression for each confirmed defect, followed by the relevant parallel suite. No retries, skips, enlarged deadlines or worker reductions to manufacture green results.

### 4. Reduce full-suite cost — in progress

- [x] Audit every original test by its assertions and behavior owner, with layers grouped by subsystem; migrate mixed files and fixtures, preserving parameterized cases and meaningful native integration coverage. The [migration inventory](test-layer-audit.json) tracks all 290 baseline TypeScript files and 18 Rust test functions; generated discovery is not a semantic audit.
- [ ] Define and implement production package contracts so ordinary rule/controller tests cannot import concrete native adapters. Each package has its own test layers and the complete required runner includes all of them.
- [ ] Complete the cost audit of the measured slowest/highest-launch20 cases, including setup, execution and teardown; trace actual callers and distinguish parallel contention from isolated cost. Owner audit completion does not close this item.
- [ ] Remove redundant expensive setup, reuse immutable seeds with private writable copies, and test isolated decision permutations directly.
- [ ] Keep full interaction coverage for restart, concurrent review, delivery, persistence and cleanup.
- [ ] Keep normal parallelism, assertions and production deadlines.
- [ ] Publish comparable before/after timings with environment and cold/warm setup identified.

Initial targets: focused feedback around 30 seconds and a full Mac suite approaching two minutes. These are targets to investigate, not pre-existing guarantees or justification to weaken coverage.

### Native suite execution — implemented and qualified on Mac

The shared runner now verifies each native package command, records every required file and executes all six native workspaces in one normal worker pool after the three Vitest prerequisites. The portable coordinator owns ordering and complete evidence; native adapters own processes, signals, reports and source inspection. Shared duration/exit is recorded once. Missing, contradictory, interrupted or skipped-only required execution cannot become a pass. Current contracts and commands live in [testing.md](../testing.md).

Timing hints reorder measured slow files without removing files or changing workers/assertions/deadlines. Failed or unstable runs do not publish hints. The latest complete qualification is named in the resume checkpoint. Earlier seven-workspace/serial-runner observations are [historical](../archive/test-foundation-progress-20261025.md).

### 5. Execute affected tests for early feedback — in progress

- [x] Connect Petrina's repository selector to real early execution through `bun run test:affected`; focused evidence never authorizes delivery.
- [ ] Expose a generic optional product command for engine feedback without applying Bun selection to other projects.
- [x] Static dependencies plus explicit runtime relationships; coverage may add candidates, never justify exclusions by itself.
- [x] Include changed tests. Unknown relationships, runner/shared fixture/configuration/dependency changes select the full suite.
- [x] Distinguish subset evidence from complete evidence in reports and agent context.
- [x] Final delivery still requires the configured full suite on the current integrated candidate.

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

## Current qualification and gaps

The resume checkpoint names the latest independently reconciled complete Mac run and separate Rust crate run. Those results qualify their named source; passing tests does not complete the remaining semantic audit or provide native Linux/Windows evidence. Older partial progress is retained in [the historical record](../archive/test-foundation-progress-20261025.md).

| Area | Implemented at the qualified source | Still required |
| --- | --- | --- |
| Private fixtures | Isolated accounts/settings/Git/databases/files/ports; explicit fake services; atomic records and independently owned native actors | Finish the remaining fixture audits and qualify supported native implementations |
| Test layers | All 290 original TS files audited; all 18 original Rust functions audited; shared rule/controller/native/journey package owners | Qualify the complete integration, preserving meaningful native coverage and variants |
| Native ownership | Typed process/file/browser boundaries; startup/stop/restart controls; uncertain cleanup retains ownership | Complete remaining terminal/API fixture work and supported-platform qualification |
| Performance | Reusable resource command; exact-case/full-run timing and launch attribution; latest Mac full run 4m19s | Repeat resource measurement on the completed migration; improve the remaining major costs without weaker assertions/workers |
| Early feedback | Repository-specific affected execution, conservative dependency/coverage selection and explicitly nondelivery evidence | Generic optional product feedback configuration and final combined guard review |
| Check evidence | Current code/check/hook identities, complete-run/source-bound reports and interruption records | Setup preflight, separate environment failure and environment-aware reuse after repairs |
| Main protection | Existing configured full checks and local landing revalidation retained | Product-defined exact-candidate required-CI flow, concurrent updates, native CI and coherent engine promotion/rollback |

The reliable local foundation and protected delivery are both required. Petrina remains paused; main has not advanced.
