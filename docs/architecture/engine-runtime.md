# Engine runtime and scheduling

Owns process lifecycle, command boundaries, work admission and recovery. Back to [design overview](../design.md).

Required extra full validations in owned local Linux containers share this FIFO and limit; unconfirmed cleanup holds capacity across restarts, separately from agent admission.

## Architecture

```
apps/desktop            Tauri 2 shell + React UI
  src/                  UI (board, inbox, task sheet, session, agents, library, settings)
  src-tauri/            Rust host: starts the engine, notifications, single instance
packages/core           Domain model, scheduler, the flow rules, review numbers, demo simulator
packages/orchestrator   Portable execution handles, repair, source-choice, acceptance and delivery-return routing; no native adapters
packages/agent-runtime  ACP/provider sessions, native browser/captures and account readers
packages/repositories   Git/GitHub/worktrees and native repository/source queries
packages/platform       Shared process/file capabilities and environment transformations
packages/storage        SQLite persistence, history and diagnostics
packages/engine         Application composition, workflow admission and local API
docs/                   This document and the UX notes
```

Inside the engine, `Engine` (`engine.ts`) is a thin front with the coordinator's commands. Each part of the work is a module of its own, sharing state and bookkeeping (lookups, the timeline, the inbox, saving) through the kernel (`kernel.ts`):

