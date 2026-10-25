# Test ownership and layers

This is the target structure for the test-foundation revamp. Migration is in progress; a test is not qualified merely because it has moved folders. The [implementation tracker](../plans/test-foundation.md) records completed audits and remaining work. [Testing Petrina](../testing.md) owns commands, provisioning and platform instructions.

## Choose the behavior before the fixture

For each case, name the production behavior, observable result and smallest owner that can prove it. Arrange only the prerequisites that behavior needs. A test of a rule does not need a running workflow; a test of Git must exercise real Git. Mocking the subject itself proves nothing.

Use this hierarchy within each workspace: `test/<layer>/<area>/name.test.ts` (or `.tsx`). Use a further subsystem directory when it separates distinct responsibilities, not to mirror every production file. A feature may have tests in several layers because each layer proves a different contract.

| Layer | Responsibility | Permitted machinery | Examples of areas |
| --- | --- | --- | --- |
| `rules` | Decisions, calculations, validation, transformations and result parsing | Data, pure functions and explicit inputs; no filesystem, database, network, subprocess or running Engine | scheduling, reviews, acceptance, repositories, usage, history, testing |
| `orchestration` | Ordering, transitions, reservations, retries, handoffs and cancellation decisions | The real controller under test, typed scripted effects, controlled clocks and release events; no real external processes or persistent storage | scheduling, review rounds, conversations, checks, delivery, runtime, simulator |
| `presentation` | Rendering, interaction, accessibility and UI state | Components and a private DOM with a controlled application client; no real engine, providers or native desktop | tasks, journey, history, routines, forms, analytics, navigation |
| `contracts` | An adapter's agreement with an actual boundary | Exactly the real boundary under test, private owned resources and controlled peers | git, storage, agents/ACP, processes, browser, filesystem, desktop host, local API, testing/runner |
| `journeys` | Important interactions between the layers | The real engine with private Git/SQLite, scripted providers and local service peers; native agent transport only when the interaction requires it | task lifecycle, review convergence, shared delivery, recovery |

Rust host tests belong to the same conceptual contract areas even though their modules follow Cargo's layout. Actual installed-provider compatibility checks are explicit opt-ins, separate from the required account-independent suite.

## Boundaries run in one direction

Rules take values and return decisions. Controllers call rules and request effects through narrow contracts. Adapters implement effects. The application composes them. Presentation uses an application client. Tests follow these same boundaries.

### Production package boundaries

The coordinator approved extracting production responsibilities as part of this revamp. Packages enforce dependency ownership; each package still has its own test layers. The target graph is:

```text
application host (existing engine entrypoints, CLI/MCP/server and desktop)
  -> orchestrator -> core
  -> agent runtime -> core and consumed contracts
  -> repositories -> core and consumed contracts
  -> storage -> core and consumed contracts
```

`@petrina/agent-runtime` owns native ACP sessions, provider launch/configuration, account readers, browser processes and image files. Its pure report parsers and message decisions have separate source owners and tests. `@petrina/repositories` owns Git/GitHub commands, worktrees, native path resolution and repository/source query adapters. Both consume core data, orchestrator contracts and shared platform capabilities; neither imports the application host. The engine owns workflow admission, recording, persistence and composition. Shared process-environment transformations live in platform.

The host constructs native adapters and supplies them to controllers. The orchestrator never imports concrete adapters. An adapter may depend on the pure contract it implements, including a contract owned by the consuming package; the controller must not import the adapter back. Shared contracts get a separate package only when several owners actually need them. There are no extra services or network boundaries.

| Responsibility | Interface boundary | Native implementation owns |
| --- | --- | --- |
| Agent execution | Open/continue a participant session; send input; public progress and confirmed results; cancellation and confirmed cleanup | Provider configuration, ACP, process and browser ownership |
| Repository work | Inspect a named workspace/version, prepare/fold a change, manage owned copies, publish an approved destination | Git commands, safe environment/credentials, paths and native worktrees |
| Product checks | Execute declared commands against a pinned workspace; return complete outcomes and provenance | Owned check processes, output, deadlines and environment preflight |
| Persistence | Load/checkpoint canonical state, record evidence and retrieve focused history; atomic changes remain atomic | SQLite connections, transactions, schema, indexes and durable files |
| Time and notifications | Explicit current time, cancellable deadlines, recorded events and change notification | Host clock/timers and delivery of notifications |

