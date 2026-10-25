# Test foundation and protected delivery

Active implementation plan, agreed with the coordinator on 24 October 2026. This is a work tracker, not a description of guarantees already implemented. Current testing instructions belong in [testing.md](../testing.md); product contracts belong in [design.md](../design.md). When complete, move this tracker to `docs/archive/` and retain the durable rules in their owning documents.

## Resume checkpoint

Verify the checkout, paused engine and exact run evidence before continuing. This checkpoint records implemented work separately from qualification still due.

- **Branch and delivery:** `repair/test-foundation`, based on main `fb0ac30b011cf103886d368aaa4cf11cb6e8afbe`. Only foundation commit `8be9e365d2aa3a254a442f09e745b31512a4fdc9` is pushed; subsequent repair commits remain local. Main has not advanced. Do not push or resume during this repair.
- **Engine:** paused and drained; no active agents, checks or extra validations. Pause operation `coord-user-pause-everything-regroup-20261024` remains complete.
- **Execution approach:** three bounded parallel streams own core test layers, repository adapters and agent runtime. The root integrates shared manifests, guardrails, audit records and docs, independently reviews the changes and owns one coordinated required test run. Streams freeze before integrated qualification; focused evidence does not qualify the batch.
- **Latest complete passing run:** clean `ec8a00774ed04b10230f40e57c9c80a72fcfdce7`, tree `64aff21a01a58b0d37b133030f68321cfa2cd65a`: **4,907 passed, eleven explicit skips, zero failures, 313,569ms (5m13s)** on macOS arm64 / Bun 1.4.2 with normal fourteen native workers. `.test-results/2026-10-25T06-22-16-253Z-28e26e9f/results.json` and independent reparsing prove all 361 files across seven workspaces/four executions. Core 1,092, desktop 554, orchestrator 242, native 3,019 plus eleven skips. Earlier failed/interrupted runs remain retained.
- **Latest combined attempt:** clean `6e84085b619c630d75fee46a72334fa9eb5a5621` completed all **431 files across nine workspaces**, with 4,902 pass / eleven explicit skips / eight failures in 287,967ms. All eight failures belong to `required-plan.test.ts`: its private manifest recipe omitted the two newly registered native packages. Adding those explicit fixture inputs preserves every guard/assertion; all 67 testing-rule/runner contracts then pass with 631 assertions. The failed run remains retained under `full-6e84085b/`. The next combined changed-source run is still required; focused correction does not replace it.
- **Measurement limits:** the preceding complete run was 7m05s; a single timing does not establish a durable improvement. OS process statistics report 2,807.83 seconds total CPU and 1,169,539,072 bytes maximum reported RSS; that RSS is not simultaneous process-tree memory. Proper top-twenty subprocess/CPU/aggregate-memory profiling remains due. Evidence lives under `~/.petrina/coordinator-diagnostics/test-revamp/full-ec8a0077/`.
- **Current unqualified batch:** `@petrina/agent-runtime` and `@petrina/repositories` now own native adapters independently of Engine/Kernel. Nine packages are registered and typecheck together; native suites retain one normal worker pool. Core's twenty remaining flat originals are semantically split, preserving 886 runtime variants and 2,372 assertion sites; complete focused core passes 1,093 cases. Native extraction reconciles 103 runtime-source case sites / 556 assertion sites and repository 48 declaration sites / 299 assertion sites. Independent review and a complete integrated run remain due. Exact mappings and limitations: `workstreams/test-layers/`, `parallel-agent-runtime/`, `repositories-batch-ec8a0077/` under the diagnostic root.
- **Audit scope:** all 290 original TypeScript files and eighteen Rust functions must be audited, not just moved. `test-layer-audit.json` records each owner and unfinished mixed files. Currently 65 baseline files are reviewed; 225 originals and all eighteen Rust functions remain pending. Additional focused regression owners do not increase the baseline count.
- **Implemented foundations:** private accounts/Git/SQLite/temp fixtures, portable native process/file boundaries, atomic fixture publication, bounded startup/shutdown ownership, portable execution/repair/source/acceptance/review/screen controllers and exact complete-suite evidence. No automatic retries, worker reductions or new skips conceal failures. The deadlocked `b53aaef4` run was explicitly interrupted; `ec8a0077` removes its unrelated startup wait and qualifies the corrected background/copy shutdown behavior.
- **Next:** integrate/review/qualify the frozen batch, then continue remaining semantic audits and measured bottleneck fixes. Actual affected-test execution, setup/environment-bound check reuse, generic exact-candidate delivery protection, coherent controller/helper promotion and native platform qualification are unfinished. CI investigation/configuration remains last, after local foundations.

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

