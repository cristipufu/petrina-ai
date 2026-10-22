# State, history and usage

Owns persistence, bounded window transport, step clocks and measurement definitions. Back to [design overview](../design.md).

## Tasks across products

[The repository contract](repositories.md#tasks-across-products) owns scope approval, product ownership, combined review, per-repository recovery and landing. One task remains one record; its repository records retain separate work and deliveries.

Execution state belongs to a `RepositoryState` record: `repository` for an ordinary task, or one record per product in the approved shared scope. Branches, working folders, check evidence, repair allowances, conversations and deliveries live only there. The runtime task owns the request, plan, review process and stage progress; its type excludes repository execution fields.

Repository operations receive a `RepositoryContext` containing the task and its specific execution record, and retain that record across waits and callbacks. `activeProductId` records which product the current step is working on; changing it moves no fields. Window, CLI and agent context views are derived from the selected record without writing anything back. Saved flat tasks are converted at the load boundary; archived bodies are converted when opened.

## Finished task history

Completed and cancelled tasks appear in History rather than Board. The window receives active task summaries and compact historical totals, review aggregates and recent step timing records. `historyPage` reads at most one page of lightweight summaries, ordered by finish time and task id, with a stable cursor and optional product, routine ID, final-outcome and title-word filters. SQLite indexes the history, recorded final outcomes and title search. A schema upgrade classifies older lightweight summaries in bounded pages, without loading their task bodies. A one-time upgrade likewise records, on older summaries, that you marked one product's work done, so a pull request found later never reads as delivered. `taskDetails` reads the full record only when someone opens it. Only the History screen opts into compact whole-task usage summaries with its page. One grouped work-log read is limited to the returned task IDs; it returns finished-turn tallies and earlier-work markers without reading task bodies, conversations or model lines. Search, product scope, final outcomes, counts, cursors and the 24-task page size are unchanged. Command palette, prerequisite and coordinator history reads do not request usage.

The selected archived task is added only to its workspace’s display state, so opening it cannot double-count Analytics or product totals. Historical dependencies carry an explicit blocking decision, computed from their delivery state without loading conversations. Queue previews use that decision and the same live-task predicate as scheduling. The simulator offers the same commands against its small fixture.

## Window snapshots

Live summaries omit conversation bodies, timeline history, journey inputs and tool invocation lists. Tool summaries carry only counts, plain descriptions and the current running tool; command text and paths stay in separately fetched diagnostic evidence. The open task fetches its complete record when its revision changes, with at most one request in flight, a 400ms throttle and no idle polling timer or detail requests after closing. Responses carry the revision they read; archived work refreshes from the history revision. Revisions include the engine boot, so reconnecting after a restart refreshes the details. The simulator still supplies complete records directly. Message drafts stay in the window; typing updates only the composer, with the workspace notified when a draft appears or clears.

The first public message appears immediately. Further text chunks update that message in memory, with detail revisions and persistence notifications coalesced over 400ms. Other state changes and completed turns flush pending text, and shutdown saves the final words. Parallel message streams share the same bounded notification window.

SQLite stores active task bodies in separate rows. A streaming update marks only its task dirty; metadata and that row are saved together, without serializing untouched peers. Global transitions retain a complete save, and shutdown saves every task. Existing local data moves to rows atomically on its first load; finished records retain their history indexes.

The store retains its active ids between saves and reloads them after rollback. Identical metadata avoids a write; changed checkpoint times still persist with task clocks. Unchanged usage readings are rejected before opening a write transaction, and startup computes the highest numeric task id inside SQLite.

Author attribution filters turns by task, stage and round in SQL. Stage run counts use an indexed SQL count rather than loading moment bodies. Fixed parameterized statements already use Bun's compiled-query cache through `db.query`; there is no additional statement cache in the engine.

Each window has at most one unacknowledged live snapshot, identified by a transport counter independent of task ids and the state's counter. It acknowledges in a microtask after applying the state, without depending on paints in a hidden desktop window, so background inbox notifications keep arriving. A suspended or slow window holds up only its own next snapshot.

While it waits, the engine retains only a dirty flag and serializes the latest state when the window is ready; it never queues intermediate snapshots for that window. Commands and their replies remain independent, and another window can keep receiving updates. Dropped outgoing messages close the connection so pending calls fail and durable requests retain their normal retry identity. The app and engine use one current `petrina.v1` protocol.

This bounds delivery independently of the size of a separately fetched task record.

## Workflow events

The engine records compact workflow events on its shared change path (`workflow-events.ts` in core and engine). Whenever a task is noted as changed, the state projection compares a few compact facts for that task (state and wait kind, journey nodes with their inputs, results, checks, asks, check versions and reuses, inbox items, per-product delivery records, finding statuses and capacity retries) with the facts last recorded, and the differences become ordered events, before a batched save or retirement can hide a transition. Several journey entries arriving in one change each produce their events; an unchanged save produces nothing; routine tool actions, streamed text, progress wording, clocks and usage readings are not facts. The engine's loaded state is the baseline, so only later changes are events, and an archived task opened for a read is baselined silently. Events are retained per engine run, at most 10,000 or 16 MB, each within 8 KB with explicit shortening, and replayed in ordered batches with a cursor that never passes an undelivered matching event. Waits subscribe to the log and a deadline timer; the caller's disconnection or cancellation releases both. Nothing in the feed changes execution, admission or approvals. Tasks whose delivery can still change retain their comparison facts under the existing cleanup rule, including cancelled open pull requests. Settled facts may be retired; an archived task is baselined from its saved body before a later edit. Complete compact event details share the replay byte budget and are available through paged `watch.event` reads; shortening the preview never discards remaining finding identities or product results while the event is retained.

Each newly supplied agent message is saved once as an immutable file under the task's context folder, after context reduction and automatic additions; the journey input keeps its reference, size and identity, a manifest of the supplied sections (including unchanged complete-context references and omitted unchanged background, recognized from the recorded comparison), the fresh-conversation reason when recorded and the native conversation identity. Prompt assembly supplies the manifest from the same standard, automatic and task sections it actually emits, with browser additions attached before saving. The handoff records its bound product and versions, and review nodes and seat inputs retain the existing immutable blind-review reference after temporary round state ends. Later updates keep their saved copies the same way. Check events project the journey’s existing check-attempt evidence and the latest run’s provenance, without recording another version history. A reuse is recorded on that original step with its purpose, basis and available attempt identity. Each reviewer's or voter's accepted result keeps the finding records it touched as its own immutable copy. Reads of these records verify the saved file identity and report missing or changed evidence rather than substituting newer records. Coordinator-facing contracts are in [coordination](../coordination.md#follow-workflow-events).

## Optional SQL execution log

Start with `bun run engine --debug-sql` to log the shared state/history/work-log connection. It is off by default. `PETRINA_DEBUG_SQL=1` enables it for a CLI-launched process too, including an explicit `petrina engine start` when stopped. A normal restart preserves the launching flag or environment; stop and start without either to turn it off. A start request for an already running engine does not change its diagnostics.

`sql-executions.jsonl` in the Petrina data folder contains one `{ "sql": "SELECT ... WHERE id = ?", "ms": 0.42, "at": "2026-10-20T08:00:00.000Z" }` record per completed driver execution, including failed executions and reused prepared statements. It records the original SQL template, never bound values, expanded SQL, results or error messages. Iterators record once when exhausted or closed, timing only driver advancement and cleanup. Multi-statement `exec` calls remain one driver execution.

Outer transaction wall times go to `sql-transactions.jsonl`, without a `sql` field. They include nested savepoints and automatic transaction control, and must not be added to query totals. Driver timings include row materialization and any CPU, I/O or lock waits inside the call; they do not distinguish those costs or include writing the log.

Both files append across restarts and rotate independently at 10 MiB, retaining the current file and four numbered backups. Records are never sampled or truncated; one oversized SQL template can exceed the rotation size. Analysis covers the retained recorded period. A write failure disables logging with one timestamped engine-log message; SQL results and errors retain their normal behavior.

## Task summaries and step times

An ACP plan update names the agent's current to-do item: the first entry in progress. With none in progress, the last item stays until the agent picks another or hands back its result. The task saves this item separately from its latest tool activity, as one plain line with formatting removed and a limit of about 100 characters. The timeline keeps each new item. Tool calls only change the activity line.

Each actual non-bookkeeping tool call has its own identity, even when consecutive descriptions match. Streamed title, kind, command, location and status updates amend that record. Each journey step retains its latest 100 invocations across all seats, with lifetime action counts and last activity summaries per seat. Commands are capped at 4,096 characters, titles at 240, and paths at eight of 512 characters each; shortened metadata is marked. The runner’s metadata cache is also capped at 100 calls per turn and excludes outputs and arbitrary payloads. Updates to unknown or evicted calls cannot invent new actions.

The current running tool is separate from the last activity summary. Reported completion or failure removes that tool from running state; an overlapping call can remain active. With no active tool, the status says “Continuing work” rather than repeating a running command. Ending a turn or restarting clears running state without changing the harness’s last reported status. Missing command text or outcomes remain unreported; a turn end is not tool completion. Tool invocations belong to their original journey and reviewer/voter seat, including through usage replacements.

All supported tools, including Grok, use the same plain descriptions for searches, reads, edits and commands; their to-do bookkeeping stays out of activity. Agents are asked to word their to-do items for the coordinator, without file, function or command names. Completion messages, findings and lessons name the profile that finished the step, including after a usage handoff. The builder's saved conversation keeps its planned profile separately for matching a later fix or port to that conversation.

The item belongs to the current step's main agent. Finishing, failing, cancelling or starting fresh clears it; pausing also clears it because resuming starts fresh. A Petrina restart keeps it. The item is written before the next activity is shown, and with the ordinary save while the agent stays on it, even when the tool needs a fresh conversation, until the agent names its own item. A stand-in taking over from an agent that ran out of usage keeps it too.

Side errands inside a step (the Check finder, the Guide keeper) leave the step's item and clock as they found them. Reviewers and voters working at once each save their own item, activity and clock, keyed by their planned place in the round so a usage stand-in keeps the same work. The card and Right now show one steady member's item and clock, switching to an agent waiting for the coordinator when needed, then to one whose tool is retrying by itself. Other members' activity never replaces that item, and only a member's own run ends its retry status.

Each finished member leaves its own timing record; a fresh conversation after a restart keeps the saved item and elapsed work until it names its own item, but leaves no timing record. Next leaves out reviewers whose results are already saved for the current round. Older tasks have no item and use their latest action as before.

Every saved snapshot carries the time it was saved, including immediate saves. While a step works, a quiet checkpoint saves every 15 seconds too, so a long command does not lose minutes of elapsed work after a crash. Loading the state stops each clock at the saved time, excluding the time Petrina was offline; a crash can lose at most the last checkpoint interval of quiet work. The normal activity saves and an ordinary quit save more recently.

Each finished agent step leaves a small record on its task: role, first pass or repeat, time worked and finish time. Later design or review rounds, fixing findings and following the coordinator's call count as repeats. A clock saved with the step counts active work across restarts, stopping for questions and permissions, while waiting for usage, and while the coordinator drives the step in their terminal. Steps started again after a restart, pause, Try again or a usage stand-in leave no record.

The clock stops when the agent hands back a valid result, leaving Petrina's repository cleanup out of agent time. Grouped reviews count each agent's work separately, excluding only that agent's answer and permission waits. Tasks keep up to 60 records; older tasks simply have none. Reading estimates from the Analytics work log instead of this temporary record is a follow-up.

The shared summary rules read the median of the last ten finished steps of the same role and pass across all tasks. Fewer than three gives no estimate. Time left is the median minus time already worked, shown in rough words only while the agent works. The UI derives Next from the task's current plan and position. A running Check finder or Guide keeper is still preparing that step, so Next names the review, test or build they are getting ready.

Otherwise Next follows: design rounds and their limit, a review stage as one step naming every reviewer (one for a port review), the review rounds that keep sending work back while they converge, the coordinator's checks and calls, the check a review requires when blocking findings would stay open, earlier design checks skipped on the return path, and Petrina publishing the delivery itself. Nothing stores a second copy of the likely path, so plan edits show up immediately.

The simulator follows the same rules, with several tool actions under each scripted to-do item.

## Work log and usage

Petrina records what the squad uses so the coordinator can see what work costs in tokens and time, per task, per product and for the whole squad. No prices: on subscriptions they would mislead.

### One entry per agent turn

Each message sent to an agent and its awaited reply becomes one `work_turns` row. New turns also retain the exact journey step, agent start and parallel seat. Starts are independent of native sessions, so a continued conversation can span several steps without sharing their usage. Continuations within the same step and seat recover their start from saved turns of that native conversation; a fresh job or a fresh conversation gets a new start. The simulator keeps the same identities when its clock is shifted. Each saved report replaces the turn’s token figures and model lines; repeated reports never add another copy.

The node usage view reads only turns belonging to that step, including running turns with saved reports. Older turns without step marks count only when their whole lifetime fits one recorded agent step and the stage and actual role agree. Ambiguous overlaps and turns crossing step boundaries stay unassigned. Older steps with no separable evidence explain that their use cannot be shown on its own. Checkpoints and Petrina’s own work have no agent token figure.

| Group | Recorded fields |
|---|---|
| Scope | Task, product, stage and its name at the time, round, Builder-fix flag; planning counts as a stage |
| Agent | Role, tool, requested profile/model/effort, confirmed model/effort or “not confirmed”, switches during the turn, session |
| Trigger | First instructions, queued message, answer, unusable-result repair or continuation after an interrupt |
| Lifetime | Start, end, working time; finished, interrupted, paused/cancelled, agent stopped or lost when the engine stopped |
| Coverage | Whether the report includes only the main agent |
| Tokens | New input, cache reads, cache writes, output, reasoning as a subset of output, total |

A figure the tool doesn't give is stored as missing ("not reported"), never as zero.

### One line per model per turn

The `work_tokens` table keeps a model name and token figures, nothing else.

### One entry per notable moment

The `work_moments` table records events rather than conversation bodies:

- Stage start/end: outcome, elapsed time and agent time.
- Design round/outcome: actual participants, objections and blockers.
- Review verdict/outcome: supported open findings, new or confirmed, each counted once.
- Questions, permissions and checkpoints: time raised, time answered and answer kind.
- Failures: one plain reason per incident, including recovered Check finder or Guide keeper failures.
- Retries: immediate or deferred usage handoffs; saved obligations survive restarts.
- Unusable results that required repair.
- Task delivery, merge, closure or cancellation.

### Every product Petrina has ever had

The `products_ever` table retains id, name, repository, when added and, if removed, when.

### Readings of the tools' usage limits

The `usage_readings` table records which limit, how much of it was used, its status, length and reset time, and when the tool said so. The last thirty days are kept, and a reading identical to the latest one of its limit is not written again, so a tool repeating itself on every turn leaves one row per change. Analytics groups older and current Claude model-window names into the same allowance without rewriting saved readings.

The tables live in the engine's SQLite file next to its state and survive restarts. Work history is retained; account readings keep the thirty-day window above. They hold only numbers, names and ids: no prompts, replies, commands or file paths. The dollar figure Claude Code sends is never read. The app never receives the log: the work-log state only carries a counter that changes when an entry is written and when tracking began.

Limits use the existing shared pool reports (`pool.usage`) and blocked tools and models (`pool.limited`), so Analytics, the pool and Agents always read one source. Each view asks the engine for its own numbers with one checked request (`usage`, with a fixed set of views and periods), and asks again when the counter changes or the local day rolls over. The per-product totals are added up by SQLite, so they stay fast after a year of turns.

The simulator writes the same entries in memory, and the demos start with thirty days of them.

Questions, permissions and checkpoints are recorded when raised. An answer completes that same entry, retaining when it was asked, even if a pause or restart has removed it from the inbox. Cancelling or pausing never removes the request from history, and unanswered requests never count as zero-length answers. The demos keep inbox requests and their history on the same identifiers too, so answering a seeded request never counts it twice. Design rounds and outcomes name the profiles that actually returned the brief and objections, including replacements, rather than the planned profiles.

Working time leaves out the time an agent waits for the coordinator: permission answers inside a turn are subtracted, and questions, checkpoints and waits for a free slot fall between turns. When an agent asks for two permissions at once, the time either is open counts once, so the overlap is never taken off twice.

### Counting tokens

- Petrina works out every total itself as new input + reused input + written input + output, the same way for every tool, so nothing is counted twice. When a tool gives only a total, that total is used. (Claude Code and Codex already separate cached input; Petrina separates Grok's inclusive input before recording it.)

### Claude Code

Claude Code attaches a per-model breakdown to each turn (`_meta.quota.model_usage`, from the SDK's `modelUsage`). It already includes helper agents, side conversations and compaction. Each model is kept as its own line, exactly as reported, and the turn's figures are the breakdown's sum. The main figure (ACP's `usage`, main agent loop only) is never added on top. Without a breakdown, the main figure is kept as one line under the confirmed model and the turn is marked "main agent only".

### Codex

Codex gives one figure per turn, kept as one line under the model Codex names for the turn. If Codex rerouted to another model during the turn (`model/rerouted`, announced as a notice), the line is marked "changed during the turn": it can't be split between models. A `spawnAgent` tool call means a helper agent Codex doesn't report on, so the turn is marked "main agent only".

### Grok

Grok reports whole-prompt usage in `_meta.usage`, including collected subagent work. The per-model breakdown is counted once; a valid aggregate without a complete breakdown stays under "Model not reported". Its sibling token fields describe only the last model call and its sibling total is context size. Input includes cache reads and writes, which are subtracted to record new input; reasoning is already included in output. An incomplete report stays unreported. A confirmed resolved model keeps tokens and agent time on the same model row.

### Antigravity

Native session counters are read before and after each turn, subtracting the previous totals after resume. Thinking is included once in output and also recorded as its subset. Cached and new input are not split by the connector and remain unreported. Context-window usage updates are not token bills.

Quota figures are remaining percentages, converted to used percentages. Google reports Gemini Models and, on accounts with a separate allowance, Gemini 4 Argon independently. A reported 100% remaining is 0% used, not a missing report; unavailable figures never become zero. Group names remain the provider's own. Scope and reader timing are in [runtime usage limits](engine-runtime.md#account-readers).

### No helper figure, and effort stays on the agent

Claude Code folds helper agents that use the same model into that model's line, so nobody can say how much was helper work; Petrina doesn't try, and keeps no separate helper figure anywhere. Token lines carry only a model and its figures. Effort belongs to the agent's turn (asked for and actually run) and is shown on the agent, never next to tokens.

In the model split, tokens group by the model on each line; agent time goes to the model the agent's session ran on; a model that only appeared inside turns shows its time as "not reported". Petrina recognises Claude model ids (family, version, an optional date) and shows them plainly. Grok’s verified `grok-4.7` session alias and `grok-4.7-build` response model share the name "Grok 4.7"; resolving this alias is not a model fallback in profile comparisons. Raw requested and actual ids remain in the log.

Every other name, a bracketed ending such as `[1m]` included, stays as reported, so unfamiliar variants never share a line.

### Asked for and actually ran

After setting a profile's model and effort, Petrina reads back the session's config options and records what the tool says it is actually set to. A value the tool doesn't offer isn't forced: the session keeps the tool's default (as before) and the entry keeps both what was asked and what ran. Petrina keeps listening: Claude Code sends a `config_option_update` after a fallback, Codex announces a reroute.

If the tool doesn't say, the setting is "not confirmed", never a guess: a tool that acknowledges a change without sending its options back leaves that setting unconfirmed. A switch the tool confirms during a turn is kept on that turn's entry even when the agent stops before replying. Comparisons per profile only count an agent's stage when all its turns, across every round of the stage, ran on that profile's own model and effort.

That is judged on the stage's whole history, so a round before the chosen period still takes the credit away. Code and Security reviewers both keep their stages and agent time in comparisons. Profile time follows the same unknown and partial-total rules as every other total.

### Product identities

A product's id is never handed out again. A new product's id is checked against current products, removed products and every id in the work log, so a different repository with the same name, or the same repository added again after removal, starts fresh and never inherits history. Removing a product keeps its entry, marked removed, and its work still counts in squad totals under its old name.

On the first start with a work log, any product id a task still points to that is no longer in the list is recorded as removed (without a name: Petrina never kept it). If the saved state is ever lost, task and product ids in the log are still never reused.

### Limits

Reader protocols, refresh timing and scheduling effects live in [runtime usage limits](engine-runtime.md#usage-limits). Only a limit's reported percentage, status, window, model group and reset are retained. A failed read leaves an earlier report and its timestamp intact; with none, the figure is unreported. Reports survive restarts, and an expired reset is shown as such rather than carried into the next window. Analytics and the pool share the Usage component; Agents shows slots, the queue and tool readiness.

The pool keeps only the latest report per tool, model group and kind of limit. Every report from a tool also goes into the thirty-day history beside the work log (`usage_readings`, see above), unless it repeats the latest reading of its limit. Analytics sends bounded summaries of it: one highest reported percentage per local day (real elapsed hour for Today), per distinct tool/kind/recorded model scope, and lightweight choices for the latest account report and thirty-day history. Only Claude’s proven window aliases join. A missing percentage stays missing, including rejected legacy extra-usage reports. Summary buckets include coverage, percentage-report counts and possible-reset counts; they never contain individual readings. The latest pool reading supplements saved history when newer. Only the selected allowance is drawn.

A shared possible-reset rule compares successive numeric reports of the same allowance: a fall qualifies when the earlier reported reset passed, or its schedule moved later beyond the elapsed report time by at least a minute. This tolerance also applies to forecasts drifting with the clock. Schedule differences under a minute are equivalent both for inference and the readings view’s “Unchanged” schedule label. Raw reset timestamps stay intact. Changing zero-percent forecasts create no counts. These are possible resets, never confirmations. The paged `readings` usage view applies the same identity and change rules, returning at most twenty rows for one tool/allowance and at most 31 days, with a bounded offset. It never refreshes an account. A checked request carries just the selected allowance’s latest report and a fixed source-time cutoff, so later pool refreshes cannot shift open pages; raw history stays in its existing owner. New requests use original UTC timestamps; local buckets span full clock-change days and distinguish repeated hours by offset. Token bucket rules are unchanged.

Analytics also charts tokens over time from the per-model lines: per day (per hour for Today), split by tool, by model or by provider (Anthropic for Claude Code, OpenAI for Codex, xAI for Grok, Google for Gemini: a small map in `@petrina/core`), measuring all tokens, one part of them where the tools reported it, or agent time, with the running total. All three splits are worked out in one view, so the window switches without asking again, and they add up to the same totals.

Token charts use plain SVG and usage history uses HTML bars, drawn by the app without a chart library. Missing reports stay distinct from zero; partial buckets and running totals use `>`. Tooltips and tables keep exact token counts while axes stay compact. Usage-history bars show recorded maxima only; missing buckets never carry a prior reading forward.

### History card totals

History and the simulator attach tokens, agent time and the empty-state marker to each requested page item. They share the task details' summary rule over finished turns, including every agent start, retry, review and fix round once; repeated token reports replace a turn's figures. The SQLite tally uses the same aggregation as product totals. A product-filtered page still reads whole-task usage for shared work. No elapsed time is inferred from creation or finish dates, and no live clock enters these totals. The open History page refreshes on the work-log version used by task details, as well as the archive revision, so a cancelled agent's last recorded turn can update its card.

The card labels time as “agent time” and uses the same compact numbers and independent `>` markers as What it used. Without a figure it says “Tokens not reported”, “Tokens not known” or “Agent time not known”. An entirely untracked task says “Tokens and agent time not recorded”; a task with nothing run has no line, including cancellations before starting and combined requests. Recorded totals mixed with earlier or lost work keep their partial markers. This empty History summary does not change task usage reads: task details and the coordinator’s analytics read retain exact zero figures with the “nothing run” marker when no agent has run.

### Partial totals

A total uses `>` only when whole turns are known to be missing, judged separately for tokens and time. Tokens: a turn with no token report, a turn lost when Petrina stopped, or work from before tracking began. Time: a lost turn or work from before tracking began. Turns counting the main agent only, cache reuse, the tools counting differently and model changes never make a total partial; they are explained once in the "About these numbers" note.

Petrina remembers when it started keeping track; tasks that had started before then are marked "earlier work not recorded" for good, and so are their products' totals and any period that starts before tracking began. The splits keep the warning too: in a period that starts before tracking began, every tool, model and role line uses `>`, and so does every product line except products added after tracking began, which can't be missing anything. A turn still running when Petrina stops is marked lost on the next start.

When nothing known adds up and work is missing (only earlier work, or only lost turns), there is no number at all: it reads "not known", never `> 0`; a figure a tool didn't send reads "not reported". Deliveries and cancellations are charted per day in every period, Today as one column.

### Why no prices

Claude Code sends an estimated dollar figure, but on a subscription it describes nothing the coordinator pays, and Codex sends none. Showing it would mislead, so it is never stored or shown. Tokens and time are the honest measure.

## Account refresh attempts

Account readers publish live attempt status separately from successful usage reports. Failed or empty reads retain the previous allowance and report time, without adding a chart reading. Analytics requests fresh data on minute changes in the existing window clock even when the squad is paused; shared reader throttles and in-flight deduplication still bound CLI calls. Leaving Analytics stops those view-driven refreshes.