Define each port from its consumer's actual operations, not a generic `execute(command)` escape hatch or a copy of Kernel. Do not pass Node child handles, a SQLite connection, ACP SDK objects or an entire Engine into an ordinary controller. Keep task/repository handles bound across awaits. Return actual version and evidence identities; unavailable observation, missing data, failed execution and confirmed absence remain distinct.

Async effects must define cancellation and ownership: stopping a request does not claim its native work ended, a failed operation does not silently become a successful empty response, and incomplete cleanup remains observable. Scripted implementations use the same interface and fail on unexpected work; they never fall back to the host's installed tools or accounts.

The first implemented slice is repository execution context and repair routing in `@petrina/orchestrator`. `RepairHost` supplies role lookup and a checkpoint naming the changed task; the controller consumes no Engine/Git/SQLite. Its decisions have independent data/effect tests, with separate durable-restart and complete-journey coverage retained in the engine. Later extractions use the audited callers and measured costs. Do not move all native modules first and leave the orchestrator coupled through a renamed Kernel.

The source-selection slice uses three contracts defined before moving behavior. `SourceQueries` supplies branch validation, branch existence and a validated pull-request identity. `SourceSelectionEffects` resolves choices, discovers repository identity and interprets absolute folder paths; it never clones or publishes. `SourceSelectionHost` supplies current products, task-aware role lookup, profile existence, the plan-check body and task-bound recording/checkpoints. The controller owns proposal races, duplicate choices and confirmation rules. The host retains atomic approval persistence, and native adapters retain CLI response parsing, credentials and path semantics. Resolution binds a repository context once; a late proposal completion may not replace a newer proposal's state. No new cancellation behavior is claimed for these existing finite source queries.

The acceptance-routing slice consumes normalized outcomes from a completed, version-bound run: failure count, required gaps and whether cleanup restored the work. Its host supplies task-aware role lookup, step completion, notes/checkpoints and opening a delivery decision. Routing owns repair allowances and the next stage; inspecting versions, parsing agent output, recording findings and executing checks remain separate owners. This contract was defined before extraction. Moving routing alone does not qualify the evidence supplied to it.

Delivery-return routing takes the already recorded coordinator note, prior checkpoint position and explicit time. It reuses `RepairHost` for task-aware role lookup and a bound checkpoint, and returns whether to wait for work or reopen the delivery decision. It owns acceptance-allowance renewal and unpublished-owner routing; the caller retains inbox removal, note/answer recording and opening the actual checkpoint. Clearing temporary delivery preparation is a separate shared state transformation, with no Git or publishing effect.

`AgentSession` and its start request are owned by the orchestrator, independently of any native implementation. They carry conversation identity, confirmed settings, public progress/permissions, turn reports and cancellation/cleanup results. A browser exposes only its capture folder. The host adds native commands, environment, sandbox/browser ownership and operational account/auth/log callbacks when constructing the real ACP adapter; scripted providers receive none of those native details. `close` and `cancel` request a stop; only a successful `stop` confirms cleanup. An uncertain live-input receipt never authorizes sending the same input again.

`ToolCheckCoordinator` owns shared probe admission, joined requests and lingering cleanup. Its host publishes observations, its probe owns installation/login inspection, and its clock owns cancellable deadlines. Register a request before notifying subscribers; hold every registered owner until cleanup is confirmed. Rejected cleanup is uncertainty, never permission to start another probe. The native adapter retains executable lookup, authentication, private probe folders and process ownership. Its exit notification awaits cleanup and rejects an incomplete stop; it does not treat the leader's exit as complete ownership release.

Screen arbitration owns permission changes, queue projection, grants/releases, quiet Inbox items and deadline decisions. It consumes lazy canonical state, live-participant ownership observations, recording/checkpoint/scheduling effects and a cancellable clock. The clock defers callbacks and cancellation prevents delivery. Native composition retains actual worktree selection and cleanup, Git roots and process settlement; browser/ACP permission enforcement stays at its boundary. Screen decision tests advance a private controlled clock. Native timer delivery/cancellation and real session/restart/copy interactions retain separate contracts.

