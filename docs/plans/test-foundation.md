# Test foundation and protected delivery

Active implementation plan, agreed with the coordinator on 24 October 2026. This is a work tracker, not a description of guarantees already implemented. Current testing instructions belong in [testing.md](../testing.md); product contracts belong in [design.md](../design.md). When complete, move this tracker to `docs/archive/` and retain the durable rules in their owning documents.

## Resume checkpoint

Verify the checkout and exact run evidence before continuing. Focused results do not qualify an integrated batch.

- **Delivery/runtime:** branch `repair/test-foundation`, based on main `fb0ac30b011cf103886d368aaa4cf11cb6e8afbe`. Main has not advanced. Only early foundation commit `8be9e365d2aa3a254a442f09e745b31512a4fdc9` is pushed. Petrina remains paused and drained. Do not push main or resume during this repair.
- **Work organization:** three bounded streams audit and implement owned areas; the root independently reviews, integrates shared exports/inventory/docs and runs one combined suite. Native diagnostic batches coordinate to avoid competing heavy runs.
- **Latest required full qualification:** clean commit `97f02a6740078a9c105c2a835fbf65cecda98557`, tree `44c9d69c1cead7c157962334a70f512aee370869`, fingerprint `95ba301d7a10a6045cff86be615b1e7d8470afd9e57851f256a6982c6f026fe3`: **5,060 passed /11 explicit skips /0 failures in 258,644 ms (4m19s)**. Independently parsed all 658 expected files, nine workspaces/four actual executions and every raw JSON/JUnit outcome. All 5,037 earlier case/outcome identities remain; 34 additional passing controls are individually accounted for. Environment: macOS arm64, Bun 1.4.2, fourteen native workers. Report: `.test-results/2026-10-25T14-07-45-834Z-6cad0158/results.json`. This qualifies all integrated migrations through runtime boundaries on Mac, including the required actor-lifetime correction; the separate Rust crate passes 30/30. Linux/Windows, resource remeasurement, remaining migrations and the delivery gate remain pending. Earlier 307,643/330,483 ms results remain evidence; individual run differences are not a controlled durable speedup.
- **Audit inventory:** **280/290 original TypeScript files reviewed; 10 pending**. Baseline digests, declarations and assertion counts remain in `test-layer-audit.json`; new regression owners do not inflate this count. The thirty-file checks/validation, two-file shared-repository and thirteen-file source/context batches are integrated.
- **Coordinator context integration:** eight originals retain all98 runtime variants and580 matcher ASTs, with nine actual message-state algorithms moved to core and real packet/ACP/persistence controls retained. Frozen patch28paths verified independently; original core2/native96 plus shared owner10 controls pass. Root integration also fixes the pre-existing unbounded async-predicate wait with explicit clock effects; nine controlled-deadline rules and ten owner/file controls pass19/0. Root final-source integration passes158/0/2229expectations/19exactowners/11.92s plus movedcore2/0/120ms; all9types/conventions pass. The latest complete qualification remains97f02a67. Evidence: `workstreams/coordinator-context-next/` and `workstreams/coordinator-context-review/`.
- **Terminal slice integrated and reviewed:** normal CLI formatters and script/detection policy have runtime owners; native terminal code and contracts also moved to agent-runtime. All42 original cases and79 matcher sites remain, with one additional native failure-path cleanup control. Independent review found and root fixed impossible actor-readiness waits. A separate unchanged `output()` lifecycle gap still requires repair before final boundary qualification: it kills a short helper without awaiting/escalating its exit, and read failure can bypass that cleanup. No native incident/reproduction is claimed. Final moved-source focused integration passes in the combined158-case run above; full/platform qualification remains due. Engine remains paused.
- **Startup retry fixture:** the silent native startup retains its original1000ms deadline. Review found that the healthy retry's intended12000*SLOW allowance was changed on a copied-away input object; it now updates the actual fixture Engine option and awaits retry. A short plan and explicit approval stop incidental downstream work. The original case/two matchers plus two configuration controls pass1/0/4expectations/1.86s; independent review/types pass. Evidence: `workstreams/root-start-next/` and `workstreams/root-start-review/`.
- **Review-flow integration:** fourteen originals retain all270 runtime identities/159declaration groups and original helper assertions. Exact settled-history/side-step/round-completion/acceptance bodies have core/controller owners; native schema, code identity, session, copies, permission, SQLite and actual Git/SSH controls remain. Root review fixed valid-JSON/nonzero-exit acceptance and before-handoff setup cleanup through canonical helpers, preserving both errors on uncertain cleanup. Current Git literal/path quoting and coordinator-message imports were composed rather than overwritten. Final root target passes277native/support cases/64files/3354expectations/36.81s plus core3/controller16:296total,26newcontrols, no missing original identity. All9types/conventions pass. This is focused integration, not a full/resource/platform claim. Evidence: `workstreams/review-flow-next/{handoff.json,root-review.json,root-qualification.json}`.
- **Delivery/guidance integration:** fifteen originals retain263runtime identities/181declarations/1398original matcher sites. Exact destination ordering/admission and lesson-offer controllers now have portable owners; file/Git/provenance/writer/publish/restart boundaries remain native. Root independently checked all71frozen paths,34body-parity comparisons and8assertion substitutions. Per-fixture setup/restart/body cleanup now owns active Engines/apps and retains folders on uncertainty. Final integrated target:259native0fail0skip/26files/2431consoleexpectations51.084s plus core6/controller10,275total;12newcontrols individually accounted. Root also moved the metadata-only admission setup inside its cleanup scope; corrected owner1/0/7assertions250ms and Engine types pass. All9types/conventions pass; complete suite/resource/platform qualification remains pending. Evidence: `workstreams/remaining-delivery-next/{self-review.md,root-audit/case-audit.json,root-parity/source-parity.json,root-qualification.json}`.
- **Implemented foundation:** private account/Git/SQLite/temp fixtures; owned process/file boundaries; atomic fixture publication; scripted orchestration and separate native contracts; exact-file, source-bound complete-suite reports. The affected-test CLI executes conservative early feedback but cannot authorize delivery. Generic product fast-feedback settings remain unfinished.
- **Latest integrations:** twenty provider/usage originals preserve 173 declarations/1,344 matcher sites. Twenty-eight state/API originals preserve 190 runtime identities and 1,120 matcher sites, with reviewed splits/additions. Review corrected sandbox observation overwrites, hidden upward fixture dependencies, implicit readiness and process cleanup ownership. Detailed evidence lives under `parallel-agent-runtime/provider-usage-next/`, `workstreams/provider-usage-review/`, `workstreams/state-api-next/` and `workstreams/state-api-review/` in the diagnostic root.
- **Qualified child-fixture guard:** `53b99b57` rejects statically proven native child fixtures that depend upward on another package's workflow simulator. All 54 focused guard/selection/quality controls pass (385 assertions); types/conventions pass. Dynamic/generated launches still require review. The complete 8f7e2893 run qualifies this slice on Mac; other platforms remain pending.
- **Resource command:** `bun run test:resources` and its observers/reporting are in the repository; see [metric definitions and limits](../testing/resources.md). The separate diagnostic on clean `ad835042` completed 4,999 pass /11 skip /0 fail in 322,722 ms with unchanged workers. It observed 120,798 launches with PIDs, 39 failed starts, 105,888 Git launches and 9,477 Bun launches. One-second samples peaked at 197 process entries (including zombies), 10,731,421,696 summed RSS bytes (shared pages counted repeatedly) and 1143% rolling CPU across fourteen logical CPUs. These are scoped observations, not exclusive per-test or total lifetime resource costs.
- **Measured priority:** `repositories.test.ts` accounts for 12,433 observed launches across 74 cases; its slowest case takes 100 s /744 launches under full contention. Sources and review-context follow at 7,838 and 5,934 launches. The shared-repository stream is reducing unrelated workflow setup while retaining real Git/SQLite/repair/restart interactions. Normal workers/concurrency and meaningful assertions remain.
- **Reviewed profiler corrections:** native case labels used formatted stack text; worker completion records now supply actual file identities. Getter-backed driver counters serialized as an empty object; explicit field copying handles runtime bigint CPU readings. The old run's missing root counters cannot be recovered. Its raw events/run remain unchanged; derived rankings were rebuilt with the repository command, preserving launch counts and results. Independent review corrected unavailable file metrics and total-only CPU readings. Sixteen focused controls /52 assertions pass; all package types/conventions pass. Artifact folder: `.test-results/resources/2026-10-25T10-38-09-037Z-03f3e1c3/`.
- **Checks/validation integrated:** thirty originals now have sixty owners. All 399 existing passing cases and 2,258 original assertion sites remain; three native parser controls, one fingerprint control, two method-binding controls and two reused-row variants add eight cases/twenty-five assertion sites. Root native 361 pass /7 unchanged skips /52 files passes in 52.29 s with exact file reconciliation; full core 1110 /controller 290 before the final two snapshot variants; the complete run records controller 292, all nine types and conventions pass. Review moved native process parsing out of orchestration and fixed method-backed callback ownership and snapshot process identities before a native reader can reuse its objects. The complete 8f7e2893 run qualifies this slice on Mac; other platforms remain pending. Evidence: `workstreams/checks-audit-next/`, `workstreams/checks-audit-review/`, `workstreams/checks-audit-root/` and `checks-integration-notes.json`.
- **Rust integrated and reviewed:** all eighteen original functions and 56 assertion sites remain, with bounded startup/stop, retained ownership and independent held-pipe controls. Root review and full Tauri crate validation pass 30/30 in 8.34 s on Mac (compile 2.29 s); the prior 18-case baseline and 12-case small harness remain separate evidence. Linux/Windows native qualification and final combined review remain due. Evidence: `workstreams/rust-native-next/` and `workstreams/rust-native-review/`.
- **Development server:** coordinator-requested `8d08bce6` adds `.tunnelite.com` to Vite's explicit allowed-host list. The server was restarted at `http://localhost:1430/` without that environment variable; localhost, the root domain and a subdomain return 200, a lookalike domain 403, desktop types pass. This change postdates the latest full run. Engine boot `12b895de9db7` is still paused/drained; the web restart did not restart it.
- **Fixture/CLI audit:** three originals now have five package-owned contracts, preserving all 16 cases/103 matcher sites. The GitHub fixture waits for all 24 readers to report actual file-lock contention, replacing an arbitrary 100 ms sleep; owned command cleanup settles failure paths. CLI consumes a narrow call interface; generic native HEAD reading lives in test-support with its old fixture export retained. Independent review finds no blocker; native 16 pass/0 fail/1.452 s and all nine types pass. Complete Mac qualification now97f02a67. Evidence: `workstreams/root-fixture-cli/` and `workstreams/root-fixture-cli-review/`.
- **Shared-repository integration:** two originals now have focused repository, acceptance, delivery and cleanup owners. All 119 current-original runtime variants and 725 matcher sites remain; earlier partial migrations stay recorded separately. Ten added policy controls are separate. Root and independent review agree on the two exact core extractions and native fixture fidelity. Root integrated native118pass/0fail/25files/16.91s, nine core and two controller cases, all nine types and conventions pass; complete Mac qualification now97f02a67. Evidence: `workstreams/shared-repositories-next/` and `workstreams/shared-repositories-review/`.
- **Source/context integration:** thirteen originals now separate planning/assignment/identity rules, portable profile/participant/source-cache policy, native inputs/schema/Git/ACP and full convergence journeys. All 222 current-original runtime names and 1,172 matcher sites are preserved among 227 cases/1,181 sites. Independent review verifies exact production parity and all frozen files; root replaced an unnecessary unknown-method cast with actual bound methods. Root integrated native188pass/0fail/34files/29.18s, core26/controller13, all nine types and conventions pass. Complete Mac qualification now97f02a67. Evidence: `workstreams/source-context-next/` and `workstreams/source-context-review/`.
- **Coordinator record boundaries:** four originals preserve 33 runtime cases/175 matcher sites. HTTP/WebSocket cases now own separate Engine/database/ports, private address-query effects replace shared module spies, and timer interception runs in bounded owned children. One login policy now exercises the actual portable selector; generic progress diagnostics have one test-support owner. Root native32pass/0fail495ms and portable1pass; review adds and qualifies a real nonzero-child observation control. Failed fixture-state attempts remain recorded; complete Mac qualification now97f02a67. Evidence: `workstreams/root-coordinator-next/` and `workstreams/root-coordinator-review/`.
- **Runtime boundaries integrated:** twenty-six originals preserve all 295 runtime outcomes, 201 registrations (including a conditional title), 1,637 matcher sites and original concurrent/deadline annotations. Typed process/drain/idle effects and real native browser/startup/stop/recovery/check/cleanup contracts replace unrelated prerequisites. Browser startup disposal, method receivers and actor self-expiry controls are fixed. Independent review closed no open findings; root also removes the unused unsafe self-expiring background fallback. Root applied-source24nativepass/0fail/6files18.07s, five portable controls and all nine types/conventions pass. Complete Mac qualification now97f02a67. Evidence: `workstreams/runtime-boundaries-next/` and `workstreams/runtime-boundaries-review/`.
- **Remaining order:** finish local semantic audits and measured cost reduction; complete setup preflight/outcome classification and environment-bound reuse; finish optional product feedback configuration; then implement the generic exact-candidate remote-CI/delivery contract and coherent engine promotion/rollback. Native supported-platform qualification, final combined audit and main protection remain required.

