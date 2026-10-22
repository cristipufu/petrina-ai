# Coordinate Petrina from a terminal or coding agent

The CLI and MCP server operate the same local engine as the desktop app. They coordinate products, tasks, checkpoints and the agent pool. Editing source, Git operations, development tests and repairing Petrina stay with ordinary coding tools. Petrina never merges a pull request. For how an external coding agent should manage projects, Backlog, Inbox decisions and delivery through these tools, read [the external coordinator guide](coordinator.md).

## Install and discover

From a source checkout, install its locked dependencies with `bun install --frozen-lockfile`. Use `bun run petrina` in that checkout. To install the terminal command for your user, run `bun link` in `packages/engine`, then use `petrina` from your terminal. Bun must be on your PATH. The desktop package's engine is not a separately installed CLI yet.

```sh
bun run petrina --help
bun run petrina task --help
bun run petrina task add --help
bun run petrina engine status
bun run petrina task list --states '["needs-you","failed"]' --json
```

Help comes from the same operation catalogue as the MCP tool descriptions and argument schemas. Groups are `engine`, `task`, `inbox`, `learning`, `review-guide`, `product`, `plan`, `journey`, `pool`, `tools`, `screen`, `analytics` and `watch`. `watch events` follows workflow events; see [Follow workflow events](#follow-workflow-events). Options use names such as `--task-id`. An inspect command also accepts its identifier immediately after the operation. Arrays and objects take JSON; boolean flags accept `true` or `false`. Output uses plain language unless `--json` is present.

A delivery decision with failed or unverified product checks offers `inbox rerun-checks` or `inbox changes`, never delivery approval. Reruns use the inspected revision and durable request reference, execute fresh checks without granting another automatic repair allowance, and resume the remaining workflow only after a pass. Inspect the next decision separately before approving delivery.

Existing `state`, `do`, `serve` and `open` invocations remain available. `state` returns the current board snapshot with compact history totals; use the focused commands for ordinary coordination. Agents should use the named operations, which add revisions and durable receipts, rather than the older generic `do` command.

Structured options show their JSON shape and a valid example derived from the operation schema. For example, `--start-from '{"kind":"branch","name":"main"}'` selects a branch. Malformed or invalid values name their option and expected shape before any request reaches the engine.

Use `task conversation TASK --node-id NODE --limit 8000` to follow recent messages without replaying earlier steps or routine tool actions. It returns the most recent text within that character budget, in chronological order, with stable message IDs, revisions, offsets and original lengths. A `next` cursor reads older text and survives new messages arriving. A changed unread prefix requires a fresh read. Poll the recent page with `--if-revision REVISION`: unchanged text is omitted. Replace a cached message when its revision changes; an active node's messages may still be streaming, including when a parallel peer speaks later. `mayChange: null` means the message has no recorded node status. Add `--include-activity` for routine actions. The original full conversation remains available through `task read --section conversation`.

`task activity --task-id TASK` inspects the latest agent step’s tool evidence. Select an older step with `--node-id NODE` or one worker with `--seat SEAT`. It returns per-seat last activity, currently running tool, lifetime action count and a paged recent invocation list with timestamps, reported states and available bounded command or file details. `task inspect` includes the small task and worker summaries; `journey node` includes recorded per-seat evidence. An absent status or command is unreported. `turnEndedAt` means observation stopped, never that the tool completed; only a reported completed or failed state supplies `endedAt`. Older steps without tracking remain unavailable.

`activeMessages` lists the current message reference and revision for each participant in an unfinished node, including one outside the recent text budget. Changes there also invalidate `ifRevision`. Use `--message-id ID` to read a specific changed message without replaying its peers.

`task list` reads current work, including backlog. `task history` reads finished and cancelled work newest first in pages of 25 (maximum 100), without loading its conversations or plans. History search matches title word prefixes, as in the app. A finished-only `task list --states '["done"]'` also reads history; current and finished state filters must be read separately. Changed history invalidates continuation references. Inspect any returned task ID with `task inspect`, then read its plan, journey or evidence separately.

To review a request before agents start, use `task add --backlog --title "Review this request"`, then `task update-backlog TASK --title "Reviewed request" --description "Clear requirements"` and `task queue TASK`. Queueing is explicit. An unstarted queued task can return to review with `task backlog TASK`. These operations have matching typed MCP tools and durable request references.

After filing or finding a confirmed older bug yourself that Petrina left “Not tracked”, use `task track-finding --task-id SOURCE --finding-id REPORT --target-task-id BUG --request-id REFERENCE` (MCP: `petrina_task_track_finding`). The source may be in History, but must be done with a complete confirmed older report and a saved untracked outcome. The target must be another non-cancelled bug task covering all reported products. An open target gains the report and copies of its pictures, preserving its request and products. A finished target remains unchanged; original pictures must already have been cleaned up. The action waits for automatic linking and can finish an interrupted picture copy to the card already holding the report. It refuses a different target, even when the assigned card has moved to History, and never runs agents or creates a task. Retrying identical arguments with the same reference returns the saved outcome; linking again to the same task makes no change.

Both interfaces discover the existing connection in `~/.petrina`. Set `PETRINA_HOME` only when you intentionally use a different Petrina data folder. Its private key stays in the local connection file and authenticated request headers. Do not copy it into MCP configuration, commands, addresses or logs.

## Connect an MCP client

Configure a local **stdio** server. Replace the example paths with your checkout and Bun executable; the client can launch it from any folder.

```json
{
  "mcpServers": {
    "petrina": {
      "command": "/absolute/path/to/bun",
      "args": ["/absolute/path/to/petrina/packages/engine/src/cli.ts", "mcp"]
    }
  }
}
```

The server uses the MCP [stdio transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) and [named tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools). Discover them with `tools/list`: for example `petrina_task_add`, `petrina_task_inspect`, `petrina_inbox_approve`, `petrina_learning_accept` and `petrina_engine_pause`. Arguments have explicit types and choices. Results include a structured `outcome` plus the requested compact data or an evidence page. Connecting MCP never constructs or launches an engine. An explicit `petrina_engine_start` or `petrina_engine_restart` request may use the existing launcher.

Tool annotations identify read-only queries and retries. Changes can interrupt work, replace executable check settings, authorize publishing or grant screen access. The client applies its normal safety assessment to those effects, and Petrina's existing gates remain authoritative.

## Lifecycle and ownership

```sh
petrina engine start --wait
petrina engine pause --wait --timeout-ms 30000
petrina engine status --json
petrina engine resume
petrina engine restart --wait --timeout-ms 60000
petrina engine stop --wait
```

Pool pause saves a paused scheduling preference and closes new admissions. Admitted agents finish their current steps. Additional reviewers, voters, helpers and usage replacements must wait for resume. Helpers internal to an already open coding-tool session are part of that step. Task pause is different: `task pause TASK` interrupts that task under the existing app rules.

Resume may reopen scheduling while a pause is still draining. Stop or restart may also replace that pause, keeping its saved scheduling preference. The earlier pause wait then returns `superseded`, naming the replacing request, rather than claiming the pool drained. Resume cannot bypass an unfinished stop or restart. Requests following an existing restart receive its final completed or failed result under their own saved references.

If the desktop reconnects after its child exits during restart, its launcher follows the saved handoff and discovers the requested replacement. A live replacement keeps ownership of startup, even before it answers. If the handoff process has exited and the folder is free, recovery records the original operation as failed and starts one new engine. Concurrent reconnects discover that same engine. A completed intentional stop stays stopped.

A drain includes agent processes, check runs, deliveries and necessary cleanup. Status separates work still finishing, questions and permission/screen blockers, queued tasks, saved checkpoints and pending review participants. A partially started review does not pass simply because its admitted peers finished. Their results stay saved; resume runs the missing participants. A vote's `pendingParticipants` entry also carries `verifierPanel`: the rule, the tools usable when it was chosen, every place with its tool, assigned finding ids, ids it still owes and why it was chosen or replaced, and the third-answer decision per finding, including findings left unresolved.

Stop and restart keep draining until admitted work settles. They have no forced deadline. A caller's `--timeout-ms` ends only its wait, with a `timed-out` result; the lifecycle operation continues. Resolve named blockers or explicitly interrupt/cancel the relevant task if that is the decision you want. A coordinating agent waiting for its own slot to drain must release that work first.

Restart closes the old engine, releases the folder's existing ownership lock and launches one replacement through the existing launcher. The replacement preserves the connection key and port, saved task state, completed peers, queued messages and supported conversations. Paused scheduling stays paused until an explicit resume; running scheduling continues once the replacement is ready. Desktop recovery steps aside for the existing owner, respects an intentional stop, and does not interrupt a handoff. Closing the desktop during an explicit restart leaves the requested replacement running in the background. A replacement runs independently of the original desktop child; stop it explicitly when finished.

Start discovers an existing owner. An owner that does not answer is `unresponsive`; silence never authorizes a second engine. Startup failures remain visible in status and the local engine log. Repair the cause through ordinary coding tools, then explicitly start again using a new request reference. A restart of a confirmed stopped engine starts once. Another restart while one is unfinished follows that operation; a competing lifecycle change returns a conflict identifying the operation already under way.

If the app closes during an unfinished pool pause, opening the app or explicitly starting the engine restores it with the saved paused preference. A status or resume request may first record that pause as interrupted; this does not block desktop recovery. Failed pause receipts stay available, and a recovery start has its own receipt. Resume explicitly when ready to schedule again.

## Safe retries and decisions

Every change requires a request reference. MCP callers supply `requestId`. CLI callers can pass `--request-id`, or the CLI prints a generated reference to stderr **before** submitting the request. Keep that reference if the reply is lost. Repeating identical arguments returns the saved outcome and task/message references; changing the operation or its arguments under that reference is a conflict. Wait flags and wait deadlines can change without changing the lifecycle effect.

A disconnected lifecycle request may still be queued behind an app action. Until the engine applies it and saves its receipt, the caller reports that acceptance is unknown. Retry the original reference: recovery never reserves a scheduling or shutdown change on the live engine's behalf.

Task receipts last with the saved task data; lifecycle receipts survive engine replacement. Synchronous decisions and their receipts save in the same transaction as the task state. Asynchronous source validation and stuck-item retries first save a pending submission. If the engine is interrupted before their final outcome is recorded, retry returns that pending submission; inspect the task before issuing a fresh request. There is no blind repeat of an uncertain effect.

A rejected starting-point change returns `invalid` and its saved validation explanation. The previous approved source stays in place, and the plan request stays open. Correct the choice with a new request reference; repeating the old reference returns its original rejection.

Inspect an inbox request before deciding. The result provides its `revision`, available decisions, recommendation, choices and the actual recorded request through bounded pages. Return that revision with the decision. Checkpoint inspection is a compact decision view; [checkpoint and review reports](coordination-reports.md) describes its evidence links and the route from an event to a decision. Plan revisions include scope validation, starting points, destinations, full stages and assigned profiles. Changes to decision evidence, including omitted bodies and original diagnostic file facts, leave the request open and require fresh inspection. Clocks and unrelated activity do not invalidate it. A successfully retried decision returns its original receipt even after its request closes.

`inbox approve` handles only plan, design, delivery and disagreement checkpoints. Questions use `inbox answer`; tool requests use `inbox allow` (once only) or `inbox deny`; stuck items use `inbox retry`; interrupted deliveries use `inbox recovery` with `check`, `ship-again` or `mark-done`. Marking done leaves delivery visibly unconfirmed. Existing delivery checks remain authoritative.

Learning offers use `learning inspect`, `learning accept --positions '[0,2]'`, or `learning decline`. Positions start at **zero**; acceptance needs a nonempty valid selection from the inspected revision. Unselected lessons follow existing decline behavior. Review-guide proposals have their own inspect, accept and decline operations. Accepted points follow existing delivery timing; the interface does not edit product files directly.

## Focused evidence and waits

Lists filter inside the engine before pagination. The default is 25 items, capped at 100. Task inspection gives the current summary, workers, next step, waiting reason, inbox references and delivery confirmation. Plans, conversations, findings and individual journey nodes are separate evidence reads. Evidence defaults to 8,000 characters per page, capped at 32,000. Diagnostic files use byte offsets and preserve UTF-8 boundaries. A `next` value is passed back as `--cursor`. `shortened` explicitly identifies unfinished text reads. Changed evidence or list contents invalidate their continuation and require a fresh focused read.

Journey nodes distinguish recorded, planned and older reconstructed evidence. Accepted agent results keep their original response and separate references to any saved pictures; picture bytes remain available only while the task is unfinished. Missing inputs/results stay unavailable. Each newly recorded check keeps its original diagnostic link in the journey, so later checks and restarts do not replace its log. `journey check --task-id TASK --node-id NODE --index 0` starts at the beginning of that original log. Without a node it reads the latest task check. Results separately describe command outcome, historical or recorded-version relevance, and complete/incomplete/legacy/missing diagnostic evidence. An old excerpt or missing log does not establish a current pass.

Diagnostics also include a bounded `savedResult`, covering failure to start, deadlines and cleanup warnings saved outside process output. Continue its `next` cursor with `journey check --section result`; the ordinary diagnostic cursor continues the process log. When a log is empty but a saved explanation exists, the main text shows that explanation and labels its source. An empty successful log still means a quiet check, with its recorded pass and completeness reported separately.

Full-log reads require the facts Petrina recorded through the log file it created: device and file number, settled length in bytes and a SHA-256 fingerprint of the first 4,096 bytes (the whole file when shorter). The opened file must match all of them and be a regular file with a single directory entry in the task's check folder. A removed log's file number can pass to a later file, so identity alone does not recognise the log. The fingerprint recognises its beginning; it does not authenticate every later byte. A symbolic shortcut, substituted file or unavailable file falls back to the saved excerpt. Older records without these facts also return their saved excerpt, labelled unverified or incomplete; facts are never rebuilt from a current path. The check's own result and the retained file, byte-for-byte process output, are unchanged. A changed continuation asks for a fresh read without returning a replacement page.

`analytics inspect` reads one report as of its first page: every page, and every unsuccessful continuation that identifies its read, returns that page's `asOf` time in milliseconds. A read without a cursor uses current data. A product read's first page keeps a private copy of the live allowance readings it used; each continuation rebuilds the complete report at `asOf` from that copy and saved readings up to `asOf`, and checks it against the first page before returning text. Passing time, midnight and later account refreshes therefore never interrupt it. Newly recorded usage, a saved reading inside the view, or changed task or product details return `changed`. These holds expire ten minutes after the first page (`expiresAt`), and continuing does not extend them. One engine keeps at most 64 holds and 1 MB across all callers, evicting the oldest first; one read's readings over 64 KB make it `unavailable` rather than shortened. Expired, evicted and restarted reads return `unavailable` with a `reason`; malformed, unsupported, mismatched or out-of-range continuations are `invalid`. None of these returns report text or substitutes current data. Task usage depends on neither time nor live readings, so its continuation needs no hold and stays valid while that usage is unchanged.

```sh
petrina watch wait --target task --task-id TASK --condition decision --timeout-ms 60000
petrina watch wait --target task --task-id TASK --condition state --states '["failed","cancelled"]'
petrina watch wait --target inbox --kinds '["question","permission"]' --condition decision
petrina watch wait --target pool --condition drained
```

A wait returns compact matching summaries and a `marker`. For changes, return that marker on the next wait so changes since the previous response are included. Already satisfied conditions return immediately. A different engine boot reports `continuity-lost` and supplies a fresh focused result. Disconnection and quiet deadlines are distinct results. Ending a watch never cancels work. `delivered` includes awaiting merge and confirmed landing; `landed` requires recorded landing. Cancelled, closed and marked-done/unconfirmed deliveries do not satisfy either condition; a task you marked done stays `marked-done` in inspection, lists and History even when a later lookup finds its pull request merged. For a task across several products, inspection, lists, History and both conditions judge the whole task, whichever product is shown or leads: it awaits merge only once every product has published and its companion links are finished, and lands only once every publishing product has landed. A closed pull request you accepted can release dependent tasks but never counts as delivered. To follow transitions rather than conditions, use the workflow-event feed below.

## Follow workflow events

`watch events` is the monitoring feed for coding agents: one ordered stream of meaningful workflow changes, with compact handoff facts and links to the exact saved evidence, so an agent follows work without rereading task bodies. The same operation serves the CLI (`petrina watch events`) and MCP (`petrina_watch_events`).

```sh
petrina watch events --timeout-ms 0 --json                         # a starting cursor, no events
petrina watch events --task-ids '["TASK"]' --cursor CURSOR --timeout-ms 60000 --json
petrina watch events --product-id PRODUCT --cursor CURSOR --json   # a product's current work, new tasks included
petrina watch events --from oldest --limit 100 --timeout-ms 0 --json  # replay this engine run's retained events
petrina watch events --product-id PRODUCT --follow --json          # continuous: one batch per line
```

Scopes are selected task IDs (up to 100), one product's current work, or all current work. A product scope follows the existing board definition, so a task created or admitted later enters automatically, and a shared task keeps every product it retains. Completion, cancellation and final publishing events stay readable after the task leaves current work.

Events cover node and seat starts and finishes, checks queued, started and completed, check reuse, task-state transitions and waits, coordinator requests and decisions, repair returns, retries, usage or capacity replacements, review completion and each product's publishing result. Routine tool actions, streamed text, progress wording, clock updates and usage-meter refreshes are never events, with or without a `kinds` filter; `task conversation` and `task activity` remain the way to inspect those. Each event has a stable `id`, the engine `run`, a strictly increasing `seq`, `at`, the task, its products and, where applicable, `productId`, `nodeId`, `seat` and `attempt`, a plain-language `summary`, a `cause` naming the step, check or decision that led to it, and `refs` that select exactly one input, manifest, result, finding copy or check diagnostic. Events never embed prompts, conversations, code, complete logs or task snapshots.

### Waiting and continuing

Selected task IDs are checked against the task index, never by loading archived bodies, so renewing a quiet wait over up to 100 finished tasks reads no archive. Available events return at once. Otherwise the request stays open until a matching batch, its deadline (30 seconds by default, up to an hour; `--timeout-ms 0` queries without waiting) or cancellation. Continuous `--follow` requires a positive deadline; zero is available only for a single query. A quiet deadline returns `timed-out` with an empty batch and the same cursor; nothing is replayed. Batches default to 25 events, capped at 100 and 64 KB; `more` says whether matching events remain, and each event stays within 8 KB, including nested causes. Shortened previews carry `shortened`, `shortenedFields`, original list `totals` and `refs.details.eventId`. Read the original compact event with `watch event --event-id EVENT --json`, following every `next` cursor. This returns the complete finding identities, per-product results and explanations from that event, rather than current task data. These pages share the event retention budget and report unavailable after eviction or restart. The 64 KB batch limit includes the entire reply envelope.

Return `cursor` on the next call. Appends never invalidate it, and repeating a cursor replays the same event identities. It never advances past an undelivered matching event; unrelated events the engine inspected are passed. A cursor may be reused with the same scope or a narrower one (all work to a product or to tasks, a product to tasks it involves, unfiltered kinds to a subset); a malformed, future or wider scoped cursor is `invalid`, because a wider scope would pass events the cursor's scope never delivered. Without a cursor, observation starts now; `--from oldest` replays the oldest retained events of this run. The engine retains at most 10,000 events or 16 MB per run. After a restart, an expired replay window or unavailable history, the result is `continuity-lost` with `reason`, the available `boundary` and a fresh cursor: observation is incomplete from there, and a new start is your explicit choice. Nothing manufactures old events.

A blocking MCP wait is the primary pattern for a coding agent: the tool request stays open until a batch or its deadline, and a quiet deadline returns an empty batch and cursor without snapshots, so the client can renew it without replaying anything into the model. MCP needs no unsolicited notifications. A cancellation notification ends the pending wait with the same request id and id type (the number 7 and the text "7" are different requests), and closing the MCP connection ends every outstanding wait; the engine releases its subscription and timer promptly, and work continues. Choose a deadline safely below your host's actual tool time limit: Petrina keeps long waits open, but it cannot wake a finished agent run, keep one active, or promise that your host renews a quiet wait without a model turn. Printed terminal output alone does not wake a coding agent; `--follow` serves human readers and clients that forward its lines. It prints one batch envelope per JSON line, renews quiet deadlines silently, and stops with an explicit final result on disconnection, lost continuity or refused arguments. Interrupting it or closing its output pipe ends the stream without cancelling any task work. Watchers, however many or slow, share the bounded log and never hold agent seats or change execution, admission or approvals.

### The monitoring loop

1. Take a starting cursor before acting, in the scope you will follow or a wider one: `watch events --product-id PRODUCT --timeout-ms 0` (or `petrina_watch_events` with `timeoutMs: 0`). Save its `cursor`; after creating a task you can narrow to that task.
2. Act: create a task, approve a plan, answer a question.
3. Wait from the saved cursor with the task, product or all-work scope and a deadline below your host's limit.
4. Inspect the compact facts in the batch: who started, on which seat and attempt, in a fresh, continued or resumed conversation and why, the requested and selected profile with its selection reason, the triggering step, check or decision, and the input manifest.
5. Fetch specific evidence only when warranted, reading every continuation page: the exact input, a result, a finding copy, a check diagnostic.
6. Continue from the returned cursor. Repeat.

The feed supplies recorded facts; you make the diagnosis. It adds no automatic reviewer, no execution gate and no expected-time thresholds.

Each `seat.started` event carries the handoff: `seat` (`builder`, `reviewer:1`, `verifier:PLACE`, where a vote's place is its original planned profile, or `third:PROFILE` for a targeted third answer, kept through replacements) and `attempt` keep parallel participants apart even on the same role and profile; `mode` is `fresh`, `continued` for a later step in the same conversation, or `resumed` for an interrupted step; `builderConversation` says `resumed` or `new` for a fix round, and `freshReason` is recorded only when Petrina knows why the saved conversation was not reopened; `readiness` is present after a saved conversation's [bounded readiness recheck](architecture/agents.md#checking-the-tools), with the earlier answer and its time, whether the check was `started` or `joined`, and its `outcome` (a check status, or `no answer` when none came within the limit); `conversation` is the native conversation identity; `requestedProfileId`, `profileId`, `selectionReason` and `confirmedSettings` say who actually works and why; `cause` names the triggering step, check or decision; `productId`, `stepAttempts` and `versions` are recorded from the repository bound to that start, with its base, reviewed and checked versions needed to judge freshness; missing historical shared-product ownership is unavailable; `exact` is the saved message reference with its size and identity, or `null` when an older record has none (a saved message is what Petrina handed to the tool, never proof that the tool received it; later updates carry their own delivery state); `manifest` lists the first 12 supplied sections with names, text sizes and content identities, with `manifestTotal` and a `refs.manifest` page for the rest. A `reference` entry is an unchanged complete-context packet named instead of repeated; an `omitted` entry is unchanged background left out of a continued conversation, recognized from the recorded comparison; duplicate section names carry an `occurrence`. Missing historical facts stay missing: nothing reconstructs a reassuring explanation.

```sh
# A parallel reviewer's exact input, without loading the task body:
petrina journey input --task-id TASK --node-id NODE --seat reviewer:1 --limit 32000 --json
petrina journey input --task-id TASK --node-id NODE --seat reviewer:1 --section manifest --json
petrina journey input --task-id TASK --node-id NODE --seat builder --section update --update 0 --json
petrina journey result --task-id TASK --node-id NODE --seat reviewer:1 --json
petrina journey finding --task-id TASK --node-id NODE --finding-id FINDING --result 0 --json
petrina journey review-input --task-id TASK --node-id NODE --section versions --json
petrina journey review-input --task-id TASK --node-id NODE --section findings --json
petrina watch event --event-id EVENT --limit 8000 --json
```

`journey input` returns the saved text after checking its recorded identity; a missing or changed file reports that condition and never substitutes rebuilt or newer text. Exact messages are saved beside the complete-context files, so they follow the task's existing context cleanup. `journey finding` reads the immutable copy saved with a node's result (`--result N` selects one seat's copy); later peers and rounds cannot rewrite it, and a finding absent from that copy is `missing`.

### What to notice

- **A Builder finishes.** `seat.finished` for the Builder is separate from the checks. Then `check.queued`, `check.started` and `check.finished` events name each command and its original diagnostic (`refs.check` for `journey check`), or `check.reused` says the saved run still covers the same code and check-and-hook definitions, with its basis, versions and purpose (`acceptance`, `review`, `delivery-check` or `publishing`). Each completed command names only its own attempt’s recorded versions. The whole attempt’s `versions.passed` is unavailable while other checks or hooks remain unfinished; the command’s `ok` reports that command alone. The reuse is saved on the original run's journey step, so it survives restarts and later runs. The “Previous checks reused” handoff that follows a Builder return appears as its own `node.started` and `node.finished` with `work: check-reuse`, and a delivery decision keeps a supporting snapshot of the same evidence; those copied entries produce no `check.queued`, `check.started` or `check.finished`, because nothing ran: `check.reused` on the original step is the record of the reuse, and `refs.check` always points at the entry that actually executed. The Tester's or reviewer's `node.started` carries `checks.basis`: `ran`, `reused`, `none-configured`, `unfinished` or `unavailable`, with `passed`. A run interrupted and resumed on the same step keeps the stopped attempt as history: the basis and the step's `node.finished` counts describe the latest attempt only, named by `attemptId`, with `attempts` saying how many there were, also when the resumed attempt had nothing left to run. A product with no checks and no commit hooks still records a checks step with no entries, so its reviewers start on `none-configured` (`passed: null`, `configured: 0`), also when that empty run is reused; `unavailable` means the record is missing, not that nothing was configured. Review and acceptance check every product in turn, so on a task spanning several products `checks` lists each product's own latest run or reuse under `products`, in task order, with a plain `summary`; the combined `basis` is `mixed` when they differ, and the combined `passed` is `false` if any product failed or did not finish, `null` when nothing was configured anywhere, and absent when a product's record is missing. A product whose checks ran and passed is never hidden by a later product with nothing to run. A failed check produces `repair.returned` (`repairKind: checks`, the causing node, the allowance used) or a `coordinator.request` when the allowance is exhausted; no testing or review starts on failed checks.
- **A repair or later round starts.** `seat.started` says whether the participant's conversation continued (`mode: continued`, `builderConversation: resumed`) or why a fresh one was needed. Its manifest names the current findings, answers, objections and decisions it received and marks unchanged background as `reference` or `omitted`; `refs.input` reads the exact text, and finding events link complete diagnostics.
- **A review finishes.** `review.finished` counts **all reports** in `opening`, `closing` and `raised`, including settled reports. `reportCounts.opening` and `reportCounts.closing` give status totals and split open reports into Important findings, nits and pre-existing follow-ups. `openImportant`, `openNits` and `openPreExisting` list those populations; the compatibility `stillOpen` list remains Important-only, explicitly labelled by `stillOpenPopulation: open-important`. The event also gives `fixed`, `claimedFixed`, `reopened` (with whether current evidence exists), `dismissed` and `unverified` changes. These lists can overlap. All lists, including compact `reports` with descriptions, severity, status, products, follow-up references and saved-evidence reads, are bounded to 20 initially and may shorten further to fit event/batch limits; descriptions prioritize open work and shorten before identity lists; `totals`, `shortenedFields` and `refs.details` expose the rest. `since` says whether the baseline is the node's start or the engine's start. `claimedFixed` lists the Builder's fix claims this review examined: every claim made since the last completed review, including ordinary findings the Builder's claim already marked fixed before the review started. Only a review step whose every seat handed back an accepted result is a completed examination and gets a `review.finished`; the words that ended the step decide nothing. A review that got stuck, was stopped by cancelling the task, handed its work on to a replacement, was restarted after your own changes or was closed by a later recovery before its seats reported examined nothing: its `node.finished` carries `review.examined: false` with `acceptedResults` out of `seats`, lists any seat results it did hold under `refs.results` as that seat's evidence alone, and the next actual review keeps those claims under test. Seats are positions the engine records on the step as its participants are admitted: the review's `node.started` lists them under `seats` (`reviewer:0`, `reviewer:1`, or `verifier:<place>` for a vote, named by its original planned profile; a targeted third answer is its own step with `verifier:third:<profile>` seats), while `team` names only the profiles that actually started. A replacement's input is another attempt on the seat it replaced, also when the replaced participant never received instructions, and a planned seat whose participant never started (still waiting for usage or a slot) is a seat without a result, so a review stopped in that state reports one of two accepted results and no completed review. A completed review's `node.finished` says `review.examined: true` and its `review.finished` follows. The review's evidence is the other lists: a claim the review left standing appears in `fixed`; a reproduced claim appears in `reopened` and, while open, in its matching `openImportant`, `openNits` or `openPreExisting` list. `stillOpen` is the Important-only compatibility list. Shared and check-failure claims can remain open awaiting their required confirmation. Reopened findings keep their earlier support as history. `journey finding` reads the copy saved by that review; use `task read --section findings --finding-id FINDING` for the current reproduction and status. `refs.results` on the review's completion names each seat's result and how many finding copies it left, `refs.inputs` selects their exact saved instructions, `refs.currentRequests` selects the task's current inbox list (which may be empty), and the review node and each participant’s input retain the immutable `reviewInput` reference after the round ends. Follow `refs.reviewInput` with `journey review-input --task-id TASK --node-id NODE --section versions` for recorded code versions, `--section findings` for the supplied baseline, or the default snapshot for the prepared comparisons and their identities. Read every continuation page. Missing or changed files stay unavailable; current evidence never replaces them.
- **A profile is replaced.** `profile.replaced` names the previous participant, the recorded limit or failure reason when one was recorded, and the actual replacement on the same seat. Lone-agent replacements can start a new journey node; `previousNodeId` and `refs.previousInput` identify the actual previous participant, including successive replacements. The replaced seat's inputs and finding copies stay as recorded.

### Publishing results

`publishing.result` reports one product's recorded result through Petrina's existing delivery, landing and history rules, plus the task's `landing` and, for shared tasks, the `shared` state. Landed kinds are `released`, `committed` (a recorded branch landing; `pushed: true` records a confirmed push, while older or local-only records can lack push confirmation) and `merged`. Not landed: `pull-request-open` (awaiting merge), `local-unpushed` (advanced locally, push unfinished), `publishing` (in progress), `pull-request-closed` (closed without merging; `decision: needed` on a shared task until you resolve it, `none` on a single-product task, which finishes as closed), `interrupted` (shipping stopped; your decision is needed; on a shared task it applies only to the product the shipping question names, so a closed pull request on one product leaves the others at `pending` or `publishing`), `unconfirmed` (marked done without a confirmed delivery, retaining that fact alongside any later `lookup` with the observed pull-request number, address and state, even when that lookup reports a merge), `unknown` (saved by an older Petrina; check GitHub) and `pending`. `no-changes` is its own result. Petrina's general delivered marker never counts as publication. A shared task reports `landed` only when every publishing product has landed; until then `shared` is `waiting` (merge), `unfinished` or `decision`. `task.finished` repeats the final per-product list, names the task a combined backlog card went into, and lists what a cancelled task had already published; a still-open pull request's later merge or close remains observable.

### A long step

`task health` reads recorded facts about the current step: observation time, the recorded working duration, elapsed time since the step started, the last observed activity, running tool and to-do item per seat, the waiting reason, and Petrina's existing estimate only when its shared rule supports one (the last ten finished steps of the same role and pass, at least three samples), labelled as an estimate. Silence alone does not prove a stuck step, and this read never retries, cancels or replaces work.

## A complete coordination example

```sh
petrina engine status
petrina product list
petrina watch events --product-id PRODUCT --timeout-ms 0 --json   # keep the cursor as CURSOR before acting
petrina task add --product-id PRODUCT --title 'Make invitations clearer' \
  --approve-plan --delivery pull-request --approve-delivery --request-id invite-1 --json
# Keep the returned taskId as TASK.
petrina task inspect TASK
petrina watch events --task-ids '["TASK"]' --cursor CURSOR --timeout-ms 60000 --json   # or: watch wait --condition decision
petrina watch wait --target task --task-id TASK --condition decision
petrina inbox list --task-id TASK
petrina inbox inspect REQUEST --json
# Read every shortened inspection page. Fetch only warranted diagnostics through its focused links.
# Copy the inspected revision.
petrina inbox approve REQUEST --revision REVISION --request-id invite-plan-1
petrina journey list --task-id TASK
petrina journey node --task-id TASK --node-id NODE
petrina task message TASK --text 'Keep the wording short' --request-id invite-note-1
petrina watch wait --target task --task-id TASK --condition decision
# Inspect and answer questions, permissions and later design/delivery checks in the same way.
petrina learning inspect OFFER --json
petrina learning accept OFFER --revision REVISION --positions '[0]' --request-id invite-learning-1
# Or: learning decline OFFER --revision REVISION --request-id invite-decline-1
petrina engine pause --wait --request-id pause-1
petrina engine resume --request-id resume-1
```

The MCP sequence uses the corresponding named tools with the same fields: create, inspect/wait, inspect the inbox request, return its revision with the decision, read journey evidence, accept selected lessons, then pause/resume. A coding agent can discover each next operation from tool descriptions and the inspected request's available decisions.

Exit codes are `0` for completed or accepted/pending, `1` for failure/disconnection, `2` for invalid arguments or unavailable action, `3` for a deadline, `4` for missing/already-handled/unavailable evidence, and `5` for changed content, conflicting references, superseded waits or lost continuity. Read `outcome` in JSON/MCP results to distinguish accepted from completed.