- [ ] Audit every test by its assertions and behavior owner, with layers grouped by subsystem; migrate mixed files and fixtures, preserving parameterized cases and meaningful native integration coverage. The [migration inventory](test-layer-audit.json) tracks all 290 baseline TypeScript files and 18 Rust test functions; generated discovery is not a semantic audit.
- [ ] Define and implement production package contracts so ordinary rule/controller tests cannot import concrete native adapters. Each package has its own test layers and the complete required runner includes all of them.
- [ ] Profile the slowest 20 tests, including setup, execution and teardown; distinguish parallel contention from isolated cost.
- [ ] Remove redundant expensive setup, reuse immutable seeds with private writable copies, and test isolated decision permutations directly.
- [ ] Keep full interaction coverage for restart, concurrent review, delivery, persistence and cleanup.
- [ ] Keep normal parallelism, assertions and production deadlines.
- [ ] Publish comparable before/after timings with environment and cold/warm setup identified.

Initial targets: focused feedback around 30 seconds and a full Mac suite approaching two minutes. These are targets to investigate, not pre-existing guarantees or justification to weaken coverage.

### Native suite execution design — next local slice

The installed Bun 1.4.2 help and a two-file native control confirm that `--timings` starts measured slow files first under `--parallel`. The runner now validates current-file hints through a pure test-support rule, retains the exact seed/hash in the report, and atomically publishes an optional cache only after a complete stable successful run. Failed, interrupted or source-changing runs preserve prior hints; absent, stale or malformed hints change no required files, assertions, worker limits or success conditions. Thirteen pure controls and 57 native timing/runner controls pass, with types and conventions. The complete `603385f2` run qualifies the change in 485,196ms versus 492,664ms previously, with additional cases. This is no major or controlled causal speedup.

The complete `603385f2` run spends 52,803ms in three separate native preliminary suites before engine begins. Four cleanup variants account for 34.45s of that run; the readiness refinement preserves all 44 process cases and brings those four to 2.33s in a focused run. Complete changed-batch measurement remains due. Preserve package ownership without serializing every extracted adapter package or starting several competing Bun worker pools.

- Keep each package's independent test command and canonical shared runtime. The root registry identifies every required workspace, test file and runner. Validate the participating package commands before grouping; never silently bypass a workspace's custom setup.
- Run the existing Vitest prerequisites first. Execute the required Bun packages together through one owned Bun invocation with its normal worker defaults and private fixture environment. Keep engine's working-directory contract while passing the other registered test directories explicitly. Test against the actual native runner; do not assume cross-package discovery or report path spelling works.
- Separate coordination from effects in test support. The implemented portable suite coordinator consumes the registered execution plan, source identity, cancellation and recorded execution/workspace observations. It preserves the current single-workspace runner, with grouped execution supported by the value contract; bounded native group launching and report/projection adapters remain due. Native launch, output files, source inspection and signal ownership remain adapters. Pass values and cancellation, not Node handles or an engine object, into the coordinator.
- The shared report parser now parses a joint native report once, with real four-workspace success/failure controls and complete prior-report replay. Wire it into the grouped native host. Resolve file identities from the actual execution directory and require exact membership in the registered workspaces. Preserve global/nested counts, per-file cases, failures and skips. Reject missing or unexpected files, contradictory totals, unfinished reports and skipped-only execution. Distribute validated counts to their actual workspace; no synthetic pass for an absent namespace.
- Record the native process outcome and its shared wall time once. Workspace records refer to that execution and retain their own cases and file timings; never sum the shared elapsed time repeatedly or invent individual workspace wall times. A nonzero process exit without attributable case failures remains a failed/incomplete run.
- Propagate shutdown to the owned group through the canonical bounded command runner. Interruption, incomplete output or unconfirmed cleanup cannot authorize delivery. Persist the original outcome, complete source identity and focused diagnostics, including when a workspace never starts.
- Qualify selection policy with scripted effects and report validation with data. Retain a small real multi-workspace Bun control, complete CLI/source-change controls and native interruption/cleanup controls. Compare exact case/skip identities, normal worker configuration, wall time and process/resource costs against the saved baseline before claiming improvement.

