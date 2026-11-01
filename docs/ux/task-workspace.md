# Task workspace and new requests

Owns task and node details, live conversations, controls and New task. Back to [UX overview](../ux.md).

## Task sheet

### Workspace header

A compact persistent title with the product and state, Back, the pull request link when there is one, Message, Pause or Resume, a More menu (Allow the screen for this task, Move to top, Hold, Cancel) and Close. A task waiting for the screen reads "Waiting for the screen", and "Right now" shows the agent's reason with Allow now. While the task's own screen allowance is on, the header says "Screen allowed for this task" in quiet text.

Below it, Tasks, Task flow and the details tabs share one 56px header row with aligned borders. The three columns scroll independently. The task list separates rows with quiet rules and shows an icon and words for Working, Waiting, Queued and other states; Working has a spinner unless reduced motion is on.

### Task tabs

#### Overview

Anything waiting for you, what you asked for, who is on it right now (role, tool, model and effort in words), and the timeline: one row per event with its time aligned on the left, and a clear break at each stage change. **Right now** puts the current to-do item first, with the time worked on this step. The latest action sits below in quiet small text, left out if it repeats the first line. While the agent waits for your answer or permission, the first line says what it waits for and the second keeps the to-do item it was on. While its tool reconnects or retries by itself, the first line says so and the stale action and to-do item are left out; the live step in the flow says the same. Time waiting for you does not count. Next is always shown in full below, when a step follows.

While Petrina's automated checks are the current work, the heading reads **Automated checks**, never "Between stages". The first line is the card's line ("Waiting for checks · 2 runs ahead"). Below it, quietly: the place kept through a pool pause ("Keeps its place · 1 run ahead"), each cleanup hold in the words its recorded explanation uses ("Checks are held until Petrina confirms extra validation “Linux suite” for “Platform work” has stopped.", then that explanation; after a restart, "Checks are held while Petrina confirms an earlier validation stopped"), who holds the running place ("Tests for “Fix login retry” is running", or "Running now: Tests for “A”; Lint for “B”"), each task linked so it opens, and the note that checks have their own line, separate from agent slots, with how many check runs Petrina allows at once when that is more than one. Programs are called Petrina's own only when the cleanup explanation verified them. Runs are counted whole: a run of four commands, or one extra validation, is one run; test workers are never counted. There is no time estimate or start time. These facts refresh only when the line itself changes: a run joins, is admitted, ends, is paused or cancelled, leaves for prerequisites, is held or released for cleanup, the pool pauses or resumes, or Petrina restarts.

#### Plan

Why this plan, then the stages as a spacious numbered list. Stages that have not started can change tool or model, and a review can gain a reviewer. "Re-plan" sends a note to the planner.

#### Design

The brief in one reading column (what changes for users, which parts of the product, the acceptance checklist, risks), then the disagreements. Design and Overview label acceptance evidence “Last recorded result”. After code changes, or when freshness cannot be established, they say “Current version not verified”; both old passes and old failures remain historical. Matching recorded versions retain applicable verification for each item’s affected products. Before testing starts, items say “Not tested yet”; running testing says “in progress”. Missing saved history remains unavailable. A mix of current and unverified items says “Current version partly verified”. Completion and a Builder's fix claim never establish acceptance. Acceptance items that could not be checked say so with the reason; they stay unchecked and require the coordinator's decision before delivery. Each disagreement separates the issue, its status, who raised it and the architect's answer, with open blockers first. Objections your call settled carry a "Your call" tag, your words, and the architect's note on how the brief follows them.

#### Review

The tamper check, then the findings: open blockers first, each with its status, who raised it and who confirmed it.

Checked findings name the recorded outcome: must be fixed in this change, a real problem already there before this change, a real but minor problem, or not a bug. Counts name each verdict and the actual number of independent tools that voted. Split judgments also say how many tools affirm the problem is real; older and minor problems count as real problems. Missing votes never imply agreement. Each current tool's verdict and reason can be opened beneath the finding; earlier reviews retain verdicts beside their reasons. Outcomes and counts from before a reported fix keep that label.

