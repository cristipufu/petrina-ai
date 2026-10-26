# Products, Agents, Analytics and preferences

Owns page placement, product editing, analytics presentation, Library and first run. Back to [UX overview](../ux.md).

## Many products

A coordinator may run twenty products or more, so nothing assumes a handful.

### Product switcher

(⌘P) in the top bar: a search field, then products grouped as *Needs you*, *Active* and *Quiet*, each saying in quiet text what waits on you, how many agents work and how many tasks are queued. The board keeps its full width.

### Products page

The portfolio on one screen. One row per product with its pipeline (queue, plan, design, build, review, ready), what shipped, and what waits on you, as aligned numbers rather than badges. Products that need you sort first; clicking one filters the board to it. In a small window the table scrolls sideways.

### Adding and editing products

#### Add a product

Has a folder path and a Name field below it. The folder suggests the name (`petrina-ai` becomes Petrina AI); common abbreviations AI, API, UI, UX, CLI and SDK stay in capitals, and words already containing capitals keep their spelling. Correct the name before adding. Both fields are required; adding an existing repository opens its product without renaming it.

#### Product settings

Each Products row's **Settings** button opens the shared side editor, with Name focused and the table left in place behind it. The same editor opens from its product-specific address. Its header and Save/Cancel footer stay fixed while grouped fields scroll. Escape or Cancel returns focus to that row's Settings button; unsaved changes ask before discarding.

- A product's settings show Name, the same three delivery choices as New task, **Ask me before shipping**, and **Remove product**. Name, delivery defaults, automated checks, local setup and removal are separate sections, with aligned controls and a fixed Save/Cancel footer. They contain no permission controls. Save applies name and delivery defaults together; Cancel or Escape asks before discarding unsaved edits. Automated checks and local setup save separately; unfinished edits to either must be saved or cancelled before saving the product defaults. Names are trimmed, one line, at most 60 characters, and unique ignoring capitals, enforced by the engine as well as in the demo. A rejected save changes nothing.
- **Automated checks** gives each check separate name and command fields, using the same row layout as Local setup. Add, remove, Save checks and Cancel retain the draft and report errors beside the relevant field. A line break belongs to its field rather than starting another check; saving preserves literal arguments, including quotes, backslashes and empty arguments. Saving declarations runs nothing. Find again restores check discovery. The demo uses the same setting transition; rejected saves leave both declarations and existing check applicability unchanged.
- **Local setup** accepts up to twelve named read-only requirements, each with a program and literal arguments. Rows can be added, edited or removed; invalid names and commands keep the draft and explain what needs fixing. **Save local setup** records the requirements without running them. Edits apply to unfinished work and require fresh verification; earlier observations and repair allowances remain. Saving and dismissal share the editor’s busy, dirty and discard behavior.
- Delivery choices apply to new tasks; tasks already on the board keep theirs. A saved name appears everywhere immediately and in the next agent's instructions. Running agents keep the instructions they already received. Working copies, branches and the GitHub repository keep their identities.
- Removal is unavailable until all tasks are done or cancelled, and says how many must finish or be cancelled first. An open pull request, failed task, paused task or queued task still counts as unfinished. The engine checks this again.
- Confirmation names the number of finished and cancelled tasks being permanently deleted, including their conversations, timelines, and design and review history, and says this cannot be undone. A separate line says: "Your repository, its local folder, its branches and GitHub are not touched." With no tasks, it says "This product has no task history." The confirm button names the loss: **Remove and delete 12 tasks**. Removal clears those tasks and their inbox entries, closes the product's settings, and returns a board filtered to that product to All products. Petrina's working copies remain on disk.
- While disconnected, Add product, Save and Remove are disabled and say they are waiting for the engine. The same settings and removal flow work on simulated products in the demo.

## Agents

Shows occupied slots, agent summaries and the queue. Tools and terminal preferences live here, without duplicate usage-limit or review-analytics panels.

### Tools on this machine

Claude Code, Codex, Grok and Antigravity use the same readiness states and fixes as first run. GitHub CLI names its signed-in account; Git and Node.js appear when missing or when their latest answer is Couldn't check; they stay hidden when Ready or before the first answer. Entering Tools checks once. Only Check again starts another page-driven check; focus and visibility changes never do. An uncertain result offers details without claiming the login has expired.

