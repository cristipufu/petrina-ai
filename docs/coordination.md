# Coordinate Petrina from a terminal or coding agent

The CLI and MCP server operate the same local engine as the desktop app. They coordinate products, tasks, checkpoints and the agent pool. Editing source, Git operations, development tests and repairing Petrina stay with ordinary coding tools. Petrina never merges a pull request.

## Install and discover

From a source checkout, install its locked dependencies with `bun install --frozen-lockfile`. Use `bun run petrina` in that checkout. To install the terminal command for your user, run `bun link` in `packages/engine`, then use `petrina` from your terminal. Bun must be on your PATH. The desktop package's engine is not a separately installed CLI yet.

```sh
bun run petrina --help
bun run petrina task --help
bun run petrina task add --help
bun run petrina engine status
bun run petrina task list --states '["needs-you","failed"]' --json
```

Help comes from the same operation catalogue as the MCP tool descriptions and argument schemas. Groups are `engine`, `task`, `inbox`, `learning`, `review-guide`, `product`, `plan`, `journey`, `pool`, `tools`, `screen`, `analytics` and `watch`. Options use names such as `--task-id`. An inspect command also accepts its identifier immediately after the operation. Arrays and objects take JSON; boolean flags accept `true` or `false`. Output uses plain language unless `--json` is present.

Existing `state`, `do`, `serve` and `open` invocations remain available. `state` returns the current board snapshot with compact history totals; use the focused commands for ordinary coordination. Agents should use the named operations, which add revisions and durable receipts, rather than the older generic `do` command.

Structured options show their JSON shape and a valid example derived from the operation schema. For example, `--start-from '{"kind":"branch","name":"main"}'` selects a branch. Malformed or invalid values name their option and expected shape before any request reaches the engine.

`task list` reads current work, including backlog. `task history` reads finished and cancelled work newest first in pages of 25 (maximum 100), without loading its conversations or plans. History search matches title word prefixes, as in the app. A finished-only `task list --states '["done"]'` also reads history; current and finished state filters must be read separately. Changed history invalidates continuation references. Inspect any returned task ID with `task inspect`, then read its plan, journey or evidence separately.

To review a request before agents start, use `task add --backlog --title "Review this request"`, then `task update-backlog TASK --title "Reviewed request" --description "Clear requirements"` and `task queue TASK`. Queueing is explicit. An unstarted queued task can return to review with `task backlog TASK`. These operations have matching typed MCP tools and durable request references.

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

A drain includes agent processes, check runs, deliveries and necessary cleanup. Status separates work still finishing, questions and permission/screen blockers, queued tasks, saved checkpoints and pending review participants. A partially started review does not pass simply because its admitted peers finished. Their results stay saved; resume runs the missing participants.

Stop and restart keep draining until admitted work settles. They have no forced deadline. A caller's `--timeout-ms` ends only its wait, with a `timed-out` result; the lifecycle operation continues. Resolve named blockers or explicitly interrupt/cancel the relevant task if that is the decision you want. A coordinating agent waiting for its own slot to drain must release that work first.

Restart closes the old engine, releases the folder's existing ownership lock and launches one replacement through the existing launcher. The replacement preserves the connection key and port, saved task state, completed peers, queued messages and supported conversations. Paused scheduling stays paused until an explicit resume; running scheduling continues once the replacement is ready. Desktop recovery steps aside for the existing owner, respects an intentional stop, and does not interrupt a handoff. Closing the desktop during an explicit restart leaves the requested replacement running in the background. A replacement runs independently of the original desktop child; stop it explicitly when finished.

Start discovers an existing owner. An owner that does not answer is `unresponsive`; silence never authorizes a second engine. Startup failures remain visible in status and the local engine log. Repair the cause through ordinary coding tools, then explicitly start again using a new request reference. A restart of a confirmed stopped engine starts once. Another restart while one is unfinished follows that operation; a competing lifecycle change returns a conflict identifying the operation already under way.

If the app closes during an unfinished pool pause, opening the app or explicitly starting the engine restores it with the saved paused preference. A status or resume request may first record that pause as interrupted; this does not block desktop recovery. Failed pause receipts stay available, and a recovery start has its own receipt. Resume explicitly when ready to schedule again.

## Safe retries and decisions

Every change requires a request reference. MCP callers supply `requestId`. CLI callers can pass `--request-id`, or the CLI prints a generated reference to stderr **before** submitting the request. Keep that reference if the reply is lost. Repeating identical arguments returns the saved outcome and task/message references; changing the operation or its arguments under that reference is a conflict. Wait flags and wait deadlines can change without changing the lifecycle effect.

A disconnected lifecycle request may still be queued behind an app action. Until the engine applies it and saves its receipt, the caller reports that acceptance is unknown. Retry the original reference: recovery never reserves a scheduling or shutdown change on the live engine's behalf.