`VerifierBallots` owns saved electorate/phase decisions, independent replacements, partial/corrected answers and final finding settlement. Core owns finding eligibility, candidate-profile preferences and the underlying panel rules. The controller consumes identity/result queries, normalized profile-selection observations and task-bound recording with an explicit clock. `verifier-host.ts` composes those ports with actual native readiness/quota selection and recording. Its composition contracts need private SQLite, without Git or agent prerequisites. Native code retains reviewer-group settlement before selection, eligibility probing, reservations, parsing, blind input preparation, actual agent execution and durable storage. Test ballot decisions and answer mutations through that controller; retain native controls for fresh sessions, shared code, restart, partial reports and exact evidence snapshots.

`ReviewReports` owns application of normalized reports and whole-group settlement. Core owns current-evidence validation, evidence accumulation and reopening history. Native code parses provider output, records proof requests and learnings, supplies pending-participant observations, and persists results. Controller tests supply explicit observations; they do not reconstruct the native admission or parsing algorithms. Actual response-format and restart controls remain at their boundaries.

Public tool descriptions and role prompts consume explicit tool metadata. The native composition supplies the current catalog; formatters must not import the native provider registry. Input-manifest construction is also separate from exact-message file persistence. Prompt fixtures use production-created private task data; golden wording stays immutable. A small real-turn contract proves that configured checks reach the actual input, while wording permutations run as rules. This keeps transformations testable without opening account, process or sandbox dependencies.

Persistence implements core's `WorkLogReader` and owns SQLite snapshots, history indexes, receipts and SQL diagnostics in `@petrina/storage`. The application constructs it and retains workflow normalization and task checkpoints. Storage consumes the bounded check-evidence data contract from core; it must not import workflow context to obtain that shape. Moving the adapter does not change transaction ownership, schema upgrades or failure propagation.

`@petrina/test-support` owns the shared Bun runner, private environment, filesystem aliases, atomic fixture publication, cooperative process lifetime and lightweight temporary-folder/wait helpers. It contains no Engine or product adapter and never falls back to native accounts. Each package's tests use these same implementations; application-specific scripted workflows and running-engine fixtures stay with the engine; native protocol peers and repository observation fixtures live beside their adapter contracts. Production packages cannot import test support. Every added package remains in complete discovery, with its own `src/` and `test/<layer>/<area>/` owners.

The required-run `SuiteCoordinator` consumes an execution plan, recorded per-workspace observations, explicit cancellation and starting/ending source identities. It owns prerequisites, unstarted outcomes and the final pass decision; the host retains native programs, report parsing, output, cleanup and evidence files. One execution can own several workspaces, with its elapsed time recorded once. Policy tests use those value contracts; actual CLI/report/source-binding and signal controls remain native contracts. Test support also owns the single/shared report parser: canonical package identities and actual case totals are validated before workspace observations reach the coordinator. Missing, skipped-only or ambiguous package outcomes cannot become passes. Core, desktop and orchestrator are prerequisites for one native pool; every native package still supplies its own manifest and case counts. A separate projection records shared duration and exit once and references that execution from each package, keeping peer failures attributable. Native package commands are verified before grouping, so custom preparation cannot disappear silently.

The native runner delegates to test support's bounded command owner. An explicit optional interrupt capability separates graceful signalling from forced tree cleanup; workflow code does not infer support from an OS name. Inherited descriptors have no owned output pipes or duplicate log buffer. A missing exit notification stays unknown even if a native end record already prevents signalling the released handle. Native completion, descriptor inheritance and signal forwarding retain real boundary controls; ordering and evidence policy remain data/effect tests.

`@petrina/platform` owns native process capabilities, bounded process-list inspection and local filesystem effects shared by adapters. It depends on no workflow, storage or test package. Portable process parsing and observation coordination have separate source owners inside it: coordination takes an explicit clock and reader, publishes a pending read before invoking that reader, and treats failed observation as unavailable. The native host supplies the actual clock and OS query. Test support consumes this boundary for its single bounded command runner and private Git fixtures; native shutdown and SQLite-lock tests keep the real boundary they assert.