The installed-tools list uses locally bundled brand icons at a consistent size, alongside each tool's name and readiness status, without boxes around the icons. Icons remain recognizable in light and dark looks; readiness is always stated in words. First-run setup uses the same rows.

### Your terminal

Choose where Take over in terminal opens, using the machine’s usual terminal by default. If no terminal is available, the same launcher can be copied. Antigravity explains that its terminal cannot open the agent’s ACP conversation.

## Analytics

Antigravity's quota card names the provider's model group for each window, keeping its separate Argon allowance visible. A reported unused group reads 0% used; a missing or failed reading keeps its usual status and report age.

What the whole squad used and how it works, in plain words and simple charts. It follows the product switcher (all products, or one), staying open with the chosen period and details when the product changes and offers **Today**, **7 days** and **30 days**, counted from local midnight. It opens on 7 days. Defaults matter more than options: one chart and three splits are visible, the rest is one click away.

While Analytics stays open, it requests fresh account usage periodically even when the pool is paused. A tool says “Updating usage…” during a read. A failed refresh says “Couldn’t refresh usage. Showing the last report.” The previous percentage and its report time stay unchanged; a failed attempt never makes an old reading look current.

A request refused by Grok without an account reset says “request refused; retry after …”, with the provider's explanation below. This cooldown stays separate from the weekly meter and never claims the weekly allowance is used up.

1. **Usage limits**, per tool, first, with a note that these account limits also include sessions outside Petrina: how much of each limit is used (a thin meter that turns amber from 90% used and red when it is reached), when it resets, and when that was reported. A provider's warning below 90%, or without a percentage, reads “provider warning” (“provider warning · percentage not reported”) and never says the limit is close; usage history names it “Provider warning (reported)”. All usage cards stretch to the same height within the grid, regardless of the number of reported windows. Account readers supply the other tools without spending model tokens, following the shared [refresh rules](../architecture/engine-runtime.md#account-readers). Grok's allowance is shown with the percentage and reset time its account reports. A limit whose reset time has passed says so instead of showing the old percentage. Nothing reported reads "Not reported". Under the cards, **Usage history** shows one selected allowance per tool in at most two balanced columns, dropping to one column in narrow windows or with enlarged text. Its measure is **Highest reported usage per day** for 7/30 days, or **Highest reported usage per hour, so far today**. Each bar shows the highest percentage a tool reported, on a fixed 0–100% scale. Percentages describe allowance levels and do not add up. Date labels thin out to fit the plot and text size, with the first and last dates kept inside the card. Percentages appear above bars when the text fits; otherwise only the inspected bar is labelled, with exact values still available on hover, keyboard focus and in Table. Zero marks keep a visible “0%” key when individual labels cannot fit. A reported zero has a visible zero mark and text; missing days say “No readings recorded”, and status-only days say “No percentage”. Days before the allowance’s first reading and later hours stay blank. Coverage names the first report and days with readings. “Only today has readings” is reserved for an allowance whose retained history starts today; older allowances use hourly coverage in Today. Petrina records a reading only when a report changes.

   **Limit and model group** separates **In latest reports** from **History only**. Choices name the window and group, adding recorded scopes when names collide. Remaining unnamed allowances use numbered, plain-language labels and remain separate. Only proven Claude window aliases join. Initial selection prefers a current allowance with a percentage in the dates, shortest window first; otherwise the newest current allowance, then the newest history-only allowance. Selection survives view, period, product and refresh changes, even with no readings in the dates. Current membership follows the retained account snapshot, so failed or partial refreshes cannot retire allowances. History-only values have neutral bars and a dated last report; an old full allowance says “limit reached then”. No percentage is inferred from a refusal. Unavailable Claude extra usage reads “Extra usage unavailable · percentage not reported”.

   The chart has one Tab stop. Hover or focus reveals the date/hour, highest percentage, its first report time, percentage-report count and **Possible resets**. Arrows, Home and End move through dates; Enter opens readings; Escape dismisses the tooltip. The inspected day remains selected when the pointer leaves a chart that still has keyboard focus. App-wide shortcuts remain available while the chart has focus. The matching **Table** has Day/Hour, Highest reported, With a percentage and Possible resets, seven rows per card, newest first. One pager moves all cards through the same dates. Each period remembers its page, clamped to an existing page after range changes.

   **View readings**, a bar or a table date opens that allowance’s readings in place, for the period or chosen bucket. Pages contain 20 readings, newest first, with Reported at, Usage, Reported reset and Change. Back or Escape restores selection, page and focus, including after paging to either end or clicking reading text. Paging controls retain focus while loading and at the ends; unavailable actions do nothing. Escape in another panel keeps its normal behavior. Open pages keep their snapshot. Reset schedules have no lines or markers on the overview. A percentage fall after the previous schedule passed or advanced beyond elapsed report time by at least a minute is labelled **Possible reset (was …%)**, never a confirmation. Schedule differences under a minute read “Unchanged” in Reported reset; the original time remains available on hover. Other changes read Lower, Higher, Same level or First reading. The note says: “Reset times are the provider’s reported schedule. A possible reset means the percentage fell after that time passed or moved later. Neither confirms that a reset happened.”

   History uses local calendar days and real elapsed hours, including 23/25-hour days; repeated hours name their UTC offset. Source timestamps remain UTC. Nothing recorded says: “No usage history for these dates. Account readings refresh while Analytics is open. A percentage appears only when a tool reports one.” The current cards’ “Not reported” note explains that account readings refresh while Analytics is open.