Task receipts last with the saved task data; lifecycle receipts survive engine replacement. Synchronous decisions and their receipts save in the same transaction as the task state. Asynchronous source validation and stuck-item retries first save a pending submission. If the engine is interrupted before their final outcome is recorded, retry returns that pending submission; inspect the task before issuing a fresh request. There is no blind repeat of an uncertain effect.

A rejected starting-point change returns `invalid` and its saved validation explanation. The previous approved source stays in place, and the plan request stays open. Correct the choice with a new request reference; repeating the old reference returns its original rejection.

Inspect an inbox request before deciding. The result provides its `revision`, available decisions and the full recorded request/evidence through bounded pages. Return that revision with the decision. Plan revisions include the starting point, destination, full stages and assigned profiles. Changed content leaves the request open and asks for a fresh inspection. Clocks and unrelated activity do not invalidate it. A successfully retried decision returns its original receipt even after its request closes.

`inbox approve` handles only plan, design, delivery and disagreement checkpoints. Questions use `inbox answer`; tool requests use `inbox allow` (once only) or `inbox deny`; stuck items use `inbox retry`; interrupted deliveries use `inbox recovery` with `check`, `ship-again` or `mark-done`. Marking done leaves delivery visibly unconfirmed. Existing delivery checks remain authoritative.

Learning offers use `learning inspect`, `learning accept --positions '[0,2]'`, or `learning decline`. Positions start at **zero**; acceptance needs a nonempty valid selection from the inspected revision. Unselected lessons follow existing decline behavior. Review-guide proposals have their own inspect, accept and decline operations. Accepted points follow existing delivery timing; the interface does not edit product files directly.

## Focused evidence and waits

Lists filter inside the engine before pagination. The default is 25 items, capped at 100. Task inspection gives the current summary, workers, next step, waiting reason, inbox references and delivery confirmation. Plans, conversations, findings and individual journey nodes are separate evidence reads. Evidence defaults to 8,000 characters per page, capped at 32,000. Diagnostic files use byte offsets and preserve UTF-8 boundaries. A `next` value is passed back as `--cursor`. `shortened` explicitly identifies unfinished text reads. Changed evidence or list contents invalidate their continuation and require a fresh focused read.

Journey nodes distinguish recorded, planned and older reconstructed evidence. Accepted agent results keep their original response and separate references to any saved pictures; picture bytes remain available only while the task is unfinished. Missing inputs/results stay unavailable. Each newly recorded check keeps its original diagnostic link in the journey, so later checks and restarts do not replace its log. `journey check --task-id TASK --node-id NODE --index 0` starts at the beginning of that original log. Without a node it reads the latest task check. Results separately describe command outcome, historical or recorded-version relevance, and complete/incomplete/legacy/missing diagnostic evidence. An old excerpt or missing log does not establish a current pass.

Diagnostics also include a bounded `savedResult`, covering failure to start, deadlines and cleanup warnings saved outside process output. Continue its `next` cursor with `journey check --section result`; the ordinary diagnostic cursor continues the process log. When a log is empty but a saved explanation exists, the main text shows that explanation and labels its source. An empty successful log still means a quiet check, with its recorded pass and completeness reported separately.

Full-log reads require the file identity Petrina recorded when it created the log, as well as a regular file with a single directory entry in the task's check folder. A symbolic shortcut, substituted file or unavailable file falls back to the saved excerpt. Older records without creation identity also return their saved excerpt, labelled unverified or incomplete; the check's own result and retained file are unchanged. A changed continuation asks for a fresh read without returning a replacement page.

```sh
petrina watch wait --target task --task-id TASK --condition decision --timeout-ms 60000
petrina watch wait --target task --task-id TASK --condition state --states '["failed","cancelled"]'
petrina watch wait --target inbox --kinds '["question","permission"]' --condition decision
petrina watch wait --target pool --condition drained
```

A wait returns compact matching summaries and a `marker`. For changes, return that marker on the next wait so changes since the previous response are included. Already satisfied conditions return immediately. A different engine boot reports `continuity-lost` and supplies a fresh focused result. Disconnection and quiet deadlines are distinct results. Ending a watch never cancels work. `delivered` includes awaiting merge and confirmed landing; `landed` requires recorded landing. Cancelled, closed and marked-done/unconfirmed deliveries do not satisfy either condition.

## A complete coordination example

```sh
petrina engine status
petrina product list
petrina task add --product-id PRODUCT --title 'Make invitations clearer' \
  --approve-plan --delivery pull-request --approve-delivery --request-id invite-1 --json
# Keep the returned taskId as TASK.
petrina task inspect TASK
petrina watch wait --target task --task-id TASK --condition decision
petrina inbox list --task-id TASK
petrina inbox inspect REQUEST --json
# Read every continuation page when evidence is shortened. Copy the inspected revision.
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
