# Engine runtime and scheduling

Owns process lifecycle, command boundaries, work admission and recovery. Back to [design overview](../design.md).

## Architecture

```
apps/desktop            Tauri 2 shell + React UI
  src/                  UI (board, inbox, task sheet, session, agents, library, settings)
  src-tauri/            Rust host: starts the engine, notifications, single instance
packages/core           Domain model, scheduler, the flow rules, review numbers, demo simulator
packages/engine         The engine process (Bun): agents over ACP, git, SQLite, the local API
docs/                   This document and the UX notes
```

Inside the engine, `Engine` (`engine.ts`) is a thin front with the coordinator's commands. Each part of the work is a module of its own, sharing state and bookkeeping (lookups, the timeline, the inbox, saving) through the kernel (`kernel.ts`):

| Module | Owns |
|---|---|
| `driver.ts`, `checkpoints.ts` | Scheduling, the task loop, coordinator checkpoint decisions and recovery after a restart |
| `planning.ts`, `design.ts`, `work.ts`, `review.ts` | The stage kinds: plan, converge, do, review chain with verification |
| `turn.ts` | Agent turns and parallel members, sharing startup, callbacks, reopen fallback, context packets and screen persistence; admission remains specific to the seat owner |
| `tool-activity.ts`, `check-log-read.ts`, `evidence-read.ts` | Public tool descriptions, verified diagnostic-file reading and bounded evidence pages |
| `roles.ts`, `context.ts`, `prompts.ts` | Role contracts, what each role is shown, and the prompt around them |
| `product-checks.ts`, `checks.ts` | The product's checks and running them |
| `guide-keeper.ts`, `points.ts` | The review guide, and the files of points it shares with the learnings |
| `learnings.ts`, `accepted-points.ts` | Lessons offered at delivery, written to AGENTS.md, and accepted instructions retired from the pending queue once incorporated |
| `update.ts` | One commit per task, put on top of the latest main before the delivery check and before shipping |
| `shipping.ts` | Delivery preparation, publishing and recovery gates; publishing is never repeated blindly |
| `release-prep.ts`, `pr-monitor.ts`, `shipping-verifier.ts`, `companion-links.ts` | Release preparation; PR observation and cancelled settlement; shared local/GitHub delivery verification. Observations carry evidence; Shipping owns recording and publishing; companion linking has its own saved completion state |
| `screen-coordinator.ts` | Screen arbitration, waiting review members, screen timers and retained-copy cleanup |
| `usage-coordinator.ts` | Account-reader registry, reports, limit timers and profile/stand-in choice |
| `take-over.ts`, `terminal.ts` | Take over in the terminal |
| `git.ts`, `github.ts` | Local Git plumbing and worktree cleanup; repository-pinned GitHub CLI operations through the same command runner |
| `state-projection.ts` | Lean live snapshots, indexed history access, bounded archive cache and task revision/persistence bookkeeping |
| `store.ts`, `sql-log.ts` | SQLite state/history persistence and optional execution diagnostics; see [SQL logging](state-and-usage.md#optional-sql-execution-log) |
| `tracking.ts`, `worklog.ts`, account readers | The work log: an entry per agent turn and per notable moment, the permanent product list, each tool's limits, and the numbers each view asks for |

The kernel retains canonical runtime state, recording, stream flushing and save timers. The state projection owns snapshots, archive caching, revisions and persistence selection. Screen and usage coordinators receive explicit subsets of that host; the Engine delegates checkpoint state changes to the checkpoint module. Repository-wide operations use `scopesFor` to enumerate canonical owners in approved order, with excluded owners included only for cleanup. Operations with shared-task rules still own those rules rather than treating shared delivery as a single-product loop.

Built-in role contracts live in the engine's `roles.ts`, with their defaults in `@petrina/core`'s library. A role the coordinator adds uses the contract for its kind of result: notes or findings, with its saved wording and permission. The rules a task's run follows (board column, checkpoint wording, where a request for changes goes, how rounds end) live in `@petrina/core`'s `flow.ts`, shared by the engine and the demo simulator.

Every command the window can send the engine is listed once, in `@petrina/core`'s `commands.ts`: the Engine implements them, the local API has one argument schema for each, and the window's two clients (the real engine's and the demo's) are built from the list, all held to it by the compiler.

### Rust is a thin host

It starts the engine, passes the engine's address and key to the window, and stops the engine it started when the app quits. It also shows the window's notifications, sets the count on the Dock or taskbar icon, and keeps Petrina to one running copy, with Tauri's own notification and single-instance plugins. The window gets none of those plugins' commands: only the shell's own three (the engine's details, show a notification, set the count), each refused to any window but the main one. No web client, no other plugins.