A completed review round displays its saved settled decisions, with dismissals under Not a bug and closed fixes under Fixed. Its evidence includes shared fixes and unmentioned Builder fix claims. Individual reviewer reports remain evidence from before the round's decision. Older unmarked copies say they are hand-back copies without a saved settled decision. Later reviews never change an earlier round's display. Vote boxes and timeline entries count recorded outcome categories, including older and minor problems, rather than only counting “real”. A finding with unfinished verification shows the actual number of tools that answered and why it remains Important, including the saved reason when a required answer was unavailable.

#### Session

Join the agent that is working right now (below).

### Reading layout

Prose (the plan's reasoning, the brief, the conversation and questions) sits in a reading column about 620px wide, roughly 60 to 70 characters a line. The timeline and the reviews use the full width.

### Next steps

Next, in Overview under Right now, appears for working tasks, tasks that need you, waiting tasks and paused tasks when a step follows. It names up to two steps and who does each (tool and model); a review is one step naming all its reviewers, who look at once, and checkpoints say "your plan check", "your design check" and "your OK to ship".

Delivery says what Petrina does itself: "Petrina opens the pull request", "Petrina commits to main", or for a release, the Release Manager's notes and then "Petrina publishes the release". A step with an alternative is shown on its own: "or another design round if the reviewer objects", "or your call if they still disagree", or "or fixes by the builder if blocking issues are found".

It follows the current plan, finding-based convergence limits and edits, naming an unresolved review decision “your call”, leaving out reviewers who have already reported and skipping earlier design checks on the way back to the one where you asked for changes. While the Check finder or the Guide keeper prepares a step, or Petrina's automated checks prepare, wait or run before it, Next still names that step: "Next: security review (Claude Code · Opus 5.5), then your OK to ship". Once its agent starts, Next moves on as usual. Acceptance testing already owed after a repair comes before final requested proof; Next keeps the remaining reviews visible when that repair test returns to the plan. When a reviewer has asked for proof that is still pending, Next names "final acceptance testing for requested proof" even after an earlier result that could not be verified, as the engine runs it; without a new request, or once the main-only refresh limit applies to the current checked version, it names the delivery decision. Changes to the task's own code can still require requested-proof testing after that count is reached. The preview uses the recorded checked patches or a still-current limited decision; the count alone never proves that the limit applies. If preparation has not yet recorded which code changed after two refreshes, the requested-proof test stays conditional on the task's code changing. Before delivery it includes final acceptance testing when required, or says “if the code changed” while final patch equivalence is still unknown. It never presents blocked acceptance as another automatic test. The full sentence wraps in place, with no popup. Queued, stuck and finished tasks have no Next line.

### Remaining time

Only Right now shows a rough time left, and only while an agent works. It needs at least three finished steps of the same role and pass (first pass or repeat), anywhere in Petrina. The typical time of the last ten such steps, less the time already worked, becomes "A few minutes left", "About 15 minutes left", "About an hour left" or "About 2 hours left". Past that typical time it says "Taking longer than usual". With too little history, it shows nothing. Steps started again after a restart, a pause or Try again do not enter that history.

## Journey

### Review results

Completed code and security reviews show the findings fixed, reopened and newly raised in that round, with counts and the individual reports grouped below. Fixed means an earlier Builder fix stayed closed through this review; a Builder's handoff alone is a claim, not an independent review. Earlier findings that simply remain open and findings dismissed as not a bug have their own groups when present. Each result uses that round's recorded evidence, so later reviews do not rewrite it.

The canvas total includes new and reopened unresolved findings, matching the handoff to verification. Older incomplete records say when the fixed count was not recorded.

### Three-column workspace

The middle column always shows the task's complete chronological journey: the steps it actually went through, in order, then the steps its plan still has ahead. There is one canvas view, with no grouped overview. A quiet dotted background supports navigation without changing the task and node colours. The wider right panel initially shows the task's Overview; Plan, Design, Review and Session remain accessible there.

### Live automated checks

Automated checks show every check in that run, with pending, running and completed results, and elapsed time for checks that have started. A run that has not started yet says "Waiting in the check line since 10:42 · 2 runs ahead" (or "held for cleanup", or that it keeps its place while the pool is paused) instead of a start time. A short "Why these checks run" line gives the reason recorded when the saved run was found not to cover the current code: "Before your delivery check: the code changed since the passing run in step 28 (main moved on)", the check commands or hook inputs changed, the commit hooks must run again on unchanged code, the earlier run did not finish, you asked for a fresh run, or there was no earlier run. "Main moved on" appears only when both runs recorded their starting point. It is never inferred from the step that ended before, and the earlier passing run stays as history. Product commands run serially, with type checks and lint first; a static failure leaves later commands and hooks skipped, with no passing result implied. The task’s status names the checks currently running. When a step contains repeated preparations, its latest attempt shows its own count, outcome, product and recorded timing. Earlier attempts are separate disclosures, collapsed by default, retaining stopped results and original diagnostics.

Review shows the latest recorded **Local setup** observation and whether it needs fresh verification. Automated Checks details show only observations recorded for the selected step, never the task’s newer observation. Both identify the owning product, before- or after-checks position and actual recorded time. Earlier observations are collapsed by default, with useful diagnostics available separately. Missing evidence stays unavailable; these records describe past observations, not the current machine’s live readiness.

Each attempt keeps its original start date, time and overall elapsed duration. The step outcome follows the latest attempt, including any reused results in it. A mixed outcome states both the failures and the unverified checks. A stopped check without recorded machine evidence says “Stopped — verification incomplete”; confirmed machine interruption says “Interrupted — verification incomplete” and shows its supporting event.

Check totals and individual result labels use the same recorded execution facts. Missing execution details stay unverified, even when the original report said passed; the original report and diagnostic remain separately visible. A command that could not start or whose exit or cleanup is uncertain is distinct from a completed failure. Pending and running rows retain their own current timing and status when an earlier result is still attached.

### Release notes

Pausing or restarting unfinished release notes keeps the same Release Manager box. Preparation checks still run again before the agent continues, with their results in that step's timeline. The box gets its completion check only after the notes are ready; failed checks interrupt it and say why.

### Agent steps

Each agent step is a box with its role (icon and colour), tool and model, elapsed time and outcome, and a check once finished. Times are elapsed from the step's start to its end, pauses and waiting included, and say so. Every round, send-back and retry is a new box. Its footer uses small round squares and symbols for a fix, retry, update, call or port review; titles keep the plain role or work name.

Reviewers working together share a box for that round, naming all their tools and models in its details; fresh voters have their own box. Automated checks, Update branch and Publish delivery describe Petrina's own steps by what they do. An Update branch box that kept both sides' approved learnings says so and is not a send-back; any other conflict sends the work back to the Builder. Only a release has a Release Manager, who writes its notes before Petrina publishes. A stuck step is red; a step stopped by cancelling says so.

### Coordinator steps

Anything that waits for you is a capsule with your icon: your plan, design and delivery checks, your call on a disagreement, a stuck task and interrupted shipping. It is amber while it waits and afterwards shows how long it waited and what you decided. Questions and permission requests hang under the box that asked, with your answer once given.

Checking again for an interrupted delivery is Petrina's own look on GitHub, not an agent's work, so it adds no agent box; if it still cannot confirm the delivery, a new capsule asks you again. Waiting for other tasks to land is a step of its own, naming them, and it ends when they do, even while the task is on hold.

It ends saying what happened to them: "“Guest checkout” landed", or honestly when one did not ("did not land: cancelled", "did not land: closed without merging", "marked as done, delivery not confirmed").

A selected step’s Overview includes Usage: its saved token total and any reported New input, Output, Reused from cache and Written to cache, using Analytics number wording. Several agents or starts show one line per actual seat and start, with the tool and confirmed model. Seats keep their recorded positions regardless of which agent reports first. With no token report, Usage explains whether it is still waiting or the tool did not report one. A pending turn does not make a previous complete breakdown incomplete; missing older work and omitted report parts carry their own explanations. Missing reports stay missing, partial figures say `>`, and steps with no agent work show no token figure. Usage updates as turn reports are saved and remains available in History. Selecting another step or task clears the previous selection’s figures immediately.


### Transitions and activity

Arrows say in a few words why the work moved on ("2 blocking objections", "sent back: 3 important", "you approved", "your call"). Send-backs and changes are amber, stuck is red. The live box is highlighted with its status line and running time, its border pulses subtly while work runs, and the arrow into it moves; a paused task or one waiting for a slot says so on its box, without the moving arrow.

### Planned steps and endings

Steps still ahead are faint dashed boxes naming the planned role, tool and model; the first says Next. While the planner works, the faint part says the planner will choose the rest. A start point ("Started 2h ago", "#3 in the queue", "On hold") and an end point ("Pull request #237 · awaiting merge", "Released v1.4.0", "Cancelled") mark the ends. Unusual endings say what they are: "Pull request #237 closed without merging" and "Marked as done · delivery not confirmed" never read as delivered or awaiting merge, here or on the card.

### Canvas navigation

Boxes run left to right across the canvas and wrap onto new rows like text; the arrow from the end of a row runs back under it. The view fits the panel on open (a long journey opens at readable size on its live step, or its end) and follows the live step. Choosing a step to read, by click or keyboard, the live one included, stops following, so a handoff never moves the diagram away while you read; Back to now resumes it.

The scroll wheel pans the canvas independently of the task list and details; dragging the background pans; pinch, or ⌘/Ctrl with the wheel, zooms. Zoom in, zoom out and Show the whole journey are small buttons; Back to now appears once you move away.

### Node details

Clicking a box switches the right panel to that step: tool, model and effort, start, elapsed time, outcome, why it moved on, what it asked you, its part of the timeline and its conversation inline. Overview also shows that step’s findings, design objections or answers to objections, recorded at handoff so later rounds cannot rewrite them. Older details use available linked records and label their latest status.

Plan assignments offer a collapsed “Why this agent” explanation. Node Overview gives the handoff reason a small highlighted block, uses labelled icons for the summary facts and outcomes, and keeps “Agent choice” as a compact unboxed disclosure for the original assignment, requested and selected profiles, the engine's selection reason and the tool's settings confirmed at startup. This information is recorded for the coordinator and stays outside the input given to the agent. A coordinator edit is labelled as their choice; an older missing explanation is not invented.

The input disclosure is a separate document card, with a Fresh conversation or Continued conversation label and a visible expand control. It shows the job instructions and context actually sent at that start, with later answers, messages, result corrections and interruption continuations below them. A repeated start keeps the earlier input. Instructions are captured when sent, so later role edits or task changes cannot rewrite that history; an older missing job is labelled as unrecorded.

Finding details keep the finding and its recorded review evidence together; the builder’s full messages belong in Conversation instead of a repeated metadata block. Every active agent node has a fixed footer on all three tabs: a message section collapsed by default, with the field above Send now/Wait/Stop and send and Send when opened, then a separate terminal takeover row. Collapsing keeps a draft; the Message shortcut opens and focuses it. Finished nodes have no live controls.

When live message delivery cannot be confirmed, the Inbox names that uncertainty and shows the message. Continue without sending again lets the step proceed while retaining the uncertainty; Send again explicitly authorizes another copy. These choices survive restart and apply only to the affected agent. Journey records a decision to continue as Continued without confirmed delivery, never Heard.

Agent actions expand in place, collapsed by default. Clicking the same step again, the blank canvas, or Back to task returns to the previous task tab and reading position. Typed answers, messages and notes stay intact. Faint steps say what is planned and link to the Plan tab.

### Accessible navigation

Screen readers and keyboard users get the same steps as an ordered list, one tab stop, moved through with the arrow keys; the matching box shows the focus ring and Enter opens its details. With reduced motion nothing moves.

### Earlier task records

Tasks that ran before journeys were recorded show one box per finished plan stage, then the step under way with any question it waits on. The details state when exact timing or conversation was not saved, and an older profile is labelled as planned: who actually ran it is not confirmed. No banner interrupts the canvas.

## Session: join an agent

This is the "open in terminal" experience, made friendly.

- A chat transcript of the task. Every message names its speaker, including You, keeps its paragraphs, and sits on a quiet background on both sides. Public progress messages arrive live in separate bubbles using the harness’s message ids; private reasoning is not shown. Token chunks update one bubble in batches, rather than adding a row per token. Tool activity is grouped into lists collapsed by default, with distinct repeated calls counted separately and streamed descriptions updated in place. Command text stays in coordination diagnostics. The live status leaves a finished tool for “Continuing work”, while its last description remains in activity history. Lists show their action count between messages ("Ran the tests: 42 passed", "Edited 3 files in Checkout").
- Screenshot links in agent messages show an inline preview and open a larger image in place. Thumbnails load only as they enter view, and image memory is released when they leave it. The image is read from the task’s working copy only when needed; Petrina does not copy or retain it after the task finishes and that working copy is removed. Older messages then say the preview is no longer available.
- Session and node conversations render Markdown paragraphs, headings, emphasis, lists, read-only task checkboxes, quotations, tables and web links. Streamed edits stay in their original message. Screenshots retain the same inline preview; formatting adds no code viewer or remote image downloads.
- Long public updates keep a short preview and offer **Read full message** in Session and the selected step's conversation. Expansion loads saved text in bounded pages, with loading, failure and retry states; **Show less** releases it, as does leaving the conversation. Reading controls retain keyboard focus while loading and ignore repeat activation; refreshing returns focus to **Show less** only if the reader has stayed on the refresh control. Expanded paragraphs and formatting stay intact. If a live message changes, **Read updated message** lets the reader choose when to refresh without moving their reading position. Missing endings explain the recording limit, interruption, storage failure or uncertainty in an older record; text merely hidden by a preview stays available to read.
- New messages only scroll the conversation when you are already at the bottom, so reading earlier messages is never interrupted.
- For Claude Code and Codex, the header shows **Sandboxed** or **Not sandboxed** next to the agent's status. Hovering (or focusing) it says what the tool's own sandbox covers, or why it is off. It is hidden while you drive in your terminal, which runs with your own setup. When Claude Code's sandbox can't start, the session also says so once: "Running without Claude Code's sandbox", with the reason.
- The composer offers three choices:
  - **Send now** (default): tries to reach every agent still working in the step through its tool’s live input. Claude Code, Codex and Grok support it; Antigravity says that guidance must wait until the turn finishes. The same step, work and personal tool settings remain in place.
  - **Wait**: holds the message until the current turn finishes.
  - **Stop and send**: explicitly stops the current turn, then sends waiting guidance in order.
- Each message shows Waiting, Accepted by the tool, or Heard. Parallel recipients retain separate delivery records. One agent hearing a message does not consume another’s copy. Remove is available only before any tool may have accepted it. A tool accepting input without confirming that the agent heard it leaves the message visible and the step open; Petrina says it will not send it again automatically. Messages stay inside the scrolling conversation, including the active step’s Conversation tab, and sending brings the new message into view. The board keeps its short activity line.

- Anything the task is waiting on (a question, a permission, a checkpoint) shows at the end of the conversation with the same wording and buttons as the inbox, so you can unblock without leaving the session. It scrolls with the conversation; the composer stays compact at the bottom.
- Earlier agents of the task (previous stages) can be read the same way.
- Chosen page captures sit beside their agent's report, fitted to the conversation width, with a plain-language caption below each picture. They remain after the agent leaves and after restarting Petrina while the task is unfinished. Like screenshot links, they load only near the viewport and enlarge in place; leaving view releases their image memory. Finishing or cancelling a task removes the pictures, while their captions stay with the report and explain that the preview is unavailable. Reports without pictures keep their usual appearance.

### Take over in terminal

The right sidebar’s fixed agent footer offers takeover: you drive the agent yourself, in your own terminal, with your own setup and logins. It is enabled while an agent other than the Release Manager is working or waiting on you, on Claude Code, Codex or Grok; otherwise it is off with a one-line reason (no agent right now, delivery runs on its own, still starting, tool not installed). The demo keeps a notice.

- After a quick OK, Petrina checks it can open a terminal. If it can't, the agent keeps working and the dialog offers to choose a terminal or to take over and copy a command to run yourself. The OK says what happens to the agent's unsaved work: saved for an editing role, undone for a role that only reads.
- Petrina then stops the agent cleanly and clears any question or permission request it had open. An editing role's unsaved work (the builder's, say) is saved as that agent's own commit, marked as unfinished; a read-only role's leftovers are undone, as always. If Petrina can't save that work, it says so and the agent carries on instead.
- The agent's own app (Claude Code, Codex or Grok) opens in a new terminal window, in the task's working copy, on the same conversation, with the same model and effort, so you can scroll up and see what it was doing. The app runs in its normal mode with its usual prompts. Some actions may run without a prompt, and you are in charge of the session: Petrina adds no blocks there, so whatever happens there happens for real, outside Petrina's agent protections and review.
- While you drive, the step is paused and keeps its seat in the pool. The task says "You're driving" and for how long on its card, in the Session tab, on the Agents page and as a Needs you item with **Hand back** and **Reopen terminal**. Pause, Cancel and Interrupt wait: hand back first. Messages you type in Petrina wait for the hand back. Only one terminal session per task runs at a time: Reopen terminal refuses while it is open and waits while it is opening, and a second copy of the copied command (even one started at the same moment) says the app is already open and stops.
- **Hand back** works once you have closed the app in your terminal: Petrina says so if it is still open, and offers "Hand back anyway", with a warning, only when it can't tell (for a moment after Reopen terminal, until the app reports it started). It waits while Petrina is opening the terminal again. It also refuses while the working copy is off the task's branch or in the middle of a merge or rebase. It shows what you changed (files and commits), apart from the agent's saved unfinished work, with an optional note.
- Anything you left unsaved becomes one commit marked as yours, never undone, even after driving a read-only role. A short note of what changed goes into the session, the timeline and the notes every later agent reads. The same agent then carries on with the same step on the same conversation; when its tool can't reopen it, it carries on in a fresh one with its usual instructions plus your note, and the Session tab says so.
- If you changed files, the tests check runs at once and its problems become blocking findings. If review is still ahead, it covers your changes. If review was underway or done, the review starts again from the first reviewer once the step you drove finishes, before anything ships, without using up a review round.
- You choose the terminal in Agents, under Your terminal: Terminal on macOS by default (iTerm2 and other installed ones selectable), Windows Terminal or else a PowerShell window on Windows, and on Linux the system default, then the desktop's own, then common ones.