2. **Tokens and agent time.** Four headline numbers: tokens, agent time, agent turns and tasks worked on. Turns include finished and stopped work; tokens and time are counted when a turn ends. Partial totals use a compact `>` marker. One stacked column chart per day (per hour for Today), with the **running total** in a strip under it on its own scale: split **by tool**, **by model** or **by provider** (Anthropic, OpenAI, xAI and Google: who runs the models behind each tool), measuring all tokens, new input, reused input or output where the tools reported them, or agent time. A legend names the series and a fixed colour follows each tool, model and provider whatever else is shown; every column is labelled on a week and only the largest on a month; the numbers show on hover and on keyboard focus; and a **Table** view shows the same numbers, day by day, with exact token counts in the table and tooltip. Missing reports say so instead of showing zero; partial amounts and running totals use `>`. Under it three splits: **by role**, **by tool** and **by model**, each line with its tokens, agent time and a bar, largest first. **Show details** adds new input, reused from the cache, written to the cache and output ("not reported" where missing; no figure ever shows as a dash). **By product** (only with all products) and **By task** are one click away; the task split shows the ten largest, a way to see all, and opens each task's sheet.
   - The model split shows tokens per model exactly as each tool reported them. Agent time sits with the model the agent ran on; a model that only appeared inside a turn shows its tokens, and its time reads "not reported". Model names Petrina recognises read plainly ("Opus 5.5"); any other name, a bracketed ending included, is shown exactly as reported and never merged into another model. Time from turns whose model wasn't confirmed sits on "Model not confirmed"; time from turns that changed model partway, and the tokens of a Codex turn that rerouted, sit on "Changed model during a turn". Token lines never show an effort.
   - A removed product keeps its history here under its old name, marked "removed".
3. **How the squad works.** Stages run, turns run, tasks delivered and cancelled; a column chart of tasks delivered and cancelled per day (Today is one column, never hourly); how long each kind of stage usually takes and how much of that was agent work; and one plain line each on send-backs, design rounds, questions to you (how often, and how long you took) and failures and retries. **Details per reviewer and per profile** are one click away: blocking findings and send-backs per reviewer, design rounds per architect and design reviewer and how often designs came to you, failures by reason, retries, redone results and interrupted turns. A profile is only credited with stages that ran on its own model and effort in every round, including rounds before the chosen period; other stages are listed under what actually ran, or under "Settings not confirmed", and one line says how many. Code and Security reviewers are both included. A profile’s unknown agent time reads “not known”; recorded time mixed with a lost turn uses `>`. Questions count from when agents ask, even if the task is later cancelled, and unanswered requests are listed without adding zero-length answers to the average.