### TypeScript holds everything domain-specific

TypeScript owns roles, plans, the scheduler, the engine, ACP handling, worktrees, SQLite, and the UI.

`@petrina/core` never imports Tauri. It talks to a host interface, so the domain rules run without a desktop shell and the engine runs under Bun with fake agents.

### State

State is saved in SQLite shortly after every change and at once for anything the coordinator says. Finished task summaries are indexed separately for History; the live window receives active work and compact historical metadata rather than every old conversation. Tasks pick up where they left off after a restart.

### Live check evidence

Live check evidence records each product check and repository hook as pending, running and completed, with its own start and finish times. Pending checks are saved before the shared check queue admits the task; queued and interrupted checks cannot be mistaken for passes. The same record powers the live node details and finished evidence.

### Each task keeps its journey

The journey has one entry per step, recorded the moment it starts (stage, round, reviewer position, role, profile, start and end, outcome, why the work moved on, and the questions and permission requests asked during it). Reviewers working together share a step per round, naming the profiles that actually start, including replacements; fresh voters and Petrina’s own checks and publishing have their own steps. A new round, send-back or retry is a new step; picking up after a restart or a pause continues the same one.

A replacement agent gets a new step, keeping the first agent's tool, elapsed time and lines on its own step. Timeline and session lines carry the step they belong to. The journey is never trimmed the way the timeline and the conversation are. The engine and the simulator record it through the same helpers and words in `@petrina/core` (`journey.ts`), which also work out the steps still ahead from the plan; the screen only draws it.

## Scheduling