### Builder returns and saved checks

A repair return describes its own observed code changes. “No code changes; checks still failing” appears on the unchanged Builder step and its outgoing transition; fixes on a changed return are labelled as Builder claims. The investigation and original answers remain on that turn. Environment explanations are attributed to the Builder, with independent interruption evidence shown separately.

A selectable “Previous checks reused” handoff follows a return when Petrina uses saved evidence. It states the outcome without implying a new check execution, duration or attempt. Its details identify each product, original check, execution time, recorded duration and diagnostic, with a link to the original step and attempt. Reuse time is shown separately. Older missing information says unavailable.

Reading those results again at review, approval or publishing adds no handoff. In shared repairs, each product's latest Builder return has its own evidence handoff, even when another product's return or fresh checks intervene. A fresh attempt owns its skipped checks; an earlier reuse time never carries over to it. Mixed attempts label fresh and reused evidence separately. Outdated results say they need updating, with earlier failures or unverified checks labelled as earlier evidence. A recorded failure or interruption stays unresolved until new applicable evidence settles it; editing check definitions cannot restore a ship action. A changed Builder return makes no claim that those earlier checks ran on its new code, and its summary does not carry reuse from before that return. Finished task summaries retain the recorded delivery outcome.

The coordinator decision uses the same recorded failure and verification meanings as the task summary, scoped to products still to publish. The decision retains the supporting checks even after intervening work and explains where work stopped and why the coordinator is being asked. It says “Your call: checks still failing” or “Your call: checks unverified”, and offers “Run checks again”, “See original checks” and “Send back…” with a note. **Run checks again** requests new setup observations and configured checks on unchanged code, without granting delivery approval or resetting the repair allowance. Saving changed local requirements alone runs no check. For partially published tasks, this decision concerns only the products still to publish; earlier products’ recorded failures remain readable in history. Confirmed interruption says “Interrupted — verification incomplete”, alongside the original reported failures and recorded machine event; sleep overlap alone does not explain every failure or establish that the feature works.