4. **How reviews are going.** Tasks that stayed in numbered round one, the highest numbered round per passed task on average, unsettled reviews, coordinator send-backs, finding outcomes in separate numeric columns with an All reviewers total, a role breakdown separating Code reviewer, Security reviewer and custom review roles, and the reviewer comparison table. Verifier impact keeps each completed verification round, including earlier rounds on reopened findings: confirmed Important, not a bug, to nit, or pre-existing. It shows how many completed checks removed an Important finding as a blocker. The per-verifier table counts only the latest vote per proven actual tool within a round, shows each verdict, and compares votes with the final group decision as agreement, not accuracy. Older votes without a proven tool stay out of that comparison. Each table has its own heading and a clear gap before the next. Analytics uses consistent section dividers, 16px card padding, tabular numbers and the shared type scale in light and dark. Round metrics measure convergence depth across stages, not total review passes: revisiting round 3 does not increase that counter. Parallel seats and Verifier checks are not review rounds. These totals follow the selected product and are explicitly labelled as all recorded reviews across all dates. They are separate from the usage period above. Agents shows occupied slots, the queue, installed tools with Check again, and the terminal choice; it has no duplicate usage or review panels.

**About these numbers** is one small note, opened from a link beside the tokens section (and from the task sheet).

It says, for the chosen period: input reused from the cache is each tool's own count, not an exact measure of what agents re-read; the tools count slightly differently, so totals across tools are approximate; Claude Code's numbers include its helper agents and compaction inside each model's line; Grok's whole-turn totals include the subagent work its CLI has collected, with cache reads separated from new input and thinking included in output; Codex reports only its main agent, with how many turns started helpers whose use it doesn't report; how many Claude Code turns counted the main agent only because no per-model breakdown came; how agent time is placed by model; what "not known" means; that agent time adds up agents running at once; and why no prices are shown.

None of this is repeated line by line.

**Partial numbers:** `>` marks a recorded lower bound when whole turns are missing. There is no repeated explanation banner. Unknown is never shown as zero: when nothing known adds up, the number reads "not known". A missing figure a tool didn't send reads "not reported". No money appears anywhere.

### The three small places

### Task sheet → Overview → What it used

Total tokens and agent time, a line with the input the tools reused from their cache "as the tools report it", and an "About these numbers" link. Then each stage that ran, in plan order with planning first, with its agents: role, tool, the model and effort that actually ran (or "asked for sol at xhigh, ran gpt-6.1 at medium", or "settings not confirmed"), rounds, tokens and time, and each model's tokens when an agent's tokens span more than one. A stage removed by a re-plan still shows under its old name. A task with no entries says "Nothing used yet" or that it ran before Petrina kept track.

### Products page → Agent work

Each product's total tokens and agent time, finished and cancelled tasks included.

### Pool popover → Today

(see The pool).

Cards, board columns, the Agents page and the inbox show no usage numbers, so the board stays calm.

## Routines

Each routine offers **View all runs** at `/routines/:id/runs`: current queued and active tasks above paginated finished and cancelled runs. Saved routine IDs keep this view exact through renames and removal. Product scope, search, page and task links survive navigation.

Each card names its product, maintenance role, full tool/model/effort profile, frequency, saved time zone, dated next queue time with UTC offset and Enabled, Disabled or Needs attention state. Latest queued run is a separate task link. Scheduling messages explain catch-up, skipped triggers and the blocking task, paused scheduling or unavailable references without replacing that link. Edit and Remove remain available for missing references.

Add a routine and Edit open the same responsive panel. Choose exactly one saved product, maintenance role and profile; the suggested name follows the role and product until edited. Focus instructions are optional. The time zone initially uses the Mac's regional zone and is editable on both creation and editing. Daily uses a local time; Weekly uses weekdays and a local time. Custom reveals five-field minute-based cron, with numeric values, lists, ranges and steps, a field guide and plain-language validation. When date and weekday are both restricted, either can match. Impossible dates and unknown zones cannot save; valid infrequent dates can.