This changes Petrina's repository test runner. Generic product check execution and product-defined delivery requirements remain the separate contracts above. It does not replace the full configured gate with a selected subset.

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

## Current qualification and gaps

Latest complete run: `.test-results/2026-10-24T23-35-56-959Z-d827d7e3/results.json`, raw log `~/.petrina/coordinator-diagnostics/test-revamp/duration-order-603385f2/full.log`. It qualified clean commit `603385f2ec2a7ac496363b0e0a4c643aeaf9939c`, tree `d2ce8e43bf5d7dda9026dd5bc2144069c5bae59b`, fingerprint `da94f401484b36f58d6b4539c56c519fe7321b6414614fba50d830a3593d330b`. All seven manifests were complete and inputs stayed unchanged. The retained seeds' digests were verified. Subsequent cleanup-fixture changes have focused evidence only.

| Suite | Passed | Explicit skips | Wall time |
| --- | --- | --- | --- |
| Core | 1,083 | 0 | 14,429ms |
| Desktop | 554 | 0 | 23,394ms |
| Orchestrator | 189 | 0 | 1,580ms |
| Test support | 76 | 0 | 45,697ms |
| Storage | 14 | 0 | 3,417ms |
| Platform | 44 | 1 | 3,689ms |
| Engine | 2,753 | 10 | 391,475ms |

No automatic retries or worker/deadline changes were used. Earlier failed reports remain retained. Total wall time is 485,196ms versus 492,664ms previously; this one warm-hint observation with added cases is no proof of a durable speedup. Native preliminary serialization and expensive workflow fixtures still need improvement. This qualifies the named Mac revision, not native Linux/Windows, current CPU/RSS/process costs or the planned delivery gate.

| Work | Implemented and observed | Still required |
| --- | --- | --- |
| Isolated fixtures | Shared private environment, Git identity/configuration, accounts/services refused by default, atomic record writers, bounded owned commands and runtime effects excluded from child JSON | Finish all fixture/native-API audits, native qualification and leftover-resource review |
| Process/file portability | Shared process capability and file/fault/alias boundaries; startup cancellation and failed-start cleanup; portable desktop lifecycle helpers | Review saved task-91172 ownership work separately; finish all adapters and Linux failure diagnoses |
| Production ownership | Orchestrator consumes core-only ports for repository handles, repairs, source selection, acceptance, delivery returns, independent agent sessions, readiness probes/clocks and verifier ballot/answer decisions; package direction is enforced | Agent runtime, repositories and remaining controller extractions |
| Test layers | Complete baseline inventory; thirty-four original files reviewed, 256 pending; new flat tests and native lower-layer imports rejected | Audit every remaining case/variant by behavior, preserve integration and measure cost |
| Local cost | Shared scripted sessions/probes, UI fixture retention fixed, state-only cases stripped of subprocesses, small evidence/usage fixtures, native Git safety matrix split from repeated tasks | Reduce remaining native startup and Git-heavy workflows; repeat whole-suite CPU/memory/process measurements after coherent changes |
| Evidence and selection | Complete stable run reports; conservative affected-test observation | Actual early affected execution; environment-aware reuse and distinct setup/interruption/code outcomes |
| Main protection | Existing configured full checks and local landing revalidation retained | Generic product-defined exact-candidate required-CI validation, concurrent updates, own repository CI and coherent engine promotion/rollback |