- The queue is an ordered list. Priority is position.
- A pool limit caps running agents, with optional caps per tool. A tool past 80% of a usage window gets half its cap of new agents (see Balancing under Usage limits).
- Taking a slot records the next agent and its profile (and therefore its tool) at the same moment, before working-copy setup or agent I/O. The card shows the correct step immediately; a new task shows Plan with its planner.
- Before every new agent, including the same tool, a new design/review round or a new stage, check the pool and tool limits again, excluding this task's old slot. Keep the slot if there is room; otherwise release it and wait at the current step, keeping the working copy and progress. The status names the busy tool, a full pool, or a paused pool.
- A step where several agents work at once (a review round's reviewers, its voters) holds a slot for each of them: the first takes the task's own slot, and each other one starts only when a slot of its own is free under the pool limit and its tool's cap. One that cannot get a slot waits for the next round of scheduling, like any other agent.
- A task waiting at a gate releases its slot. An agent waiting on a mid-stage question keeps it and is shown as waiting on the coordinator.
- When a slot frees, work already in progress continues first (when the pool cannot take all of it, the tool with more of its limit left goes first), then the first queued task that is not held and whose next tool is under its cap.
- Lowering a limit never stops a running agent. Each finishes, and its successor waits if the other tasks still fill the new limit. Pausing the pool also holds tasks between agents.
- On macOS, active engine work holds an idle-sleep assertion and, on AC power, a system-sleep assertion so maintenance sleep does not suspend agents or checks. The display can still sleep. The assertion follows this engine process and is released when work and cleanup drain, including after a pause, or when the engine stops. Other platforms need no helper.

Product check runs use a separate queue, admitting one task’s run at a time by default. Commands within that run execute serially, static checks first; check preparation is bounded by the agent pool and does not block planners from using free slots. The check queue owns no model slots.

The scheduler is a pure function in `@petrina/core` (`pickStarts`), tested without any I/O.

### Usage limits

#### Grok request refusal

Grok's native HTTP 402 refusal keeps its structured detail (`data.message` and `data.http_status`) instead of becoming “Internal error”. The specific “Grok Build usage balance exhausted” refusal puts Grok on a five-minute cooldown and uses the existing stand-in or waiting flow. This is a retry time, not a reported account reset: the weekly allowance, its report time and its history stay unchanged. A later small request may still succeed. Authentication errors, other payment failures and busy-service errors are not classified as this refusal.

#### Turn-reported limits

Claude Code reports its usage on every turn (how much of each limit is used, and when it resets). The session window is `status` and the spend cap is `overageStatus`, the same three values (`allowed`, `allowed_warning`, `rejected`). A failed turn with no report carries a code instead: Claude's `errorKind` (`billing_error`, `rate_limit`, `account_on_hold`), Codex's `codexErrorInfo` (`usageLimitExceeded`, `rateLimitExceeded`), or Grok's `error: "rate_limit"`.

Only when Claude sends no code, because the block was a synthetic message, Petrina matches that message against Claude's own prefix list. Grok's one known sentence ("You've hit the rate limit for your plan.") is matched the same way, on the error text only. A busy service or a server error is not a usage limit. The pool keeps the latest report per tool and kind of limit (`pool.usage`) and who is out until when (`pool.limited`). The window shows both in plain words next to the pool.

Limits whose time has passed are dropped every time the scheduler runs, and a timer runs it again at the first one's end. A window it reports as rejected while the account goes on with extra usage (`isUsingOverage`) is spent, not out: the agents keep working, the usage line says "used up, on extra usage", fewer new agents start on the tool and the balancer prefers tools with room.

A rejected window without extra usage takes the tool out until it resets, before any turn fails on it; Codex's own count works the same way.

#### Account readers

Codex says nothing about its usage over ACP: its adapter reads the limits from Codex's app-server for its own status line and keeps them. Petrina reads them itself (`packages/engine/src/codex-usage.ts`): it runs `codex app-server` as an argument array with the agents' environment, does the adapter's `initialize` handshake, asks `account/rateLimits/read` once and stops the process. Each named limit and window becomes a report, with its duration and reset time: 100% used is `rejected`, from 90% a warning.

It reads when the engine starts (Codex installed), whenever a Codex agent starts, every ten minutes while any agent runs, and when Analytics or a finished turn asks for a fresh reading (at most once per minute or five minutes respectively). These requests share one reader and feed both the scheduler and the history; a failure (not installed, not logged in, no answer within 20 seconds) goes to the engine log once and never fails a task.

A report that says a tool is out marks it out until the reset even when no turn failed on it. Grok reports its account allowance through the read-only `_x.ai/billing` ACP extension. Petrina initializes the installed CLI, asks once and stops it, without a session or prompt. Its percentage and weekly or monthly reset feed the same scheduler and history. Reads at startup, before work, after turns and from Analytics share one reader, with the same one-minute page and five-minute background gaps.

A successful complete account reading replaces that tool's current quota groups and account restrictions, including groups removed or combined by a subscription change. Other tools and transient request-refusal cooldowns are retained. Empty or failed reads keep the last successful snapshot. Individual streaming usage updates replace only their own window; history retains the earlier readings.

Antigravity reads its local `/usage` command in a disposable probe at startup and during idle or Analytics refreshes. A running Antigravity session supplies its own before/after readings, avoiding a duplicate background probe at turn start. Read failures keep the last successful report and never fail a task.

#### Limit scope

Most limits cover the whole tool. Claude Code's weekly Opus and Sonnet limits cover those models only. Antigravity uses the quota groups actually reported: a separate Argon bucket applies to Argon, leaving the Gemini Models bucket for Flash; without a separate Argon bucket, the shared Gemini limit applies to both.

#### Choosing a stand-in

One function (`chooseProfile` in `@petrina/core`, used through `Kernel.choose`) decides who really works a step: the planned profile when it is free, else another model on the same tool, else a profile on another tool (the same effort first, in the order of the profile list, never one the coordinator removed). It is used wherever an agent is chosen, so the slots count the right tool. With nobody left, the task waits without a slot ("Waiting for usage: …") and starts by itself when a limit ends.

The plan is never rewritten: once the limit is over, later steps use the planned profile again. A usage stand-in whose tool is already at its cap yields to the next tool that has a seat (`chooseWithRoom`). The profile the plan named still waits for its own tool: the cap is there so one tool cannot take every seat.

#### Continuing after a usage limit

When a turn ends because its tool ran out, the step starts again right away on the stand-in, in a fresh conversation told what the first agent did (the same summary a restart gives), what it last said and that its unfinished work is in the working copy. With no stand-in, the step waits and the first agent's own conversation is reopened when a limit ends. A builder never tries to go back to its own conversation on a tool or model that is out.

#### Near-limit preferences

New agents also prefer an equal profile on a tool that is not close to its limit (a warning, or 90% used), when there is one. Running agents are never interrupted for this.

#### Standby profiles

A usage-limit stand-in for Claude Code's Opus is Sonnet, which the planner is never offered (`standby` in the profile).

### Balancing

Reviews from both Claude and Codex are worth having, so the pool keeps their usage level instead of draining one tool first. A tool's room is the unused share of its tightest window per hour until that window resets (`headroom` in `@petrina/core`): 20% left with an hour to go beats 50% left with a week to go.

Wherever a choice is open, the tool with more room wins: among stand-ins of the same independence, nearness and effort; among equal profiles when the planned tool is near its limit; and among work in progress waiting for a slot when the pool cannot take all of it. A tool that has said nothing is fine: it is neither held back nor pushed behind one that has.

Past 80% of a window (`SLOW_DOWN`), new agents covered by that quota share half the tool's cap (`SLOW_DOWN_SHARE`, rounded up, at least one; the pool's limit stands in for a tool with no cap). A model-specific window counts only matching profiles, including helpers and background agents; other models keep their own room. A shared account window and the configured tool cap still count every model on that tool. Balancing compares the windows that cover the actual candidate profile, and a full model quota can yield to another model on the same tool. These rules use reported scopes for every provider. Out, the affected profiles wait until reset (`pool.limited`), while available stand-ins can continue.