The editor previews the next three queue times and explains delivery: completed investigations without changes finish in History; changes get automated checks, two independent Code reviewers and delivery approval. Reports only is always read-only. A daylight-saving gap skips that local time; a repeated time runs once, at its first occurrence. The saved zone does not follow later Mac zone changes. Queue time does not promise an agent start, and Petrina must be running to queue work. The preview names the saved zone once above three aligned date/time rows, with each occurrence’s UTC offset beside it; dates wrap at enlarged text sizes.

After sleep or restart, missed times combine into one catch-up task representing the latest missed occurrence. Every unfinished earlier run blocks another, including failed, held, paused and unresolved delivery work. Skipped work never replays. Creating, rescheduling, changing zone, re-enabling or repairing an unavailable choice starts at the first future time. Repairing a routine does not queue a catch-up for the time it needed attention. Disabling or removing stops future occurrences while preserving existing tasks. Save is explicit, Command/Ctrl+Enter works, Escape closes or asks before discarding edits, and focus returns to the opener. Disconnected controls wait for reconnection.

## Library

Library has addressable Roles and Profiles views. `/library` and `/library/roles` open Roles; `/library/profiles` opens Profiles. Roles and profiles are shared across products. Routines has its own `/routines` page in the main sidebar, follows the product filter and retains its scope and demo parameters through refresh and browser history.

### Roles