Current evidence is under `~/.petrina/coordinator-diagnostics/test-revamp/`:

- `duration-order-603385f2/result-summary.json` indexes the latest full run, exact source identity, counts, verified hint digests and slowest twenty engine files. `seed-origin.json` identifies the prior passing measurements used in this diagnostic. `owned-process-snapshot.json` is only a late root-process snapshot; it does not establish orphan cleanup. No new CPU/RSS/process totals were measured.
- `review-proof-reconciliation.json` proves both controller function bodies unchanged and accounts for the original ten assertion sites across controller/schema owners. `review-proof-orchestrator-all.json` records 189 passes; `review-proof-native.xml` records five schema/replay/acceptance controls. The remaining native proof-request file is still pending semantic audit.
- `check-admission-layer-audit.json` records why thirteen real Git/check-queue interactions remain together. `check-admission-owned.xml` preserves all original cases and 161 runtime assertions in the explicit journey owner.
- `suite-coordinator-reviewed.xml`, `suite-results-rules-reviewed.xml` and `suite-results-native-first.xml` record the portable policy and shared report controls. `native-group-probe-4106eaa7/replay-result.json` retains exact full-report file/count replay and the real group probe; `case-reconciliation.json` proves the original parser cases unchanged.

Earlier failed results, resource rankings, retained native ownership work and per-commit measurements remain in the [historical investigation record](../archive/test-foundation-investigation-20261024.md). Consult it for evidence provenance, not current instructions. Detailed ignored logs and external measurements remain at their recorded paths; do not erase failures or infer whole-suite savings from isolated observations.

## Next local interfaces and migration

Current interface status and next implementation targets:

1. **Agent sessions — complete Mac suite passed.** The orchestrator owns an independent interface instead of `Pick<AgentRun>` / `Parameters<AgentRun.start>`. It defines session identity, confirmed settings, fresh/reopened identity, prompt/guide results, public progress/permissions, cancellation request and confirmed bounded stop. Native commands/environment, child handles, sandbox/browser ownership, ACP objects and operational account/auth/log callbacks stay with the native adapter. Main and parallel host composition retain their actual prompt, fallback and recording paths. Native runtime package extraction and Linux/Windows qualification remain due.
2. **Readiness checks — complete Mac suite passed.** `ToolCheckCoordinator` consumes explicit probe, host and clock ports; `NativeToolProbe` retains actual installation/login operations. It preserves absence versus inconclusive/failed checks, bounded rechecks, cancellation, joined requests and every registered cleanup owner. Requests register before publication to prevent reentrant duplicate admission, and abandoned cleanup timers are cancelled. Actual native exit notifications preserve incomplete cleanup. The verifier fixture supplies explicit observations, with real login/startup/deadline/cleanup contracts retained. Native package extraction and the broader platform/fixture audits remain unfinished.
3. **Verifier tests — controller implemented, migration in progress.** Core owns finding eligibility and panel rules. The orchestrator owns actual saved phases, independent replacements, recovered provenance, partial/corrected answer admission and final settlement, behind identity, normalized selection and task-bound recording ports. Thirty-nine controller and sixteen eligibility cases run without native effects. Five original policy-only variants moved into seven controller cases; all forty-four retained native cases keep their original assertions. Audit each original case and split policy/answer permutations from actual admission, usage handoff, conflict, pause, restart and saved-input interactions. Preserve those interactions; do not call every Engine test a journey or delete an interaction because a smaller rule test passes.
4. **Review reports — controller implemented, partial semantic migration.** Parsed claims, confirmations, disputes and resolutions use a portable data contract. Actual report application and group settlement consume explicit identity, time, role and recording effects; the host retains proof/learnings persistence, parsing, actual participant admission and SQLite restart controls. Twelve explicit-owner variants now exercise the controller; all eight native shared-fix restart orders remain. The mixed findings file has separate core rules, native response contracts, formatter rules and a canonical-fixture checkpoint journey. A layer guard exposed the formatter's native registry dependency; it now consumes a reader composed from the same adapters, with no second provider registry. The complete Mac batch passed on b03b03a8; native package extraction and broader qualification remain due.
5. **Continue qualification.** Reconcile original declarations, parameterized names, assertions and meaningful failure controls after each migration. Retain complete discovery, normal workers and genuine timing contracts. Run another integrated measurement after coherent fixture/controller batches; continue local reliability/performance and native-boundary work through affected feedback and environment-aware evidence. Remote CI/delivery protection remains step 7, after the local foundation and cost work.

