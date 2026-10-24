# Test foundation and protected delivery

Active implementation plan, agreed with the coordinator on 24 October 2026. This is a work tracker, not a description of guarantees already implemented. Current testing instructions belong in [testing.md](../testing.md); product contracts belong in [design.md](../design.md). When complete, move this tracker to `docs/archive/` and retain the durable rules in their owning documents.

## Resume checkpoint

Read this plan before continuing after a context reset. Verify the checkout, engine status and recorded evidence before treating an item as complete. Update the checkpoint and evidence after each coherent change, review or test run.

- **Working branch:** `repair/test-foundation`, based on main `fb0ac30b011cf103886d368aaa4cf11cb6e8afbe`. Only foundation commit `8be9e365d2aa3a254a442f09e745b31512a4fdc9` is pushed. Subsequent repair commits remain local; main has not advanced. Use the branch log for their exact identities.
- **Implemented local slices:** isolated native/process/file fixtures and startup cleanup; independent repository contexts, repairs, source selection and acceptance routing in the orchestrator; scripted workflow sessions with separate native contracts; UI fixture retention repair. Storage owns its actual SQLite adapter; platform owns shared native process/file boundaries; test support owns the shared runtime, bounded commands, private Git seeds and fixture effects. Package and semantic test migration remain incomplete.
- **Engine:** paused and drained, rechecked after the latest combined run; no active agents, checks or extra validations. Pause operation `coord-user-pause-everything-regroup-20261024` remains complete. Do not resume during this repair.
- **Current work:** audit and restructure every test by behavior and subsystem under the [test-layer design](../testing/layers.md), as the coordinator explicitly requested. This extends steps 2–4 beyond optimizing individual fixtures: separate rules, controllers, presentation, native contracts and representative journeys, preserving meaningful assertions and interaction coverage. CI remains last.
- **Latest complete passing full result:** clean `859543e582dd7c2c56a7c41bcc7e6a4237007428`: 4,663 passed, eleven explicit skips, zero failures in 467,490ms (7m47s), on macOS arm64 / Bun 1.4.2 at normal parallelism. Complete stable evidence is listed below. Engine still takes 421,987ms; substantial cost reduction remains unfinished.
- **Current checks:** the last full run qualifies the earlier storage/test-support extraction and six-workspace gate. The newer platform/fixture extraction passes focused checks and remains due for a complete seven-workspace run. Thirty of the 290 original TypeScript files are semantically audited; 260 original files and the 18 Rust test functions remain pending. The storage-startup audit now retains its real schema/lock tests behind bounded command ownership; its native platform qualification remains due. New or split controls do not inflate original-file completion counts. Subsequent documentation bookkeeping is not a newly qualified code revision.
- **Next actions:** qualify the seven-package platform/fixture split together, then audit the expensive slot-admission/controller and remaining workflow ownership. The synchronous-reader exception/reentrancy defects reproduced in `process-observation-before.json` are fixed with explicit query/time contracts and native watcher controls. Cooperative leases and package moves do not constitute complete process ownership or the remaining whole-suite audit.
- **Package restructuring:** the approved interface-first target is in [test layers](../testing/layers.md#production-package-boundaries). The orchestrator owns portable workflow decisions and contracts. `@petrina/storage` owns the unchanged SQLite snapshots, history, work-log and diagnostic implementations; `@petrina/test-support` owns the shared isolated runner and generic fixtures. Both have package-local boundary tests, participate in full discovery and block engine execution when their checks fail. Native agent/repository adapters and most remaining workflows still live in engine; their extraction is incomplete.
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

Latest complete run: `.test-results/2026-10-24T21-49-30-855Z-7c732f82/results.json`, raw log `.test-results/foundation-storage-support-full.log`. It qualified clean commit `859543e582dd7c2c56a7c41bcc7e6a4237007428`, tree `388c8f71309f989064283ff82df4e470e2041b29`, fingerprint `a5c451a9194be6e288663958eab8b8613eb93427415448403380264d387d8d4d`. All six suite manifests were complete and inputs stayed unchanged. Later documentation bookkeeping does not change the identity of that run.

| Suite | Passed | Explicit skips | Wall time |
| --- | ---: | ---: | ---: |
| Core | 1,083 | 0 | 14,284ms |
| Desktop | 554 | 0 | 24,330ms |
| Orchestrator | 176 | 0 | 1,497ms |
| Test support | 9 | 0 | 599ms |
| Storage | 14 | 0 | 3,453ms |
| Engine | 2,827 | 11 | 421,987ms |

No failure, retry or worker/deadline change was used to obtain this result. The roughly eight-minute full cost remains unacceptable against the target; selected-case improvements have not yet produced a material full-run speedup. This is Mac evidence, not Linux/Windows qualification or proof of the planned delivery gate.

| Work | Implemented and observed | Still required |
| --- | --- | --- |
| Isolated fixtures | Shared private environment, Git identity/configuration, accounts/services refused by default, atomic record writers, bounded owned commands and runtime effects excluded from child JSON | Finish all fixture/native-API audits, native qualification and leftover-resource review |
| Process/file portability | Shared process capability and file/fault/alias boundaries; startup cancellation and failed-start cleanup; portable desktop lifecycle helpers | Review saved task-91172 ownership work separately; finish all adapters and Linux failure diagnoses |
| Production ownership | Orchestrator consumes core-only ports for repository handles, repairs, source selection, acceptance, delivery returns, independent agent sessions, readiness probes/clocks and verifier ballot/answer decisions; package direction is enforced | Agent runtime, repositories, storage and remaining controller extractions |
| Test layers | Complete baseline inventory; twenty-one original files reviewed, 269 pending; new flat tests and native lower-layer imports rejected | Audit every remaining case/variant by behavior, preserve integration and measure cost |
| Local cost | Shared scripted sessions/probes, UI fixture retention fixed, state-only cases stripped of subprocesses, small evidence/usage fixtures, native Git safety matrix split from repeated tasks | Reduce remaining native startup and Git-heavy workflows; repeat whole-suite CPU/memory/process measurements after coherent changes |
| Evidence and selection | Complete stable run reports; conservative affected-test observation | Actual early affected execution; environment-aware reuse and distinct setup/interruption/code outcomes |
| Main protection | Existing configured full checks and local landing revalidation retained | Generic product-defined exact-candidate required-CI validation, concurrent updates, own repository CI and coherent engine promotion/rollback |

Recent focused evidence is under `~/.petrina/coordinator-diagnostics/test-revamp/`:

- `storage-support-full-result.json` indexes the complete six-workspace run, retains each native package's distinct timing file, reconciles exactly five new guard/gate controls against the previous 4,658 passes, and records the twenty slowest engine cases/files. The scoped post-run marker scan found no surviving private runner/command/lease programs. This uninstrumented run supplies no new CPU/RSS/process totals or native Linux/Windows qualification; no material whole-suite speedup is established.
- `platform-command-boundary-next.json` records the next consumer/adapter design before implementation: native process/filesystem primitives in a shared platform owner, test commands and Git-environment cleanup in test support, and a bounded existing command result for the actual SQLite startup controls. `process-observation-before.json` records the original synchronous-throw/unhandled-watcher and double reentrant read failures against the current implementation. Its diagnostic process stopped cleanly; this is a real regression target, not passing package evidence or a reason to restart an already running suite.
- `storage-support-reconciliation.json` confirms unchanged executable bodies for all four SQLite modules, seven shared helpers and three canonical fixture functions. All original case declarations and assertion lines remain in SQL logging, usage history, filesystem aliases and the split atomic-publication/consumer controls. The first type run caught an overwritten filename; the existing core check-evidence module was restored byte-for-byte and the portable shape placed in `related-check-contract.ts`. The first runner diagnostic recorded stale entry paths and old four-workspace interruption expectations; after those failures were established, its confirmed owned runner was deliberately stopped (143) and the callers corrected to the single exported runner path. It is not passing evidence. `storage-support-runner-reviewed.xml` records 93 passes / 709 assertions across seven runner files in 22.95s; `storage-host-neighborhood.xml` records 75 native history/work-log/evidence passes / 1,952 assertions in 15.19s. The last guard addition passes separately (31 cases, 193 assertions). The package-local suites pass 9 fixture and 14 SQLite cases; all 1,083 core cases, workspace types, frozen install and conventions pass. No whole-suite speedup or complete platform qualification is claimed. The original startup schema/lock controls remain present and pending a stronger bounded-child audit.
- `process-lease-full-result.json` indexes the latest complete run and its twenty slowest files/cases. Five new boundary controls reconcile 4,653 previous passes with 4,658 now; no original command case, assertion or skip changed. Repositories (210,684ms), proof requests (192,418ms) and screen review (143,538ms) remain dominant file costs under contention. The scoped post-run marker scan found no surviving private runner/command/lease programs. No material whole-suite speedup, new CPU/RSS/process totals or native Windows/Linux qualification is established. `slot-admission-next-layer-audit.json` maps the five current slot cases to their actual owners; their migration and complete audit remain pending.
- `review-reports-full-result.json` indexes the preceding complete b03b03a8 run, reconciles its thirteen additional controls and records the twenty slowest cases/files. Repositories (236,398ms) and proof requests (198,052ms) were dominant file costs under contention. `orphaned-fixtures-before.json` and `orphaned-fixtures-cleanup.json` record three same-user orphaned Bun fixtures, 19–31 hours old, with exact private test paths and no direct children; identity-checked SIGTERM stopped all three. They predate that run. The current matching fixture pattern is repaired below; that controlled reproduction does not establish why the old programs survived their original deadlines.
- `abandoned-command-before.json` records the controlled failure before release/PID capture: the original fixture finally block leaves its starter running. `process-lease-case-reconciliation.json` confirms every original command case declaration and assertion line remains, with no subject-runner change. A shared cooperative lease gives each long-lived actor a private connection before its body runs, refuses late bodies and ends actors when teardown or owner death closes the connection, with no saved-PID signals or lifetime timer. The escaping worker still has a five-minute natural lifetime; it uses Bun instead of sleep to honor ownership. Five additional controls prove failure before capture, late startup, independent simultaneous owners, normal completion and abrupt owner death. `process-lease-reviewed.xml` records 94 passes, one explicit Windows-native skip and zero failures across six process/runner files (438 assertions, 47.10s). Workspace types and conventions pass. The scoped post-run marker scan in `process-lease-after-processes.json` found no remaining fixture programs. The subsequent complete parallel run also passes; native Windows/Linux qualification remains due. This is no claim that cooperative actors can clean up paused or uncooperative programs.
- `rust-host-preliminary-layer-audit.json` classifies the eighteen original Rust cases: thirteen rules/data transformations and five real process lifecycle contracts. Every function was read, but migration and native qualification remain pending. `acceptance-next-layer-audit.json` identifies twenty-two pure acceptance variants plus three actual demo/simulator variants. Neither preliminary map advances completion counts.

- `review-reports-reconciliation.json` proves unchanged bodies for seven evidence/history helpers and the actual report/settlement methods after explicit port substitutions, including the unchanged proof/learning prefix. `review-owner-case-reconciliation.json` retains all 42 remaining native declarations/assertions after twelve ownership variants move to the controller. `finding-case-reconciliation.json` retains all ten original cases and every assertion across four layer owners; a new formatter-reader control is additional. Core now has 1,083 passing cases and orchestrator 176. The pre-migration native neighborhood passes 203 cases / 2,921 assertions in 45.67s; `review-reports-native-reviewed.xml` records 283 native cases / 3,728 assertions / thirteen files passing in 56.18s after migration, including saved-owner repair/archive, every shared-fix restart order, evidence, sandbox, permission/browser and process-lifecycle controls. Workspace types and conventions pass.
- `activity-reader-reconciliation.json` proves unchanged formatter bodies and unchanged non-import ACP/invocation-cache runtime. The native boundary retains the original adapter iteration and first metadata observation. Its first 30-case activity/browser/invocation neighborhood passes; type checks and the transitive layer guard pass. This extraction prevents pure rule tests from importing native accounts/processes; it does not establish a whole-suite speedup.

- `ballot-ownership-full-result.json` indexes that complete run and its twenty slowest cases/files from structured evidence. The leading file costs are proof requests (197,352ms) and repositories (190,290ms); the slowest shared acceptance-return case takes 92,717ms under contention. A native process snapshot after completion found no remaining commands under the engine test directory; this is a scoped observation, not completed cross-platform cleanup qualification. This uninstrumented run does not supply new CPU/RSS/process totals.
- `split-inventory-before.xml` records two failing controls: deleting a reviewed split companion was silently accepted, and malformed split ownership was ignored. The guard now validates every reviewed owner and requires each file to remain present. `split-inventory-reviewed.xml` records 37 quality/runner cases passing, including both regressions and nearby malformed/partial inventories; workspace types and conventions pass. The subsequent complete b03b03a8 run qualifies this guard.

- `core-evidence-reconciliation.json` proves all forty original executed cases and their bodies/assertions remain. The full core suite passes; small rule fixtures replace unrelated demo setup. The actual simulator retains dispatch and continuation coverage.
- `security-case-reconciliation.json` maps all seven unsafe settings to real fetch/push/ref-query adapter cases and one complete task failure/warning route. Positive controls prove the marker helper and hook actually work. The 54-case native neighborhood passes. Comparable selected observations reduce 546 direct launches to 189 and 11.54s to 2.13s; they do not establish full-run CPU/memory or speed savings.
- `delivery-return-extraction.json` reconciles the original routing/preparation code after explicit input/host/decision-result substitutions. Two failing published-owner allowance regressions are retained in `delivery-return-first.json`; all 102 package cases and the 257-case engine neighborhood pass after the narrow fix. Shared work renews only unpublished owners; no complete repair/restart journey was removed.
- `session-port-reconciliation.json` confirms unchanged non-import runtime bodies in the native ACP adapter, message/activity normalization, provider interruption parsing and scripted adapter; all five moved fixture case bodies/assertions remain. `session-port-neighborhood.xml` records 129 passing cases across twelve files in 53.17s, including native sandbox, permissions, usage, lifecycle and browser controls. Two new real-host/scripted-provider cases cover main/parallel fresh starts, resume, unavailable-session fallback and the exclusion of native launch/account details. The session contract now belongs to orchestrator; moving the actual native runtime into its own package remains unfinished.
- `tool-checks-reconciliation.json` confirms unchanged native setup parsing and all 36 verifier declarations/case bodies/assertions. The new controller owns joined requests, cancellable cleanup waits and uncertain observations; fixtures explicitly declare seven readiness results. `tool-checks-reviewed.json` records all 115 orchestrator cases; `tool-checks-reviewed-neighborhood.xml` records 267 passing native/host/verifier cases, zero skips, in 56.50s. Native setup/login, process, sandbox, browser, role/profile handoffs, restart and partial-vote controls remain. This does not complete the mixed verifier file's layer audit.
- The readiness ownership audit found that `AgentRun`'s exit notification could fulfill despite a failed cleanup. It now initiates/awaits the idempotent stop and rejects incomplete cleanup instead of releasing ownership. `probe-ownership-before.xml` records the old implementation failing the actual native browser/process regression; current controls pass. The earlier diagnostic import failure is retained separately as `probe-ownership-before-unresolved-import.*`, not counted as a product failure. A rejected cleanup remains held by readiness and configuration readers.
- Comparable focused observations in `readiness-before-2026-10-24T19-10-12-436Z/` and `readiness-after-2026-10-24T19-11-01-279Z/` retain stable source fingerprints and no observer errors. Removing only unrelated readiness probes from one verifier journey reduces direct launches from 151 to 144: Bun 18 to 13, Git 120 to 119, Node 1 to 0, ps unchanged at 12. Case wall time changes only from 3.786s to 3.663s; no material duration or full-suite CPU/memory saving is claimed. That extraction retained all 49 runtime verifier variants; the later policy migration below moves five of them to the actual controller.
- `verifier-ballots-reconciliation.json` compares all twelve moved phase/seat methods, the eligibility filter, actual vote-admission loop and final settlement against `ba7f40d9`, after explicit port/clock substitutions. Native selection, parsing, blind inputs, actual agents and storage remain outside the controller. Recording now targets the owning task, role-result queries include that task, and unknown participant/ballot input rejects before mutation. All 147 orchestrator cases pass, including 32 new subprocess-free controller cases; 16 new eligibility rules bring core to 1,079 passing cases. `verifier-ballots-settlement-native.xml` records 354 native/shared/restart/evidence cases passing in 94.33s. No original native verifier case was removed in this extraction; cost reduction still requires their semantic migration.
- `verifier-policy-case-reconciliation.json` proves the 32 retained native verifier declarations and assertions are unchanged. Five decision-only variants now exercise the actual ballot controller and round-return rule in seven cases, including reversed answer order; a real preceding Builder prevents a vacuous no-return assertion. `verifier-policy-orchestrator.json` records all 154 controller cases passing and `verifier-policy-native.xml` records 136 native review/context/evidence cases, 1,934 assertions, passing in 54.80s. The original five scenarios launched 442 directly observed subprocesses (365 Git, 39 Bun, 38 process inspections), with stable source and no observer errors. New controller cases perform no native effects under the transitive layer guard; test-runner startup still has a cost. Fresh sessions, third-phase prompts/dispatch, slot/usage handoffs, partial parsing/correction, actual conflict ports and restart controls remain native. This does not prove a material whole-suite improvement.
- `core-ownership-reconciliation.json` retains every original case and assertion from reviews, proof requests, backlog, products and History: twenty declarations and thirty runtime variants. Pure classification, paging, names, proof and aggregate rules are separated from actual Simulator operations. Shared `test/fixtures/state.ts` copies catalogs and overrides privately and constructs tasks through the production initializer; two pure aliasing controls cover nested state and task recipes. `core-ownership-reviewed.json` records all 1,081 core cases passing; types and conventions also pass. These five original files are audited; native or whole-suite savings are not claimed for this data/ownership cleanup.
- `verifier-panel-case-reconciliation.json` proves all eighteen original core panel cases, bodies, assertions and fixture initializers remain under `test/rules/reviews/`, with shared read-only fixture definitions. `verifier-core-reviewed.json` records complete core coverage. This completes one original file's ownership audit; the mixed native verifier and review-context files remain pending.

Earlier failed results, resource rankings, retained native ownership work and per-commit measurements remain in the [historical investigation record](../archive/test-foundation-investigation-20261024.md). Consult it for evidence provenance, not current instructions. Detailed ignored logs and external measurements remain at their recorded paths; do not erase failures or infer whole-suite savings from isolated observations.

## Next local interfaces and migration

Current interface status and next implementation targets:

1. **Agent sessions — complete Mac suite passed.** The orchestrator owns an independent interface instead of `Pick<AgentRun>` / `Parameters<AgentRun.start>`. It defines session identity, confirmed settings, fresh/reopened identity, prompt/guide results, public progress/permissions, cancellation request and confirmed bounded stop. Native commands/environment, child handles, sandbox/browser ownership, ACP objects and operational account/auth/log callbacks stay with the native adapter. Main and parallel host composition retain their actual prompt, fallback and recording paths. Native runtime package extraction and Linux/Windows qualification remain due.
2. **Readiness checks — complete Mac suite passed.** `ToolCheckCoordinator` consumes explicit probe, host and clock ports; `NativeToolProbe` retains actual installation/login operations. It preserves absence versus inconclusive/failed checks, bounded rechecks, cancellation, joined requests and every registered cleanup owner. Requests register before publication to prevent reentrant duplicate admission, and abandoned cleanup timers are cancelled. Actual native exit notifications preserve incomplete cleanup. The verifier fixture supplies explicit observations, with real login/startup/deadline/cleanup contracts retained. Native package extraction and the broader platform/fixture audits remain unfinished.
3. **Verifier tests — controller implemented, migration in progress.** Core owns finding eligibility and panel rules. The orchestrator owns actual saved phases, independent replacements, recovered provenance, partial/corrected answer admission and final settlement, behind identity, normalized selection and task-bound recording ports. Thirty-nine controller and sixteen eligibility cases run without native effects. Five original policy-only variants moved into seven controller cases; all forty-four retained native cases keep their original assertions. Audit each original case and split policy/answer permutations from actual admission, usage handoff, conflict, pause, restart and saved-input interactions. Preserve those interactions; do not call every Engine test a journey or delete an interaction because a smaller rule test passes.
4. **Review reports — controller implemented, partial semantic migration.** Parsed claims, confirmations, disputes and resolutions use a portable data contract. Actual report application and group settlement consume explicit identity, time, role and recording effects; the host retains proof/learnings persistence, parsing, actual participant admission and SQLite restart controls. Twelve explicit-owner variants now exercise the controller; all eight native shared-fix restart orders remain. The mixed findings file has separate core rules, native response contracts, formatter rules and a canonical-fixture checkpoint journey. A layer guard exposed the formatter's native registry dependency; it now consumes a reader composed from the same adapters, with no second provider registry. The complete Mac batch passed on b03b03a8; native package extraction and broader qualification remain due.
5. **Continue qualification.** Reconcile original declarations, parameterized names, assertions and meaningful failure controls after each migration. Retain complete discovery, normal workers and genuine timing contracts. Run another integrated measurement after coherent fixture/controller batches; continue local reliability/performance and native-boundary work through affected feedback and environment-aware evidence. Remote CI/delivery protection remains step 7, after the local foundation and cost work.