## New task

The dialog has a clear header and close control, a scrolling form and a fixed action footer. The request comes first, then Products & delivery, Work & review, and When to start. Product choices are compact selectable items; each selected product has a disclosure showing its starting point and delivery summary, with the editable fields inside. Approval choices sit with review settings. Queue position appears only when adding directly to the queue. Backlog remains the default. The same structure wraps on narrow windows and enlarged text, using the app’s existing light and dark palette.

Each submitted request keeps its identity until confirmed. A lost reply or partially saved pasted batch offers Retry confirmation for those exact requests; already confirmed entries are not sent again. The form stays fixed until confirmation or cancellation. Add another clears the request, starts a new identity and returns focus to the title.

Products is a searchable multi-select dropdown. It opens on demand, preselects the current product and permits several products or none. Filtering keeps selections; Escape closes the dropdown before the dialog. Selected products remain visible below it, each with its own starting point and delivery choice. Section headings have the same space above and below their separators. Kind of work, queue position and Ask me before shipping are shared. Several products always require plan approval.

Works on retains coordinator choices omitted by the planner, identifies proposed changes and additions, and confirms a permanent folder before Petrina clones anything. The task sheet groups changes, evidence and deliveries by repository, with shared and unassigned results under Together. Partial delivery keeps confirmed links and offers a retry for unfinished work.