Today's rules stand: a reviewer runs on a tool other than the author's wherever both have room, a review with reviewers on both tools never collapses onto one while the other has room, reviewers and voters keep their planned tools when merely near a limit, and the security review stays away from the builder's tool. Running agents are never moved.

## The engine process

The engine is one Bun process per Petrina folder (`~/.petrina`, or `PETRINA_HOME`).

## One engine per folder

The engine holds an exclusive SQLite transaction on `engine.lock` for as long as it runs; the operating system releases it the moment the process ends, crash included. A second engine finds it through the lock, or through `engine.json` for an engine started before the lock existed, and refuses ("already running"), or in app mode steps aside and hands over the running engine's address. The engine decides this, not the shell.

## App mode

The desktop shell starts `cli.ts app` with its stdin and stdout as a private line. The engine picks a free port, writes `engine.json` for scripts, and says it is ready in one JSON line on stdout; that line, with the key, never goes to a log. Everything else the engine prints goes to `engine.log`, written only by the engine that holds the folder.

When stdin closes (the app quit, crashed or was force-quit) the engine stops its agents the way pausing does, saves, removes `engine.json` and exits; the shell forces it after 8 seconds. An engine the app did not start is left alone. Started from the Dock, the engine asks the login shell for the PATH the terminal has.

## The key

The window asks the shell for the address and key through a Tauri command that only the main window may call (`capabilities/default.json`), keeps them in memory, and presents the key as a WebSocket subprotocol when the connection opens. The engine refuses any request with the key in its address, a wrong or missing key, and pages that are not Petrina's own.

## Restarts are safe

Everything the coordinator says during a step (messages, answers, the note with a "No", the change request that started the step) is saved before any agent sees it, and kept on the task until the step hands back its result. An agent that starts the step again gets all of it, in order, in its opening instructions. The window keeps what it sent until the engine confirms it, and sends it again after reconnecting, with an id so a resend counts once.

## Test execution

Commands, fixture isolation, timing requirements and platform validation live in [testing](../testing.md). [AGENTS.md](../../AGENTS.md#checks-and-test-cost) defines the contribution rules; keep the required engine suite fully parallel.