Portable controllers are being extracted into `@petrina/orchestrator`, which depends only on core. It currently owns `RuntimeTask`, canonical repository execution handles, repair routing, source selection, post-run acceptance routing, delivery send-backs, session/probe contracts, saved verifier ballots, review-report settlement and screen arbitration. Narrow host/query contracts supply task-aware role lookup, recording/checkpoints, repository identity and branch/PR queries; controllers have no dependency on Kernel, Git, SQLite or agent processes. The engine supplies these effects and retains durable restart/integration tests. Normalized review reports reach the report controller only after native parsing, proof recording and learning capture; its group completion query retains actual participant/port-review admission. Core owns evidence transformations, so those rules never import the native engine. The repositories adapter’s `source-queries.ts` validates CLI replies; `sources.ts` retains native folder/cloning and source-refresh/fetch operations. Delivery-return routing consumes the recorded note, previous checkpoint position and explicit time through the existing repair role/checkpoint port. The checkpoint facade retains inbox and answer recording, and opens any returned decision; temporary delivery preparation has one shared pure reset. Remaining workflow modules still live in the engine during this extraction; agent and repository adapters have their own packages. [Test layers](../testing/layers.md#production-package-boundaries) defines the target package direction and interface policy; convention checks enforce the current pure package boundary, including type-only references.

| Module | Owns |
|---|---|
| `driver.ts`, `checkpoints.ts` | Scheduling, the task loop, coordinator checkpoint decisions and recovery after a restart |
| `planning.ts`, `design.ts`, `work.ts`, `review.ts` | The stage kinds: plan, converge, do, review chain with verification |
| `turn.ts` | Agent turns and parallel members, sharing startup, callbacks, reopen fallback, context packets and screen persistence; admission remains specific to the seat owner |
| Agent-runtime activity formatters; engine `check-log-read.ts`, `evidence-read.ts` | Pure public descriptions with provider metadata composed at the native boundary, verified diagnostic-file reading and bounded evidence pages |
| `roles.ts`, `context.ts`, `prompts.ts` | Role contracts, what each role is shown, and the prompt around them |
| `input-manifest.ts`, `exact-input.ts` | Pure input-section identities/occurrences, and separately the native persistence and reading of exact messages |
| Engine `product-checks.ts`; orchestrator check queue/admission; repositories check runner/discovery | The host records product checks and task waits; portable controllers own FIFO/cancellation/preparation decisions; repository adapters execute and observe actual commands |
| `guide-keeper.ts`, `points.ts` | The review guide, and the files of points it shares with the learnings |
| `learnings.ts`, `accepted-points.ts` | Lessons offered at delivery, written to AGENTS.md, and accepted instructions retired from the pending queue once incorporated |
| `update.ts` | One commit per task, put on top of the latest main before the delivery check and before shipping |
| `shipping.ts`, `delivery-turns.ts` | Delivery preparation, local destination turns, publishing and recovery gates; publishing is never repeated blindly |
| `release-prep.ts`, `pr-monitor.ts`, `shipping-verifier.ts`, `companion-links.ts` | Release preparation; PR observation and cancelled settlement; shared local/GitHub delivery verification. Observations carry evidence; Shipping owns recording and publishing; companion linking has its own saved completion state |
| `screen-coordinator.ts`, `clock.ts` | Native screen composition, retained-copy cleanup and cancellable host timers; arbitration and permission/queue decisions live in the orchestrator |
| `usage-coordinator.ts` | Account-reader registry, reports, limit timers and profile/stand-in choice |
| `take-over.ts`, `terminal.ts` | Take over in the terminal |
| Repositories `git.ts`, `github.ts` | Local Git plumbing and worktree cleanup; repository-pinned GitHub CLI operations through the same command runner |
| Platform `process-host.ts`, `process-tree.ts`, `process-group-read.ts` | Native process-group capability, owned spawn options and bounded Windows tree termination; process observations and shared bounded inspection. Platform parsers return semantic process states and opaque birth identities; callers retain ownership decisions and cleanup policy |
| Platform `file-operations.ts` | Portable picture-copy and owned-tree removal effects; callers validate paths and own retention/retry decisions. Hosts and fixtures can supply a private implementation without changing shared filesystem functions |
| `state-projection.ts` | Lean live snapshots, indexed history access, bounded archive cache and task revision/persistence bookkeeping |
| Storage `store.ts`, `sql-log.ts` | SQLite state/history persistence and optional execution diagnostics; see [SQL logging](state-and-usage.md#optional-sql-execution-log) |
| Engine `tracking.ts`, storage `worklog.ts`, agent-runtime account readers | The work log: an entry per agent turn and per notable moment, the permanent product list, each tool's limits, and the numbers each view asks for |

The kernel retains canonical runtime state, recording, stream flushing and save timers. The state projection owns snapshots, archive caching, revisions and persistence selection. The native screen adapter supplies lazy state, participant ownership and recording/scheduling effects to portable `ScreenArbitration`; the usage coordinator still receives a native host subset; the Engine delegates checkpoint state changes to the checkpoint module. Repository-wide operations use `scopesFor` to enumerate canonical owners in approved order, with excluded owners included only for cleanup. Operations with shared-task rules still own those rules rather than treating shared delivery as a single-product loop.

Acceptance preparation and proof-aware delivery decisions obtain committed trees and change fingerprints through the orchestrator's repository-observation port. The native reader binds a workspace, reads its head and tree together and computes the fingerprint from the captured base and head. These values describe committed code only; cleanliness has its own checks. Each boundary observes afresh, and unavailable observations never prove unchanged code. A failed query waits for its started peers to settle before propagating.

Built-in role contracts live in the engine's `roles.ts`, with their defaults in `@petrina/core`'s library. A role the coordinator adds uses the contract for its kind of result: notes or findings, with its saved wording and permission. The rules a task's run follows (board column, checkpoint wording, where a request for changes goes, how rounds end) live in `@petrina/core`'s `flow.ts`, shared by the engine and the demo simulator.

Every command the window can send the engine is listed once, in `@petrina/core`'s `commands.ts`: the Engine implements them, the local API has one argument schema for each, and the window's two clients (the real engine's and the demo's) are built from the list, all held to it by the compiler.

### Rust is a thin host

It starts the engine, passes the engine's address and key to the window, and stops the engine it started when the app quits. It also shows the window's notifications, sets the count on the Dock or taskbar icon, and keeps Petrina to one running copy, with Tauri's own notification and single-instance plugins. The window gets none of those plugins' commands: only the shell's own three (the engine's details, show a notification, set the count), each refused to any window but the main one. No web client, no other plugins.

### TypeScript holds everything domain-specific

TypeScript owns roles, plans, the scheduler, the engine, ACP handling, worktrees, SQLite, and the UI.

`@petrina/core` never imports Tauri. It talks to a host interface, so the domain rules run without a desktop shell and the engine runs under Bun with fake agents.

### State

State is saved in SQLite shortly after every change and at once for anything the coordinator says. Quitting saves before stopped steps finish their cleanup. Shutdown completion waits for agents, drivers, tracked background file handling and review-copy cleanup, including work handed off while stopping. Callers may release their folders only after that completion; a failed cleanup remains available to its owner rather than hiding other unfinished work. An acceptance step marks its run with its cleanup's own identity from its agent's start until that cleanup is over, so any save in between keeps the mark. A cleanup that finishes after the store closed leaves its record (what it undid, or nothing) under that identity in `acceptance-restorations` in the data folder, which joins that run at the next start. A marked run without a readable record from that same cleanup cannot verify the product, including after Petrina stopped unexpectedly or when only an earlier cleanup's record remains. Finished task summaries are indexed separately for History; the live window receives active work and compact historical metadata rather than every old conversation. Tasks pick up where they left off after a restart.

Task creation accepts optional prerequisite IDs through the shared command and outside creation operation. Shared dependency validation runs before insertion; request, prerequisites and request reference are saved together before scheduling can admit the task. Retrying a window request reference returns the saved task, including from History, without comparing resent fields. The window retains identical arguments for uncertain replies. Outside-operation receipts also check the request’s arguments.

Prerequisite edits use the same graph validation and are refused unless a task is in Backlog or queued and has never started. Backlog saves record the choices and timeline only. The scheduler opens a waiting step when queued work has blockers; queued edits also synchronize that step. Priority and holds remain separate. Existing delivery evidence decides blocking and honest outcomes, including unresolved deliveries and waits that end without landing.

Started tasks have a separate coordinator-set runtime wait, with a complete prerequisite list and reason. The wait, its change history and retry receipt save together; identical choices make no new history entry, and a repeated request reference returns its saved result. Changes and explicit clearing retain the time, prior and new lists, reason and request reference into History. Both prerequisite controls reject cycles across their combined graph. Cancelling a waiting task closes its wait and removes that runtime edge; pause and restart preserve it.

Clearing an already-ended wait is unchanged: its original ending and time remain recorded, and it owes no second source update. Finished and cancelled tasks' historical prerequisites do not participate in cycle checks; pre-start admission and release rules stay the same.

Runtime prerequisites arrive only through the existing whole-task landing fact, including every publishing product. An unfinished push stays pending. Cancellation, combination, closure without merging, marking done, finishing with no product changes or an unavailable prerequisite keeps the task held and names the coordinator decision needed. A provisional finding of no changes during delivery preparation remains in progress until the prerequisite finishes. Only revising or clearing the list resolves a non-landing outcome. Pre-start release rules above remain unchanged.

### Live check evidence

Live check evidence records each product check and repository hook as pending, running and completed, with its own start and finish times. Pending checks are saved before the shared check queue admits the task; queued and interrupted checks cannot be mistaken for passes. The same record powers the live node details and finished evidence.

### Each task keeps its journey

The journey has one entry per step, recorded the moment it starts (stage, round, reviewer position, role, profile, start and end, outcome, why the work moved on, and the questions and permission requests asked during it). Reviewers working together share a step per round, naming the profiles that actually start, including replacements, and the positions the step expects a result from (`seats`: the round's reviewer places, or a vote's places, each named by its original planned profile through replacements), recorded as each participant is admitted, so a planned reviewer still waiting for usage or a slot is a seat without a result rather than a missing one; a vote's electorate revision under the usage-handoff rule updates the open vote step only. Fresh voters and Petrina’s own checks and publishing have their own steps; a vote's targeted third answers are a further step of their own, after the initial pair's step ends with what it decided. A new round, send-back or retry is a new step; picking up after a restart or a pause continues the same one.

A replacement agent gets a new step, keeping the first agent's tool, elapsed time and lines on its own step. Timeline and session lines carry the step they belong to. The journey is never trimmed the way the timeline and the conversation are. The engine and the simulator record it through the same helpers and words in `@petrina/core` (`journey.ts`), which also work out the steps still ahead from the plan; the screen only draws it.

## Scheduling

- The queue is an ordered list. Priority is position.
- A pool limit caps running agents, with optional caps per tool. A tool measured past 80% of a usage window gets half its cap of new agents (see Balancing under Usage limits).
- Taking a slot records the next agent and its profile (and therefore its tool) at the same moment, before working-copy setup or agent I/O. The card shows the correct step immediately; a new task shows Plan with its planner.
- Before every new agent, including the same tool, a new design/review round or a new stage, check the pool and tool limits again, excluding this task's old slot. Keep the slot if there is room; otherwise release it and wait at the current step, keeping the working copy and progress. The status names the busy tool, a full pool, or a paused pool.
- A step where several agents work at once (a review round's reviewers, its voters) holds a slot for each of them: the first takes the task's own slot, and each other one starts only when a slot of its own is free under the pool limit and its tool's cap. One that cannot get a slot waits for the next round of scheduling, like any other agent.
- A task waiting at a gate releases its slot. An agent waiting on a mid-stage question keeps it and is shown as waiting on the coordinator.
- A saved participant's [readiness recheck](agents.md#checking-the-tools) takes no place of its own. A step that already holds its main place keeps it while that decision is open, charged once to the saved tool where the pool and tool limits allow; a review group keeps its one main place when its last working reviewer finishes, and releases finished helper places as usual. The place goes back to normal admission when the decision settles or its limit passes, and is released on a prerequisite hold, pause, cancellation or shutdown. A prerequisite hold ends only that task's readiness admission wait: the shared tool check continues, and its eventual answer still needs ordinary admission.
- When a slot frees, work already in progress continues first (when the pool cannot take all of it, the tool with more of its limit left goes first), then the first queued task that is not held and whose next tool is under its cap.
- Lowering a limit never stops a running agent. Each finishes, and its successor waits if the other tasks still fill the new limit. Pausing the pool also holds tasks between agents.
- On macOS, active engine work holds an idle-sleep assertion and, on AC power, a system-sleep assertion so maintenance sleep does not suspend agents or checks. The display can still sleep. The assertion follows this engine process and is released when work and cleanup drain, including after a pause, or when the engine stops. Other platforms need no helper.

Product check runs use a separate queue, admitting one task’s run at a time by default. Commands within that run execute serially, static checks first; check preparation is bounded by the agent pool and does not block planners from using free slots. The check queue owns no model slots. A pool pause keeps product checks and extra validations in arrival order, including when capacity frees during the pause or the pause arrives during handoff; tasks awaiting product checks show “Waiting for the pool to resume”, and quiet queued checks neither delay the pause nor keep the Mac awake. Active work and cleanup still prevent sleep. A stop or restart drains waiting ordinary check attempts; never-started extra requests remain saved for the next start. A task prerequisite hold defers its never-started extra requests without holding a check place or changing their recorded version. The reply and timeline name that wait instead of a numbered place; when scheduling observes the prerequisites landed, the request joins the line in that same pass. An already-running container finishes normally.

Admission of a product check run that waited repeats its guarded step's normal approved-source preparation once, then captures fresh check inputs before any command starts. Unwaited runs keep their original preparation. Conflicts and decisions release capacity immediately; changed check-discovery inputs also release it before asking an agent, retaining the run's order when it rejoins. Re-entry after discovery captures fresh inputs without another source update unless it waited again or regained a delivery turn. A coordinator question during preparation returns check capacity and preparation room before waiting for its reply; continuing rejoins normal admission. Closed check records retain their original evidence across these side steps. Saved extra validations keep their requested version and never use this source refresh. Scheduling pumps their line again after releasing task prerequisites, so that release needs no maintenance tick and starts no duplicate or recursive scheduling pass.

Final local delivery has a separate in-memory turn per product folder and destination branch. A shared task takes all its local destinations together, in request order among overlapping requests. A waiter owns no check capacity, preparation reservation or agent slot and does not hold up shutdown or sleep. Its check order is reserved when it asks. The turn covers final preparation, checks, landing and push, and is released whenever the delivery step ends or yields, including pause, prerequisite hold, failure and shutdown. Pull requests, releases and independent destinations keep their existing admission. Restart acquires new turns through ordinary scheduling; saved publication evidence still goes through its existing recovery lookup before another write.

A runtime prerequisite hold closes new admission for its task at the same boundaries as a paused pool: before agents, parallel participants, third answers, replacements, tool readiness rechecks, check preparation, check batches and publishing. An already-running readiness recheck may finish, but it holds no model place once the working agents settle; an unused recheck stays unspent while held. Asynchronous readiness, agent input preparation, parallel review preparation and check preparation recheck both the hold and any owed source update before admitting new work. A parallel participant is admitted before its copy setup; an unopened group returns through source updates and prepares its snapshot again. Agents and their native in-session helpers, check batches and deliveries already admitted finish under their existing rules. Partial review and vote results remain saved and never become a completed review. After admitted work settles, the task releases its slots and waits without reserving room in the pool; other tasks on any of its products remain eligible. Open Inbox checkpoints stay answerable with the same revision. Try again and terminal hand-back retain the hold.

If admitted publishing finishes the whole task, its prerequisite wait ends with that reason, retaining the coordinator's decisions without claiming the prerequisites landed. Awaiting merge has no remaining task work to hold and contributes no runtime dependency edge. One published product does not end a shared task's hold while another product still needs delivery. Restart also settles an older saved wait on a task already awaiting merge or finished, without replacing an earlier release reason.

When prerequisites land or the coordinator clears the wait, ordinary admission resumes. Before the next unstarted step, every publishing product's work is brought onto its current approved starting source, freshly fetched for GitHub delivery. This also applies when the wait ends before the first working copy exists: creating that copy cannot admit an agent before the source check. Fetch failure stops as stuck; conflicts use the existing Builder port. An already-started partial group or handed-back step finishes its version first, and an existing port remains pending. Editable ownership is saved at admission, before native startup and independently of prerequisite waits. A failed editable attempt first recovers its own uncommitted work through ordinary Retry, preserving that ownership across pause and restart; a clean copy catches up first. Completing the recovered step releases the owed source update before the next new step. Interrupted release notes do not defer this update: they retain their attempt history, but follow their existing fresh-preparation rule. A saved publication awaiting recovery is an active hold while no work is running, rather than work still finishing. A prepared review with no admitted participants is prepared again without spending a round. Version-bound checks, acceptance evidence and delivery approval follow the existing freshness rules. Waiting itself consumes no repair or review round and changes no conversation identity; saved-conversation recovery records truthfully whether the next agent continued or started fresh.

Each product's unfinished source check is saved separately. Existing ports stay intact while every other product is examined, and new conflicts join the existing repair order without losing its return step. Failed fetches retain the remaining work across restart and Retry. A port's owed check completes after its Builder finishes; only then can the journey report all remaining source checks complete. Unstarted delivery preparation is restored before any source move, preserving real attempt counts, so normal preparation rebinds checks and approval to the current candidate. Admitted publishing retains its saved recovery evidence.

The publication boundary checks both an active hold and an owed source update, including after final checks or release notes and when a queued write gets its turn. If a wait ended during preparation, publishing returns to the ordinary source update and evidence gates before its first write. Already-admitted publishing keeps its checked version; remaining unpublished products still owe their own source updates.

Under load the runtime can lose a child's exit report, leaving a finished child defunct. A process-list read settles as failed at its own deadline whatever the runtime reports. A Git command or product check whose output has closed without a reported exit is not assumed to have ended: closed output is no evidence of exit, since a valid command can close or redirect its output and keep working inside its allowance. Bounded process-state reads decide instead: a child still running keeps its configured time limit; one observed gone or defunct, with no exit reported after a short grace, fails plainly as an unreported exit, keeping the output it produced, and only what it started is stopped; one whose state cannot be read keeps waiting for its exit or its time limit. These watches share their process-list reads: one read runs at a time, watchers asking together join it, and a watcher whose child may be newer than the read under way waits for the next one, so many commands closing their output together add one helper process rather than one each. A Git command run without a time limit therefore still waits for a lost exit when the process list is unreadable; the wider Git cleanup and output deadlines are tracked separately.

The scheduler is a pure function in `@petrina/core` (`pickStarts`), tested without any I/O.

### Recurring maintenance

Core calendar rules calculate daily, weekday and numeric five-field cron occurrences in an explicitly saved IANA zone, shared by preview and engine admission. Calendar iteration accepts infrequent schedules across the Gregorian cycle and rejects impossible dates. Daylight-saving gaps are skipped and repeated local minutes use only their first instant.

The engine polls while running and before ordinary queue scheduling. A routine's durable handled-through watermark and new task are saved in the same SQLite transaction before driver admission. Task-history cleanup never clears that watermark. Duplicate callbacks and restarts do not duplicate occurrences; backward clock changes do not replay handled times. Forward jumps coalesce overdue occurrences to the latest missed time. An unfinished run consumes a trigger as skipped and names its blocking task; completion never replays skips. Paused or draining engines can queue due work but start no agent or check. There is no second agent scheduler.

Creation, changed schedules or zones, and re-enabling start in the future. Repairing an unavailable product, role or profile also starts with the first future occurrence; time spent needing attention is not catch-up work for the replacement choice. Wording edits to a valid routine retain genuine missed occurrences. Disable/remove takes effect at the next synchronous poll and preserves saved tasks. Removed products, roles or profiles leave actionable attention states without task creation; missing repositories fail through existing recovery without changing ownership. Admission freezes routine identity/name, scheduled and queue times, catch-up explanation, product, focus, role wording/result, profile and delivery choices.

### Usage limits

#### Grok request refusal

Grok's native HTTP 402 refusal keeps its structured detail (`data.message` and `data.http_status`) instead of becoming “Internal error”. The specific “Grok Build usage balance exhausted” refusal puts Grok on a five-minute cooldown and uses the existing stand-in or waiting flow. This is a retry time, not a reported account reset: the weekly allowance, its report time and its history stay unchanged. A later small request may still succeed. Authentication errors, other payment failures and busy-service errors are not classified as this refusal.

#### Turn-reported limits

Claude Code reports its usage on every turn (how much of each limit is used, and when it resets). Its included window uses `status`; the separate paid allowance uses `overageStatus`, with the same three values (`allowed`, `allowed_warning`, `rejected`). Paid allowance notices never become subscription windows: unavailable paid usage does not reduce included room or admission. They can end paid continuation of a known exhausted included window, but cannot establish included exhaustion or paid entitlement. `isUsingOverage` or `overageInUse` confirms live continuation; an account read confirms usable continuation only with extra usage enabled and a valid balance below 100%. A failed turn can carry a refusal code: Claude's `errorKind` (`billing_error`, `rate_limit`, `account_on_hold`), Codex's `codexErrorInfo` (`usageLimitExceeded`, `rateLimitExceeded`), or Grok's `error: "rate_limit"`.

Only when Claude sends no code, because the block was a synthetic message, Petrina matches that message against Claude's own prefix list. Grok's one known sentence ("You've hit the rate limit for your plan.") is matched the same way, on the error text only. A busy service or a server error is not a usage limit. The pool keeps the latest report per tool and kind of limit (`pool.usage`) and who is out until when (`pool.limited`). The window shows both in plain words next to the pool.

A current Claude window supplies the model scope and reset when a generic quota or rate refusal ends its turn. This remains a request refusal until its reset, even if later account or live readings show room or omit that window. Billing refusals and account holds remain independent of subscription windows. Handoffs retain the stopped agent's words, including words that had not already been streamed.

Limits whose time has passed are dropped every time the scheduler runs, and a timer runs it again at the first one's end. When independent restrictions cover the same tool and model, waiting words, the usage line and Analytics show their latest end, while each restriction keeps its own lifetime. A window it reports as rejected while the account goes on with extra usage (`isUsingOverage`) is spent, not out: the agents keep working, the usage line says "used up, on extra usage", fewer new agents start on the tool and the balancer prefers tools with room.

A rejected window without extra usage takes the tool out until it resets, before any turn fails on it; Codex's own count works the same way.

#### Account readers

Claude Code has a shared account reader in `claude-usage.ts`, alongside its per-turn reports. It starts the installed CLI in an empty checks folder, sends native stream-JSON `initialize` and `get_usage` control requests, and stops the process. No user prompt, model turn, MCP server, or saved conversation is created. The returned 5-hour, weekly and model-scoped percentages and UTC resets feed Analytics and balancing through the ordinary reader cadence. Missing readings stay missing; a disabled extra-usage balance never blocks included subscription work. A complete successful account read removes obsolete windows and account restrictions; failures retain the last successful report.

Codex says nothing about its usage over ACP: its adapter reads the limits from Codex's app-server for its own status line and keeps them. Petrina reads them itself (`packages/engine/src/codex-usage.ts`): it runs `codex app-server` as an argument array with the agents' environment, does the adapter's `initialize` handshake, asks `account/rateLimits/read` once and stops the process. Each named limit and window becomes a report, with its duration and reset time: 100% used is `rejected`, from 90% a warning.

It reads when the engine starts (Codex installed), whenever a Codex agent starts, every ten minutes while any agent runs, and when Analytics or a finished turn asks for a fresh reading (at most once per minute or five minutes respectively). These requests share one reader and feed both the scheduler and the history; a failure (not installed, not logged in, no answer within 20 seconds) goes to the engine log once and never fails a task.

A report that says a tool is out marks it out until the reset even when no turn failed on it. Grok reports its account allowance through the read-only `_x.ai/billing` ACP extension. Petrina initializes the installed CLI, asks once and stops it, without a session or prompt. Its percentage and weekly or monthly reset feed the same scheduler and history. Reads at startup, before work, after turns and from Analytics share one reader, with the same one-minute page and five-minute background gaps.

A successful complete account reading replaces that tool's current quota groups and account restrictions, including groups removed or combined by a subscription change. Other tools and actual request refusals are retained separately from report-derived restrictions. Empty or failed reads keep the last successful snapshot. For Claude, both shared windows and a valid explicit model list establish a complete replacement, whether the list is empty or populated. Missing or invalid model lists remain partial. Account model names and live model kinds share one identity and scope, including the Fable weekly window, so either source can correct the other. Partial reads update only reported windows. Individual streaming usage updates replace only their own window, retaining known percentages and resets when omitted from an otherwise unchanged window. Relevant Claude readings retire obsolete paid-allowance reports and their inferred blocks immediately and wake waiting work; expired notices cannot extend them. History retains the earlier readings.

Antigravity reads its local `/usage` command in a disposable probe at startup and during idle or Analytics refreshes. A running Antigravity session supplies its own before/after readings, avoiding a duplicate background probe at turn start. Read failures keep the last successful report and never fail a task.

#### Limit scope

Most limits cover the whole tool. Claude Code's weekly Opus, Sonnet and Fable limits cover those models only. Antigravity uses the quota groups actually reported: a separate Argon bucket applies to Argon, leaving the Gemini Models bucket for Flash; without a separate Argon bucket, the shared Gemini limit applies to both.

#### Choosing a stand-in

One function (`chooseProfile` in `@petrina/core`, used through `Kernel.choose`) decides who really works a step: the planned profile when it is free, else another model on the same tool, else a profile on another tool (the same effort first, in the order of the profile list, never one the coordinator removed). It is used wherever an agent is chosen, so the slots count the right tool. With nobody left, the task waits without a slot ("Waiting for usage: …") and starts by itself when a limit ends.

The plan is never rewritten: once the limit is over, later steps use the planned profile again, except returning Builders and eligible saved design or findings-review participants. A design or review seat keeps its own stand-in conversation across rounds only when its scope and planned profile still match, the coordinator did not choose that seat's profile, effort matches, it is not standby, and the usual selection would keep it with current usage, model capacity, readiness, tool slots and independence. Admission and turns use the same preference; voters remain fresh. A failed context, base-history or native-reopen check before instructions discards the preference and selects normally with complete context and the saved failure reason. See [continued conversations](agents.md#continued-design-conversations).

A usage stand-in whose tool is already at its cap yields to the next tool that has a seat (`chooseWithRoom`). The profile the plan named still waits for its own tool: the cap is there so one tool cannot take every seat.

#### Continuing after a usage limit

When a turn ends because its tool ran out, the step starts again right away on the stand-in, in a fresh conversation told what the first agent did (the same summary a restart gives), what it last said and that its unfinished work is in the working copy. With no stand-in, the step waits and the first agent's own conversation is reopened when a limit ends. A builder never tries to go back to its own conversation on a tool or model that is out.

#### When the selected model is at capacity

Each tool's adapter reads its own connector, in the reporting mode Petrina already uses with it (`provider-interruptions.ts`). Only an explicit terminal stop counts as a full model:

- **Codex** ends the turn with "Selected model is at capacity. Please try a different model.", or reports the stop as its own overloaded error with no finished message after it.
- **Claude Code** rejects the turn with its connector's overloaded error kind. Its rate-limit, billing, sign-in and server errors keep their own handling.
- **Grok** ends the turn with "Model is temporarily overloaded. Try again in a moment." A busy or unavailable service it files under rate limits, and a 429 that mentions capacity, are not this.
- **Antigravity** reports no trustworthy signal. Its service-unavailable failure stays a clear error.

A native retry warning earlier in the turn never explains why the turn ended. A generic service or server error, a rate-limit label or a suggestion to retry is not a full model either. That is the model being full, not an account usage, rate or session limit. Usage meters stay as they were. When the account is out as well, that limit decides. The step stays where it is: messages and file changes already saved are kept, an unfinished result is not accepted, and builder, design and review rounds do not advance.

The same conversation tries again after about five seconds, then about ten, then about thirty. Each try is a short continue on that conversation, so it does not hear the opening instructions again. When the provider names a retry delay, the wait is at least that long. After those three tries, another model on the same tool continues the step when one is free and can take a seat. A different effort of the same model does not. Otherwise another available tool does. A later review still keeps its distance from the builder's tool, and an earlier full model does not pull that review back. Each model that stops gets those three tries, including one that took over. A model that took over goes back to its own conversation only while it has a seat and account usage, and while a review would still choose it. Otherwise the usual choice applies, so a free tool takes the step instead of waiting for a seat on a full or used-up tool. Reviewers working at the same time each reopen their own conversation. The new conversation hears what was already done and which files changed. A conversation that cannot reopen starts fresh as for any failed reopen, and says so.

A reviewer or verifier working beside others waits aside during its model wait, with its working copy, conversation, retry count and the review's saved inputs, while the others keep working. When its own wait ends, the scheduler offers it a seat like other work in progress, ahead of queued tasks and within the pool and tool caps; with no free seat it waits for one without retrying. The same holds after its short retries, while the model that takes over waits for a free seat on its own tool. A saved conversation whose tool needs a readiness recheck starts that check meanwhile, without a seat and without waiting for its peers. It then rejoins its group in the same round with the short continue, which also carries any coordinator message it has not heard, and the pull request is not read again. A verifier returns to its own place on its tool. Nobody comes back while a peer waits for or uses the screen, while the pool is paused or Petrina is stopping, or after the task is paused or cancelled. Once every peer has finished, the task itself shows the wait and continues afterwards, and a restart reopens the same conversation on the remaining schedule. A member that holds the screen keeps the path below.

A runtime prerequisite hold also stops these returning members and their readiness rechecks, even when their model wait has ended. Admitted peers still finish; their reports and the returning members' saved conversations stay with the same round for release.

When a switch is not allowed, or nobody else can take the step, the task waits about five minutes and says that the model is at capacity. It then reopens the same conversation with a short continue. The working copy is left as it was during the wait. If the model is still full, the task waits and tries again on that same interval. A scheduled run and an agent that already has the screen stay on that profile and show the same wait. A voter uses another model on its tool when one is free, and waits when every model on it is full. A reply that only mentions the sentence and then hands back a finished result is accepted.

#### When a tool reconnects by itself

Codex and Grok report their own retries while a turn goes on. Codex sends them as an info update marked "will retry"; a dropped stream or failed connection is a lost connection. Grok sends its retry state on its own notification route; its reason tells a lost connection (an address lookup, connect or reset failure) from a reply it could not read. Account, rate-limit and sign-in retries are not shown.

The participant's line then says "Reconnecting to Codex. Trying automatically.", or "Grok hit a temporary problem. Retrying automatically." when the tool reported no lost connection. Petrina sends nothing, starts no retry of its own and records no full model. The words stay through silence. Fresh model output or a new tool call ends them; repeated notices, account reports and updates to earlier tool calls do not. When the turn ends, or the coordinator stops it, the words go and the turn's result or error is handled as usual. A restart never brings them back.

Notices are read in the order the tool sent them, on the run's own conversation, only while its turn is waiting for an answer. Notices replayed while a conversation reopens, and any after the turn's answer, are ignored. Codex labels each retry with its own turn, which Petrina does not track: a late retry from an earlier Codex turn in the same conversation would show until the next fresh output. Each change sends one light task update, and a retry's start adds one timeline line; repeats send nothing.

Silence alone never means a lost connection. Claude Code's connector sends its retry notices only in the optional failure-reporting mode Petrina does not use, so it shows none; Antigravity sends none. A dead connection can stay unnoticed until the tool's own idle limit reports it. Petrina leaves Codex's stream idle limit at the tool's default: a shorter one has not been shown to spare healthy long requests.

#### Near-limit preferences

New agents also prefer an equal profile on a tool that is not close to its limit (90% of a covering window measured as used), when there is one. Running agents are never interrupted for this.

#### Provider warnings

A provider's own warning status (`allowed_warning`) is kept with its percentage, reset and history. Below Petrina's 90% mark, or without a percentage, the usage line and Analytics show it as the provider's ("provider warning", adding "percentage not reported" when it has none); from 90% they say what any reading that high says. Its threshold need not be Petrina's, so the 80% and 90% marks apply only to the measured percentage, before display rounding, and the same measurement gives the same decisions whether the provider reported permission or a warning. A warning without a usable current percentage means usage is unknown: it triggers neither mark, adds no figure to room or balancing, and on its own never says the allowance is nearly used or that fewer agents start. Other current measured windows still count, and omitted fields are retained only from the same unchanged window (see Account readers). A rejection stays effective with a low or missing percentage.

#### Standby profiles

A usage-limit stand-in for Claude Code's Opus is Sonnet, which the planner is never offered (`standby` in the profile).

### Balancing

Reviews from both Claude and Codex are worth having, so the pool keeps their usage level instead of draining one tool first. A tool's room is the unused share of its tightest measured window per hour until that window resets (`headroom` in `@petrina/core`): 20% left with an hour to go beats 50% left with a week to go. A used-up window has no room.

Wherever a choice is open, the tool with more room wins: among stand-ins of the same independence, nearness and effort; among equal profiles when the planned tool is near its limit; and among work in progress waiting for a slot when the pool cannot take all of it. A tool that has said nothing is fine: it is neither held back nor pushed behind one that has.

From 80% of a window measured as used, or a window reported as used up (`SLOW_DOWN`), new agents covered by that quota share half the tool's cap (`SLOW_DOWN_SHARE`, rounded up, at least one; the pool's limit stands in for a tool with no cap). A model-specific window counts only matching profiles, including helpers and background agents; other models keep their own room. A shared account window and the configured tool cap still count every model on that tool. Balancing compares the windows that cover the actual candidate profile, and a full model quota can yield to another model on the same tool. These rules use reported scopes for every provider. Out, the affected profiles wait until reset (`pool.limited`), while available stand-ins can continue.

Today's rules stand: a reviewer runs on a tool other than the author's wherever both have room, a review with reviewers on both tools never collapses onto one while the other has room, reviewers and voters keep their planned tools when merely near a limit, and the security review stays away from the builder's tool. Running agents are never moved.

## The engine process

The engine is one Bun process per Petrina folder (`~/.petrina`, or `PETRINA_HOME`).

## One engine per folder

The engine holds an exclusive SQLite transaction on `engine.lock` for as long as it runs; the operating system releases it the moment the process ends, crash included. A second engine finds it through the lock, or through `engine.json` for an engine started before the lock existed, and refuses ("already running"), or in app mode steps aside and hands over the running engine's address. The engine decides this, not the shell.

## App mode

The desktop shell starts `cli.ts app` with its stdin and stdout as a private line. The engine picks a free port, writes `engine.json` for scripts, and says it is ready in one JSON line on stdout; that line, with the key, never goes to a log. Everything else the engine prints goes to `engine.log`, written only by the engine that holds the folder.

When stdin closes (the app quit, crashed or was force-quit) the engine stops its agents the way pausing does, saves, removes `engine.json` and exits; the shell requests force after an eight-second ordinary grace. An engine the app did not start is left alone. Started from the Dock, the engine asks the login shell for the PATH the terminal has.

The standard-library `engine_process` boundary owns the shell's child, input and output readers. Startup has a thirty-second first-line allowance. Failed startup closes owned input and settles that child; force confirmation and pending-reader collection are bounded. An unconfirmed exit or still-held pipe retains the owner and prevents a competing launch. Accepted live lifecycle handoffs keep their existing exemption from force; a confirmed ended owner cannot keep returning an obsolete address. Tauri supplies command discovery and delegates connection work off its UI thread.

## The key

The window asks the shell for the address and key through a Tauri command that only the main window may call (`capabilities/default.json`), keeps them in memory, and presents the key as a WebSocket subprotocol when the connection opens. The engine refuses any request with the key in its address, a wrong or missing key, and pages that are not Petrina's own.

## Restarts are safe

Everything the coordinator says during a step (messages, answers, the note with a "No", the change request that started the step) is saved before any agent sees it, and kept on the task until the step hands back its result. An agent that starts the step again gets all of it, in order, in its opening instructions. The window keeps what it sent until the engine confirms it, and sends it again after reconnecting, with an id so a resend counts once.

## Test execution

Commands, fixture isolation, timing requirements and platform validation live in [testing](../testing.md). [AGENTS.md](../../AGENTS.md#checks-and-test-cost) defines the contribution rules; keep the required engine suite fully parallel.