⌘N from anywhere.

### What do you want?

A title and a description in plain words.

### Product

Pick registered products, or let the planner propose them. A changed proposal requires confirmation in the existing plan check.

### Start from

Default branch, Branch (an exact name), or Pull request (number or GitHub link). A link must match the product's repository. The plan's editable Works on line shows the resolved source and exact destination, including a fork's working repository and branch. Invalid choices stay visible for correction. Releases use the default branch.

- Branch work keeps the selected delivery mode: open a PR into that branch, or commit onto it and push it. PR work updates the original PR. Cards and the task sheet retain “from PR #123” or “from release-2.x”; delivery records name where the work went. A local update whose push is unfinished says so.

### When to start

Add to backlog (default) for review first, or Queue for work. Queue placement is Bottom (default) or Top when queuing directly.

Start after other tasks land is optional for either destination. Its searchable checkbox picker shows each task’s title, products and current outcome, with a selected count, Clear all and Done. Live tasks can be found by title or product; finished work uses bounded History pages and title search with Show more. Selected tasks stay visible while searching, including unavailable choices that need removing or replacing. Tasks already waiting directly or indirectly on this one are disabled with the reason. Done closes the picker; creating the request or Save changes commits the choices.

Prerequisites mean waiting for delivery to land, such as a merged pull request or a published release; finishing an agent turn is not enough. Priority only orders ready tasks. Backlog remembers the list and timeline entry without a waiting step or a changed status line. Queueing opens the waiting-for-others step only while something blocks.