### Portable prompt construction — qualified on 58706d2b

The check-failure wording case now uses two direct Builder-rule variants plus two real-turn composition variants. `PromptContext` requires declared tool labels as data, retained source-hint products are a core rule, and input-manifest construction is pure and separate from exact-message file persistence. The native turn host supplies the current tool catalog. Role formatting no longer imports provider/account or Git modules merely for names or product IDs.

One package-owned, production-created task/context fixture replaces indexing a completed historical demo task. Prompt rules and role-edit wording have separate owners. All 32 current declaration bodies / 188 assertion sites are byte unchanged, all 35 runtime cases retain 3,813 assertions, and the golden contract JSON is byte identical. The seven moved Builder assertion sites still exercise both original variants (13 runtime assertions). Four source-hint rules cover retained order, removed/empty owners and both kinds of unapproved proposals. Native manifest/message function bodies are unchanged. Initial split checks caught a missing continuation import and missing explicit tool data in three test helpers; both are corrected without changing assertions or golden data.

The reviewed native neighborhood passes 115 cases / 1,392 assertions; two actual event-feed workflows pass 236 assertions for exact saved messages, parallel manifests, repairs and resumed rounds. The original 35 prompt cases pass 3,813 assertions; the reviewed default/edited Builder and catalog/composition controls add five cases / 22 assertions. Native check execution, failure reuse, restarts, hooks and delivery blocking retain their existing real checks and Git coverage; only the wording-only workflow case moved. The mixed check-failure file remains pending.

The focused replacement observation falls from 137 direct Git children / 146 unique Git starts, eight Bun children and six process scans to eleven / nineteen Git and no Bun or process-scan children. Review caught and closed a gap by adding the actual app-edited Builder path, alongside the default turn and both wording-rule variants. The reviewed probe overlapped type checking, so its elapsed time is not used as a speed estimate; raw durations remain recorded. All directly observed starts settle, both new files flush and no observer error is recorded. This is a fixture-cost diagnostic, not a whole-suite claim. Evidence and source-body reconciliation are under `prompt-layers-e19eb144/`; types-final.log and conventions-final.log pass; the combined qualification is recorded below.

The complete normal-parallel run on `58706d2b` passes **4,895 / 11 explicit skips / zero failures**, in **425,031ms**, with all **356 exact files** independently reconciled. The worktree and observed inputs stayed stable. This qualifies the local prompt slice; native platform qualification and the rest of the test-foundation plan remain unfinished. The next measured candidate is the review/verifier permutation area; `full-58706d2b/next-case-audit.json` records current boundaries and the native controls to preserve.

### Verifier selection composition — implemented and locally reviewed

The near-usage-limit case in `independence.test.ts` starts a full review/fix/delivery path for two assertions about selected tools and two verifier openings. Its measured diagnostic launches 119 direct Git children / 131 unique Git starts, twelve Bun children and twelve process scans. Existing core panel rules and the portable `VerifierBallots` already own the decisions. Extract their current native wiring into one adapter factory: profile/tool/role metadata, actual quota/readiness selection, and task-bound recording. Reuse the existing three verifier ports; do not pass Kernel into the portable controller or add a test-only entry point.