Workflow and Maintenance are permanent categories. Workflow roles alone appear in ordinary plans and task role pickers. Maintenance has six editable starters and its own Add a maintenance role control. New maintenance roles choose Reports only or Small changes with review once, with permission determined by that result and no separate permission switch. Renaming never changes behavior. Starter instructions follow the evidence-first examples in [OpenAI’s maintenance article](https://developers.openai.com/blog/maintaining-software-with-the-gpt-6-family), adapted to available repository evidence without assuming specific services.

A card per role with its icon, purpose, what it may change, what it sees and what it hands back. Built-in roles say "Built-in", plus "Edited" once changed; roles you add say "Added by you". **Add a role**, at the top of the section, starts one from blank, from a Security reviewer or from a Copywriter, with a name, an icon and a colour of your choice.
  - **Edit** opens a panel from the right that asks, in plain words: what it's for (the planner reads this to decide when to bring it in), how it works (what the agent is told), what it may change and what it hands back. Below them it shows what Petrina decides: where its tasks sit on the board and what it sees. No code, ids or settings. Save is explicit (⌘↵); Cancel, Escape or closing with unsaved changes asks first.
  - **What it may change:** Read-only (anything it changes is undone when its step ends) or Can change the product (its changes are saved on the task's branch and checked by the reviewers). Roles that change the product always work before the final review: Petrina handles delivery itself after it. The choice is locked, with the reason shown, for the Planner (always read-only), the reviewers (they never change the work they judge) and the Builder (it always makes changes).
  - **What it hands back:** a role you add hands back Notes, which every later agent on the task reads, or Pass-or-fail findings, which put it in the review next to the code reviewers, its blocking findings going back to the builder. You choose once: to hand back something else, add a new role. Built-in roles keep their name, icon and kind of result, because Petrina depends on them; their description can change.
  - **Reset to default** brings back Petrina's wording and settings for an edited built-in role, after you confirm. **Remove role** takes a role you added out of the Library and the planner, after a confirmation that names any unfinished task using it: tasks already planned with it still run it, and past tasks still show its name and icon.
  - The **Release Manager** has View instead of Edit. It writes release notes, read-only, and can't be edited here. Petrina adds delivery last and handles publishing itself, as before.
  - The engine saves the changes and keeps them across restarts. They reach the next agent that starts and the next plan the planner makes; an agent already working finishes with the version it started with. Roles you add appear in plans with their icon and name like any other; when the planner puts one where it can't work, the plan's reason says what Petrina changed. In the demo, changes apply to the simulated squad for the session.

### Profiles

Profiles are grouped by tool and native model, with a bundled tool icon and a labelled effort indicator for each saved configuration. Different efforts remain separate choices within that model’s card. New profile and Edit open the shared side editor: Tool, Model, Effort and whether to offer it to the Planner. Choices come from the installed harness on demand. Refresh choices is explicit, with no page polling; unavailable or unsupported choices show a reason and cannot be saved.

Built-in profiles can be edited or removed. Reassign unfinished tasks and routines first; the editor names those references. Finished tasks retain their recorded definition. At least one profile must remain available to the Planner. Edits and removals survive restart. Duplicate tool/model/effort combinations are rejected; Ultra and Extra High remain distinct.

If a maintenance tool reports different model or effort settings, Inbox shows requested and reported settings with Keep this run and Stop this run. Keeping accepts only that turn’s work and retains normal delivery gates; stopping cancels and cleans up. Neither changes the routine’s profile. The task’s Scheduled routine section retains its frozen request, times, findings and settings decision after routine edits or deletion.

### Templates

Example plans the planner learns from.

## Settings

One page for the whole app, from the bottom of the rail or with ⌘, (Ctrl+, on Windows and Linux). It uses the same page header, type and spacing as the other pages, in every look. It contains app-wide preferences; each product is edited on Products.

### Appearance

The looks, grouped Light and Dark, each with its name and one sentence. The same list is in the top bar and in the command palette ("Use the Ink theme", and the same for the others).

### Notifications

One switch ("Notify me when the squad needs me"), a line about permission, and **Send a test notification**. The line is honest: a browser says it allows Petrina's notifications, blocks them (with how to allow them), or has not been asked yet. The desktop app cannot read the system's setting, so it says so, suggests the test, and names where to allow Petrina: System Settings › Notifications on a Mac, Settings › System › Notifications on Windows, the desktop's notification settings on Linux.

It never says "allowed" without having checked. On a Mac the test goes out after five seconds, because macOS shows no banner for the app in front. With the switch off the test is unavailable.

### Keyboard

The single-key shortcuts switch (the same choice as in the command palette) and a button that lists every keyboard shortcut.


## First run

Four short screens in one window, with a step indicator, Back, and **Skip setup** on every screen. It shows only on a fresh install (no products, no tasks), and only once Petrina has its engine's real state: until then it says "Starting Petrina…". Someone who already uses Petrina never sees it. Closing Petrina partway reopens at the first unfinished screen; a lost connection keeps the screen and everything typed, says it is reconnecting, and carries on.

1. **Welcome:** "Petrina runs a squad of AI agents on your products. You set priorities and make the calls." Everything runs on this machine. Get started (or Enter).
2. **Tools:** Claude Code, Codex and the GitHub CLI, each Checking, Ready, Not installed, Not logged in, or Couldn't check (the GitHub CLI says which account). Grok and Antigravity get rows when installed, and Git and Node.js when missing or when their latest answer is Couldn't check; they stay hidden when Ready or before the first answer. Anything not Ready shows one sentence and the official guide; a confirmed installation or login problem also shows its command with Copy. An uncertain result offers Details and Check again, without guessing that the login is wrong. Tools are checked once when the screen opens and then only with Check again; window focus and tab visibility never trigger checks. Continue needs Git, Node.js and one agent tool (Claude Code, Codex, Grok or Antigravity when installed) that is Ready or couldn't be checked. Notes say when agents will review on one tool, when Petrina will only try a tool, and that the GitHub CLI is needed before the first pull request.
3. **Product:** up to six GitHub clones found in the usual code folders, newest first, one click each, or paste a folder (~ and subfolders work). The scan never follows a shortcut, on the way to a code folder or inside one. On a Mac it stays out of Documents, Desktop and Downloads, which would bring up a system permission window; a clone there is pasted. Refusals are one plain sentence. A folder already added says so. A clone not linked to GitHub keeps its finished work on this machine, and the screen says so, here and in Add a product.
4. **First task:** the product picked, a title, three starter ideas, optional details, "Show me the plan first" on, and More options with the New task dialog's choices. Start (or Enter) shows Starting… and keeps everything until Petrina confirms the task is saved; a refusal, no answer in 10 seconds or a lost connection gives a plain message and Try again, never a second card.

Then the board, with the first card on its Plan step and a one-time tip that follows "Show me the plan first": the plan will arrive in Needs you for approval, or the squad has started and the card shows the plan. While the first task is stuck, the tip says so and points at Needs you instead of promising a plan. Skip setup leads to a board whose empty state offers Add a product and New task. `?demo=first-run` shows first run on the simulated squad.