The diagnostic root is `~/.petrina/coordinator-diagnostics/test-revamp`. Retain failed/interrupted attempts: `full-6e84085b/` has eight manifest-fixture failures corrected before the passing full run; earlier deadlock and fixture failures are not erased by later passes. One green Mac run does not complete this plan.

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
| Test layers | 280 of 290 original TS files audited; all 18 original Rust functions audited; shared rule/controller/native/journey package owners | Audit the remaining 10 originals, preserving meaningful native coverage and variants |
| Native ownership | Typed process/file/browser boundaries; startup/stop/restart controls; uncertain cleanup retains ownership | Complete remaining terminal/API fixture work and supported-platform qualification |
| Performance | Reusable resource command; exact-case/full-run timing and launch attribution; latest Mac full run 4m19s | Repeat resource measurement on the completed migration; improve the remaining major costs without weaker assertions/workers |
| Early feedback | Repository-specific affected execution, conservative dependency/coverage selection and explicitly nondelivery evidence | Generic optional product feedback configuration and final combined guard review |
| Check evidence | Current code/check/hook identities, complete-run/source-bound reports and interruption records | Setup preflight, separate environment failure and environment-aware reuse after repairs |
| Main protection | Existing configured full checks and local landing revalidation retained | Product-defined exact-candidate required-CI flow, concurrent updates, native CI and coherent engine promotion/rollback |

The reliable local foundation and protected delivery are both required. Petrina remains paused; main has not advanced.