Overview links every saved prerequisite, with its outcome and whether it still blocks. Backlog and never-started queued tasks offer the same editor with Save changes and Cancel; card and sheet More menus offer Start after other tasks…. Opening the editor never holds work. Once work starts, the list is read-only; if work starts during editing, attempted choices remain visible with the reason they cannot be saved. A definite refusal keeps choices editable with a fix; an uncertain reply offers Retry confirmation for the same choices.

For a prerequisite discovered after work starts, Overview shows a separate read-only “Wait for other tasks to land” section next to the pre-start list. It shows the coordinator's reason, links to the awaited tasks with their current outcome, whether the hold is active or begins after the current work, and whether a coordinator decision is needed. Changes show their times, previous and new lists, reasons and request references; the record stays visible after release and in History. The journey's waiting box shows the reason, awaited tasks and their states, then says how the wait ended. Runtime waits are set, revised and cleared through the command line or MCP; the app adds no editing control.

Creation saves each request and its prerequisites together before scheduling. Retry confirmation reuses that request’s reference, including after an engine restart; pasted titles share the selection and partial-batch retries retain it. Add another keeps scheduling choices with a fresh request.

### How to run

**Planned workflow** (default) lets the Planner assemble the stages and reviewers, or uses a template. **Single agent** runs one chosen role and agent profile directly on a single product without planning, design or review: read-only roles finish with their report and no product changes, while roles that can change the product run automated checks and follow the product's delivery and **Ask me before shipping** choices when files change (or finish with no product changes when nothing changed).

### Plan

Auto (the planner decides) or a template, in Planned workflow.

### Ask me before starting

Off by default.

- Attachments: screenshots and links.
- "Add another" keeps the dialog open for brain dumps. Pasting a list creates one task per line.

Creation editors for tasks, combined requests, routines, roles and products share a right-hand panel with one heading, a scrolling form and a fixed action footer. Profile editors use the same surface. Close, Cancel, outside click and Escape all preserve a changed draft until discard is confirmed; an in-flight save blocks dismissal. Small confirmations remain centered over the editor. First-run forms stay inside their guided setup steps.
