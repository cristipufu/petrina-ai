# Petrina design

Petrina runs local coding agents on product repositories. The coordinator sets priorities and makes the calls; the engine owns the workflow, checks and delivery. The user experience is described in [ux.md](ux.md).

## Goals

- Run many tasks through explicit roles, profiles, plans and approval checkpoints.
- Show the coordinator plain language, never code.
- Use installed tools and existing logins on the coordinator’s machine, without a Petrina service or telemetry.
- Let roles, models and tools grow through configuration where possible.
- Publish only after the engine’s gates allow it. Petrina never merges a pull request.

## Core concepts

| Concept | Responsibility |
|---|---|
| Product | A repository, local clone, delivery defaults and configured checks |
| Task | A request, approved scope, plan, shared progress and recorded evidence |
| Role | Purpose, instructions, permissions, visible context and result contract |
| Profile | Tool, model and effort selected for an agent |
| Stage | One action, an author/reviewer design loop, a review group or a coordinator checkpoint |
| Repository execution | Source, working copy, check evidence, conversations and delivery for one product |
| Journey | Recorded steps, exact inputs, outcomes and the reason work moved on |
| Inbox | Questions, permissions and checkpoints requiring the coordinator |

A task moves from Backlog to Queue after review. Once admitted, it plans, designs when needed, builds, tests, reviews and delivers. An agent works only while it owns a pool seat. A checkpoint frees that seat; a mid-turn question may retain it. Finished and cancelled work moves to History.

A failed automated check returns to the Builder within its allowance, then asks the coordinator. An unavailable acceptance probe remains unverified. Review findings, check failures and missing evidence have different meanings and must retain them throughout the flow.

## State ownership

`packages/core/src/task-model.ts` groups the task by responsibility and lifetime:

| State | Owner and lifetime |
|---|---|
| Request and scope | Coordinator choices and the approved products; retained for the task |
| Progress | Queue membership, plan position, rounds and run state |
| Design | Brief, objections, coordinator calls and each participant’s conversation |
| Review | Findings, independent judgments, convergence and send-backs |
| Acceptance | Tested versions, reproduced failures and unverified checks |
| Activity | Current agents, to-do item, clock and coordinator interaction |
| History | Journey, conversation, timeline, reports and provenance |
| RepositoryState | Execution belonging to exactly one repository |

`TaskState` composes the task-wide groups. It retains the existing saved field names rather than introducing another copy or schema. The engine’s mutable task uses this type; repository execution fields belong only to its canonical `repository` or `repositories` records.

A `RepositoryContext` binds a task to a specific execution record. An operation keeps that handle across waits and callbacks. `activeProductId` selects the visible current product; changing it moves no fields. Public `Task` views derive the selected repository’s display fields and are not writable execution state.

## Shared rules and scripted demos

The engine owns I/O: Git, ACP processes, checks, SQLite, clocks and authenticated commands. The simulator owns its deterministic clock, scripted agents and fake GitHub results. Both call the same core rules:

| Shared module | Decisions it owns |
|---|---|
| `task-transitions.ts` | Request defaults, Backlog/Queue changes, combination provenance, dependencies, future profile/reviewer edits, pause/resume/cancel and step cleanup |
| `flow.ts` | Stage columns, checkpoints, send-backs and round completion |
| `scheduler.ts` | Pool/tool admission, limits, balancing and profile choice |
| `roles.ts`, `products.ts` | Role and product validation |
| `repositories.ts` | Product membership, dependency landing and repository views |
| `journey.ts`, `summary.ts` | Step evidence, activity clocks and human-readable summaries |
| `follow-ups.ts`, `combine-backlog.ts` | Follow-up grouping and request-combination validation |

`sim.ts` orchestrates those rules. `sim-script.ts` contains the offline agents’ words, sample results and fake source data; `sim-types.ts` contains demo configuration. Simulated pull-request ages belong to the simulator’s private open work, never to a production task. The demos transfer that work explicitly when fast-forwarding fixtures.

Shared transitions receive state and an explicit time. Callers retain persistence, interruption, process cleanup and scheduling effects. Tests exercise domain rules directly and compare engine and simulator commands; the demo does not pretend to execute Git or reproduce process recovery.

## Packages

| Package | Responsibility |
|---|---|
| `apps/desktop` | React UI and a thin Tauri host for engine ownership, windows and notifications |
| `packages/core` | Domain types, pure rules, analytics definitions and the scripted demo |
| `packages/engine` | Bun process coordinating agents, repositories, checks, storage and local API |

`Engine` implements coordinator commands. The kernel shares lookups, recording and persistence; stage modules own their workflows. Detailed module ownership is in [Engine runtime](architecture/engine-runtime.md#architecture).

## Detailed contracts

Each contract has one home. Read the relevant subsystem when changing it; add regression examples to tests rather than extending this overview with another exception.

| Contract | Read for |
|---|---|
| [Workflow and review](architecture/workflow.md) | Stage kinds, Backlog, acceptance evidence, findings, verification and review limits |
| [Agents and conversations](architecture/agents.md) | Role editing, tool adapters, context reuse, messages, permissions, screen and terminal takeover |
| [State, history and usage](architecture/state-and-usage.md) | Repository ownership, snapshots, history, clocks, token accounting and analytics |
| [Repositories and delivery](architecture/repositories.md) | Sources, worktrees, updating branches, checks at delivery and interrupted publishing |
| [Engine runtime and scheduling](architecture/engine-runtime.md) | Modules, lifecycle, pool admission, usage limits and durable coordinator actions |
| [Safety boundaries](architecture/safety.md) | Tool checkers, credentials, engine gates and known limits |

Each contract above owns current behavior. Development and verification guidance lives in [testing.md](testing.md); historical briefs and investigations are isolated under [archive/](archive/README.md) and are not implementation instructions. Keep regression examples in tests. REVIEW.md at the task’s base remains the review guide.