Prefer existing pure functions and ports. When a controller cannot be exercised without starting unrelated machinery, inspect its dependencies and extract the smallest honest interface. Do not duplicate production rules in fixtures, use a broad fake Engine, cast an incomplete object to the full controller type, or replace the function being asserted. Scripted effects must also model relevant rejection, cancellation and completion behavior.

Presentation fixtures may replace the application client and native host through directly imported `vi.mock` or `vitest.mock`, with a literal path and synchronous factory returning explicit exports. Partial/original-module imports, indirect factories, spreads and runtime unmocking cannot prove isolation. The guard still inspects replacement bodies and helpers. Rules, controllers and production package checks receive no mock exemption; use explicit value/effect contracts there. Stylesheet reads and actual browser defaults belong to their boundary contracts.

Fixtures live in their owning test-support modules, separate from cases. Core rule and simulator tests use `packages/core/test/fixtures/state.ts`, and desktop presentation uses `apps/desktop/test/fixtures/state.ts`, for private catalogs and production-created display tasks; construct a full demo only when its scripted data or behavior is the subject. Share immutable recipes and helpers; give every case its own writable state and effect ownership. Keep clocks and release barriers explicit. A real timer belongs in a boundary test when timing or termination is the behavior being proved.

DOM setup uses plain stubs for unsupported behavior that a case does not inspect. A case that asserts calls owns a scoped spy and restores it during teardown, including on failure. Shared recording mocks retain their arguments and DOM receivers after unmount and must not accumulate across cases.

## Audit and migrate each case

1. Read the assertion and its failure control. Identify what regression it would catch; a name or a comment is insufficient.
2. Assign its layer and subsystem. Split files and cases that contain independent responsibilities. Keep an interaction together when separating it would remove the behavior under test.
3. Remove unrelated setup and replace irrelevant effects through the production contract. Preserve success, failure, recovery and nearby input variants. Replace an assertion only when its new form proves the same or a stronger outcome; record that decision in the audit.
4. Ensure a meaningful boundary or journey control still covers the integration that smaller tests no longer execute. Preserve real Git, SQLite, process and transport coverage where their behavior matters.
5. Run the migrated cases and their neighboring contract controls. Reconcile the original and new case/variant inventory, inspect assertions and measure resource cost. A faster result is not evidence of equivalent coverage.
6. Review the change and fix findings before marking that area audited. Repeat the complete normal-parallel suite after coherent batches; retain original failure evidence.

The migration inventory includes every test file and its declared cases, parameterized variants, setup/teardown, assertions and native resources. Generated inventory is discovery, not a completed semantic audit. A file with mixed layers stays pending until its cases have been separated and checked. Do not automatically label all existing Engine tests as journeys.

## Enforce the structure

The convention check must reject new flat tests, forbidden runtime dependencies in lower layers, and imports that bypass canonical fixtures. Follow transitive local imports and package aliases: hiding a process launcher behind a helper does not make a rule test isolated. Type-only imports do not execute a boundary.

Native contracts own their protocol/process peers or use public test-support; a child command pointing at Engine's workflow simulator still creates an upward dependency without an import. The guard checks statically proven executable/script positions at supported launch APIs, including native helper modules, while retaining Engine's complete composition controls. Data/report arguments, owned peers and private generated paths are distinct from proven foreign test entrypoints. Dynamic/generated launches remain subject to review; unresolved source is outside the static proof.

Use semantic stage/effect assertions and resource budgets where they detect unintended work: rule tests launch no programs; controller tests call only the effects relevant to their scenario; boundary tests bound their owned programs. Wall-time targets are diagnostic because contention varies. Required workers, assertions and real timing contracts stay intact; retries, skips and reduced parallelism cannot manufacture a pass.

The full required suite continues to discover every test in every layer. Layer commands are focused feedback, not delivery evidence. Moving or splitting a file must update runtime fixture paths, runner manifests, dependency selection and platform coverage. Record every split owner in the audit inventory; convention checks require each one to remain present. No layer may disappear from the complete check.

The accepted review-proof controller consumes task-aware role lookup and task-prefixed identity allocation. It owns request validation, per-execution/seat replay identity, delivery preparation and reuse of recorded matching Tester evidence; the caller still parses the agent result and checkpoints the accepted report. Native Git/version inspection and complete acceptance/restart journeys remain adapter/integration coverage.