Native composition tests use the canonical private record fixture with explicit readiness observations, the actual `Kernel.choose` and real SQLite; they need no Git or agent. Preserve the near-limit tool pair and two requested fresh places, including allowed low/medium/high utilization inputs. The retained actual two-fresh-verifier integration case proves admission, while partial-report, pause/restart, native parsing and cleanup controls stay at their own boundaries. Preserve candidate/profile order, preferred effort and the existing no-ready-tool behavior until a separate investigation establishes a defect. Reconcile every unchanged surrounding body and verify nearby actual ballot/recovery workflows before qualifying the batch.

The native adapter now composes the existing ballot ports without passing Kernel into the controller. Candidate-profile ordering and effort preferences moved unchanged to core, with five rule variants for readiness, usable-tool order, standby exclusion and planned/first-profile fallbacks. The original four preference assertions remain. Three native composition cases retain actual quota choice at 0%, 30% and 95% allowed usage. Review found that selected places alone did not prove near-limit session admission: the retained fresh-session journey now also uses 95% allowed Grok usage with four tools available, keeping all nine actual-admission assertions.

The focused quota replacement launches no subprocesses (previously 119 direct Git / 131 unique Git starts, twelve Bun and twelve process scans), with no unsettled starts or observer errors. Twenty-three core rules pass; the 187-case native neighborhood passes 2,044 assertions in 48.17s. The strengthened actual-admission control passes nine assertions in 2.47s. Types and conventions pass. Original surrounding case bodies are unchanged except for that explicit stronger control; both mixed source files remain pending full audit. Initial fixture runs exposed shared-owner ambiguity and missing readiness discovery; corrected fixtures use the original single-product scope and explicit scripted checks. Type checking also caught an invalid readiness literal and an unavailable pure-package clone global; both were corrected without weakening the assertions. Evidence: `verifier-selection-9651ee88/`. Complete changed-batch qualification remains due.

### Check workflow fixtures and shutdown ownership — qualified on ec8a0077

The 34 current check-failure variants retain real Git, check programs, local hooks, SQLite, restarts, cancellation and delivery. Provider replies now compose the existing acceptance-script owner through `AgentSession`, without ACP, account probes or per-turn process cleanup. Held turns use the shared explicit release events; new conversations remain explicitly fresh. Configured Builder titles, summaries and claims stay bound to the turn's starting recipe, and cancellation completes before a promised edit can happen. The actual counted check program is byte unchanged.

Two cases no longer run a whole task: evidence-context inspection directly runs the native check and exercises dirty/committed/restored code, definitions, timeout/empty results and extra requirements; the paused Planner checkpoint starts before any working copy. Reconciliation proves all 26 original declaration names, 331 assertion sites and all 34 runtime variants / 424 assertions unchanged, apart from the fixture owner name. The mixed original file remains pending further workflow/hook ownership migration; no baseline audit count is increased.

The initial diagnostic recorded one missing exit observation. A later otherwise-passing run exposed a Git cleanup starting after fixture removal. Three controlled contracts reproduce the product defect: shutdown awaited agents and drivers but omitted tracked background and review-copy cleanup. Completion now awaits those owners too, re-reading ownership after each group so a finishing driver or cleanup can hand off more work. Immediate save/log-close semantics stay intact; capture removal is tracked. A fourth contract retains a cleanup failure for its caller without losing another pending owner. All 102 cleanup/recovery/follow-up cases pass with 1,226 assertions. Nine shared-reply contracts pass with 34 assertions. No retries, workers, deadlines or original assertions changed.

Final focused measurement across the 34 original cases: 5,306 direct Git / 5,463 unique Git starts, 75 Bun processes and one process scan, versus 5,387 / 5,538 Git, 399 Bun and 324 scans before. All observed final launches settle, all three files flush and no observer error remains. The group takes 7.63s versus 14.76s in those observations. Git cost is still excessive, and these timings do not prove a whole-suite speedup or aggregate peak memory. Evidence, earlier failures and reconciliation are under `check-workflows-4a6dd436/`. Types and conventions pass, and all 106 neighboring acceptance/proof/fixture cases pass with 1,351 assertions. Final review corrected a fixture check definition to use the public configuration API and collected repeated shutdown promises before comparing their identity. The complete normal-parallel suite must still qualify the final source before main can advance.

The first complete run on `b53aaef4` was interrupted with exit 130 after a verified deadlock, not qualified as a pass. The shutdown change had unnecessarily added the browser-startup promise to its wait set; an existing browser regression intentionally holds that promise until after shutdown, creating a cycle. Remove that unrelated wait and preserve stopped-startup scheduling guards. The background/copy ownership fix remains. All 40 browser/shutdown controls now pass with 328 assertions and three existing opt-in browser skips; the held recovery and late-start scheduling assertions are unchanged. The corrected ec8a0077 complete run passes 4,907 cases plus eleven explicit skips; its exact 361-file manifest is independently verified. `full-b53aaef4/interruption-reason.json` records the source, diagnosis and explicit interruption; its raw run and sampling evidence remain retained.

### Committed repository observations — implemented and qualified on e19eb144

The caller probe in `acceptance-fixture-0a70f683/callers/` locates eight tree reads and ten change-identity commands in one committed/final-proof case, including fixture preparation and assertions. Distinct phases need fresh observations; these counts alone do not prove redundancy. Product-check inspection and update preparation are also material callers.

The narrow orchestrator query contract now reads a repository's committed head and tree together, then computes its own-change identity against the captured base and head. It returns per-product trees and change identities from that same observation. The native host supplies Git; ordinary observation tests supply typed results and controlled completion. Canonical repository scopes retain their approved order and ownership.

Acceptance preparation and proof-aware delivery decisions consume the paired values within their own operation. They observe again after agents, checks or other effects that can change code. No global freshness cache; committed identities never substitute for working-copy cleanliness. Missing code stays explicitly unavailable, query failures propagate, and every started peer query settles before its group returns or fails. Ordinary delivery without proof requests retains tree-only inspection. Standalone review change observations retain their existing behavior.

All 242 orchestrator cases pass, including 14 new observation controls for moving refs, independent shared owners, unavailable workspaces/base references, failures during binding/commit/fingerprint reads and pending peers. Native controls cover the version pair, pinned fingerprint, both object formats, dirty working copies, bound paths, an unborn repository and absent/invalid starting bases. Sixteen targeted native/acceptance cases pass with 295 assertions, covering main-only refreshes, shared-product proof, restoration, ordinary reuse and failed-check blocking. A test expectation initially failed type checking because its expected fingerprint could be undefined; the narrowed assertion now requires a fingerprint. The reviewed workspace type and convention checks must pass before committing.

The same single committed/proof restoration probe falls from 92 to 88 directly observed Git children (101 to 97 unique Git Trace2 process starts including descendants), with one Bun child in both. All observed launches settled and the file-end flush is present. All 76 report identities/outcomes match (one selected pass, 75 filtered cases). This is caller attribution, not a full-suite timing or memory improvement claim. Evidence: `repository-observations-11dc2080/{comparison.json,orchestrator.json,native-neighborhood.xml,native-reviewed.xml}` under the diagnostic root. Full qualification remains due after the coherent batch. Native package extraction, affected execution and delivery protection remain separate unfinished work.

The first combined run on `84aa0369` completed all 352 files: **4,883 pass, 11 explicit skips, four failures, 386,577 ms**. The failures are four existing `repository-context.test.ts` cost guards omitted from the focused selection: they counted the replaced initial `treeOf` calls. Their fix observes the preparation phase explicitly, requiring one paired head/tree read per approved product and fresh finishing trees for editing or proof, while retaining every saved-version, acceptance, proof-staleness and reuse assertion. All four variants pass with 74 assertions; the entire repository-context file plus the new native controls passes **48 cases / 446 assertions / 6.54s**. Types and conventions pass. The failed complete run and independently reconciled 352-file manifest remain in `full-84aa0369/`; a new full run is required, not an erased failure or an automatic retry.
