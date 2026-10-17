# Petrina UX

This is the UX brainstorm the app is built from. It describes who the app is for, the mental model, every surface, and the rules that keep it calm.

## Who it is for

**The Coordinator.** A builder or product person who launches and maintains products. They think in outcomes ("guests can check out without an account"), not in files. They run a squad of AI agents the way a lead runs a small team:

- they drop tasks in and put them in order,
- the squad works on its own, as many agents at once as they allow,
- agents come back when they need a decision, a permission or an opinion,
- they unblock, nudge, and ship.

They do not read code. Code lives in the pull request on GitHub, one click away for whoever wants it.

What success feels like: many pull requests a day, little time spent being the thing everyone waits on.

## Principles

1. **Calm by default, loud when it needs you.** While agents work, the app is quiet. Anything waiting on you is impossible to miss: inbox count, an amber card, a system notification.
2. **Plain language everywhere.** No code, diffs or file trees. Every agent action becomes a sentence ("Adding the guest email step", "Ran the tests: 42 passed").
3. **The queue is the plan.** Priority is order. When a slot frees up, the top of the queue starts.
4. **You set the pace.** A visible pool of agent slots. You choose how many run at once and see who is in each slot.
5. **Everything is interruptible.** Message an agent, pause, reprioritize, take over or cancel, at any time.
6. **Decisions, not configuration.** The planner proposes, you nudge. Defaults are good enough to never open settings.
7. **Agents ask, you answer.** Every question comes with suggested answers, the agent's own recommendation first. One click unblocks.

## Words the app uses

| Word | Meaning |
|---|---|
| Product | One GitHub repository the squad works on |
| Task | Something you want done. Lives on the board |
| Queue | Tasks waiting to start, in priority order |
| Pool | How many agents may work at the same time (slots) |
| Squad | The roles available: Planner, Architect, Builder, Reviewer… |
| Agent | A role running on a tool, model and effort, working one stage of one task |
| Plan | The stages the planner proposes for a task |
| Inbox | Everything waiting on you |

## Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ◆ Petrina  All products ▾  ⌕ Search ⌘K   Blocking 2  ■■■□ 3/4  Inbox 4  + New task   │
├──────────┬──────────────────────────────────────────────────────────┬────────────────┤
│ Board    │ Needs you 4                                              │ Needs you 4    │
│ Products │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │ ┌────────────┐ │
│ Agents   │ │ Shop     │ │ Notes    │ │ …        │ │ …        │      │ │ Question   │ │
│ Library  │ └──────────┘ └──────────┘ └──────────┘ └──────────┘      │ └────────────┘ │
│          │ Working 1 · Waiting · Queue 4 · Done 2 (folded)          │                │
└──────────┴──────────────────────────────────────────────────────────┴────────────────┘
```

- **Top bar** (56px): product switcher, search (⌘K), the pool indicator, the inbox button with its count, and **New task**, the only solid violet button in the workspace. It stays quiet: no border, neutral buttons.
- **Left rail** (64px): Board, Products, Agents, Library. Icons with labels.
- **Main area:** the board by default.
- **Right panel** (360px): the inbox. It can be hidden (I) and opened again from the top bar.
- **A task** opens as a sheet over the board (840px wide), so the board stays in view.

### Window size

- The desktop window opens with 1680×1000 for the app itself, the title bar on top of that, centred and never larger than the screen's usable area: the whole window, title bar included, stays below the menu bar and clear of the Dock or taskbar, on whichever screen it opens. It can shrink to 1100×680, again not counting the title bar. On a screen smaller than that it opens at the minimum in the top-left corner of the usable area, so the title bar is always reachable.
- Narrower windows show fewer cards per row; the board itself never scrolls sideways. Wide tables, like the Products page, scroll sideways instead of squeezing.
- As the window narrows, the top bar gives things up in order: the wordmark and repeated wording first, then the search field becomes a button that opens it, then the pool shows only its count, then the pool and the theme move into a More menu. The product switcher, Inbox and New task always stay.
- Below 1200px of usable width the inbox opens over the board instead of beside it. Esc or the close button hides it and puts focus back on the Inbox button.
- Browser zoom and enlarged text count as a narrower window, so the same steps apply at 200%.

## Board

One grid of task cards, ordered by what each task needs rather than by stage. Every card carries its own progress, so nothing has to move between columns:

| Group | What is in it |
|---|---|
| **Needs you** | A question, a permission, a checkpoint, or a task that failed. Agents kept waiting come first, in the same order as the inbox |
| **Working** | An agent is on it right now |
| **Waiting** | Waiting for a free slot, paused, or delivered and waiting for you to merge |
| **Queue** | Not started yet, in priority order |
| **Done** | Merged, released, delivered locally or cancelled. Folded away at the end |

Empty groups are not shown. The product switcher and search filter the whole board.

The run state is written on the card, never shown by dimming it:

- **Working:** a soft pulsing dot and the live status line.
- **Needs you:** these cards sit under the Needs you heading with an amber edge, and their status line says what they wait for ("Waiting for your permission"). They carry no extra badge.
- **On hold, Paused, Waiting for a slot, Failed, Awaiting merge, Completed, Cancelled:** said in words at the top of the card. Held cards sit on a quieter surface; failed ones get a red edge.

### The queue

- Drag cards to reorder. ⌥↑ / ⌥↓ moves the focused card. "Move to top" is a card shortcut.
- The cards that start as soon as a slot frees say **Starts next**.
- **Hold** keeps a task in the queue without starting it ("not yet"). It is in the card's More menu and the task sheet.
- New tasks go to the bottom by default; the new-task dialog offers "Top".

### Card

```
┌────────────────────────────────────────────┐
│ ● Shop · #2 in queue              On hold │  product, queue position, state
│ Guest checkout                             │  title, semibold, wraps
│ ● Waiting for your permission              │  live status line, wraps
│ ✓ ✓ ✓ ◉ Build ○ ○                          │  its own pipeline: done steps checked, the current one named
│ 🔨 Builder  Opus 5.5  ◷ 19m  Round 2  ✉ ⏸ … │  agent, model (quiet), time, rounds · shortcuts
└────────────────────────────────────────────┘
```

- The pipeline comes from the task's plan, for example Plan, Design, Your check, Build, Review, Ship. Stages the plan does not have are absent. Hovering or focusing any step names it in a small tooltip ("Plan, done", "Build, now", "Review, next"), so the whole pipeline is readable without opening the task. The strip is one tab stop; the arrow keys move between its steps. It always fits on one line: on long plans (seven steps or more) the gaps tighten and the finished steps fold into one check with a count ("✓ 4", named in its tooltip: "Plan, Research, Design and Screens, done"); a very long plan also folds its furthest steps into "+N". The task sheet lists every step by name too.
- Delivery shows in the footer in words: "Pull request #237 · awaiting merge", "Released v1.4.0", "Delivered locally to main".
- Shortcuts (Message, Pause or Resume, Move to top, and More: Open, Join the session, Hold, Cancel) appear on hover and on keyboard focus, in space the footer always keeps for them, so nothing moves or gets covered.

## Many products

A coordinator may run twenty products or more, so nothing assumes a handful.

- **Product switcher** (⌘P) in the top bar: a search field, then products grouped as *Needs you*, *Active* and *Quiet*, each saying in quiet text what waits on you, how many agents work and how many tasks are queued. The board keeps its full width.
- **Products page:** the portfolio on one screen. One row per product with its pipeline (queue, plan, design, build, review, ready), what shipped, and what waits on you, as aligned numbers rather than badges. Products that need you sort first; clicking one filters the board to it. In a small window the table scrolls sideways.
- The queue and the pool stay global: priority is across products, because the pool of agents is shared.
- Cards always carry their product, so an all-products board stays readable.

## The pool

How many agents may run at once.

- The top bar shows one square per slot, filled with the colour of the role in it: `■■■□ 3/4`.
- Clicking opens a popover:
  - a stepper for the limit (1 to 12),
  - caps per tool (for example Claude Code 3, Codex 2), so one subscription is not exhausted,
  - **Pause pool**: running stages finish, nothing new starts,
  - the list of who is in each slot.
- Rules:
  - A running stage holds a slot.
  - A task at a checkpoint (waiting for your OK between stages) releases its slot.
  - An agent that asked you something mid-stage keeps its slot, and the slot turns amber. The top bar then says "You're blocking 1 agent", because the coordinator is the bottleneck and should know it.
  - Lowering the limit never kills anyone. Running stages finish, then the pool shrinks.
- The **Agents** page is the same information large: one tile per slot with the live status line and a Join button.

## Inbox: "Needs you"

Everything waiting on you: items that keep an agent waiting first, then by task priority, then by age. Each item reads top to bottom: its kind and how long it has waited, "An agent is waiting on this" on its own line when it is blocking, the full request, the agent's explanation, then the product, task and who is asking (role, with the model as quiet text). Buttons line up the same way in every item: at least 36px high, 8px apart, and long labels wrap. Each item has at most one lead button (charcoal in light mode, pale in dark mode); the rest are quieter.

| Kind | Example | Actions |
|---|---|---|
| **Question** | "Should dark mode follow the system setting, or be a manual toggle?" | The agent's answers as equal choices, its own recommendation first and marked "Agent's suggestion". "Decide for me" (only when there are choices) picks that first answer, and says so. Or answer in your own words |
| **Permission** | "Add a new package: Stripe.js" | **Allow** (once) or **Deny**. "Show the exact command" reveals what the tool asked to run |
| **Plan** | The planner's plan, if you asked to approve plans | **Approve plan**, See the plan, Re-plan with a note |
| **Design check** | The design brief and the disagreement log | **Approve design**, Read the brief, Request changes with a note. After your call it says how many objections the call settled, and changes go to the architect only, who answers those objections again and can correct a decision, a "Your call" tag or a note. The call stays: no later check reopens the design it settled |
| **Disagreement** | The architects did not agree after the round limit | **Read both sides** leads; "Side with the architect" and "Write my call" are equally quiet. Your call is final: the architect updates the brief to follow it with no further review round, and you check the brief before building (at the plan's own design check, after steps such as Screens; one is added only if the plan has none before the build) |
| **Ready to ship** | Acceptance checklist and review summary | **Open a pull request** (or publish, or commit), See the reviews, Send back with a note |
| **Stuck** | A stage failed, or a tool needs you to log in | **Try again**, See what happened, Cancel task |

Every agent is told: when you ask the coordinator a question with choices, put the answer you recommend first. The demo squad does the same, and keeps every answer in its order.

### Permissions

Agents start with full permissions inside their own working copy, so they rarely need to ask. Petrina relies on each tool's own safety checker (Claude Code in Auto mode, Codex in Auto review) and does not read commands itself. When a tool's checker flags something, its request comes to the inbox unchanged:

- **Allow** lets it go ahead this once. **Deny** blocks it.
- Nothing is remembered: the next request asks again, in any task and any product. Petrina never picks a tool's own "always" option.
- Because nothing is remembered, there is no list of saved permissions in the app. Seeing and removing remembered permissions is not available yet; if remembering ever comes back, it belongs to Product settings and board papercuts.
- Plan, design and delivery checks are the engine's gates, not permissions: an agent cannot skip them, and only the shipper ever delivers.

### Notifications

- A system notification for anything blocking. Clicking it opens that inbox item.
- The dock or taskbar badge shows the inbox count.
- Optional sound. Quiet hours.

## Task sheet

**Header:** the product and state, the title (28px, wrapping in its own area), and the task's steps from its plan with every step named. Actions: the pull request link when there is one, Message, Pause or Resume, a More menu (Move to top, Hold, Cancel) and Close. As you scroll, the full title and the steps scroll away and leave a one-line title, the actions and the tabs. In narrow or short windows the one-line title shows from the start.

**Tabs:**

- **Overview:** what you asked for, who is on it right now (role, tool, model and effort in words), and the timeline: one row per event with its time aligned on the left, and a clear break at each stage change.
- **Plan:** why this plan, then the stages as a spacious numbered list. Stages that have not started can change tool or model, and a review can gain a reviewer. "Re-plan" sends a note to the planner.
- **Design:** the brief in one reading column (what changes for users, which parts of the product, the acceptance checklist, risks), then the disagreements. Each one separates the issue, its status, who raised it and the architect's answer, with open blockers first. Objections your call settled carry a "Your call" tag, your words, and the architect's note on how the brief follows them.
- **Review:** the tamper check, then the findings: open blockers first, each with its status, who raised it and who confirmed it.
- **Session:** join the agent that is working right now (below).

Prose (the plan's reasoning, the brief, the conversation and questions) sits in a reading column about 620px wide, roughly 60 to 70 characters a line. The timeline and the reviews use the full width.

## Session: join an agent

This is the "open in terminal" experience, made friendly.

- A chat transcript of the task. Every message names its speaker, including You, keeps its paragraphs, and sits on a quiet background on both sides. Tool activity is grouped into quiet readable lines between messages ("Ran the tests: 42 passed", "Edited 3 files in Checkout").
- New messages only scroll the conversation when you are already at the bottom, so reading earlier messages is never interrupted.
- The composer has two modes:
  - **Queue** (default): delivered when the agent finishes its current step. Queued messages wait at the end of the conversation, outlined and marked as queued, each with Remove. They scroll with the conversation, so a long queue never pushes the composer or Send out of view, and sending always brings your message into view.
  - **Interrupt**: stops the current step and delivers now.
- **Take over:** opens the agent's own CLI in your terminal, resumed on the same session in its working copy. Petrina pauses the stage while you drive. **Hand back** resumes it, with a note of what you did.
- Anything the task is waiting on (a question, a permission, a checkpoint) shows at the end of the conversation with the same wording and buttons as the inbox, so you can unblock without leaving the session. It scrolls with the conversation; the composer stays compact at the bottom.
- Earlier agents of the task (previous stages) can be read the same way.

## New task

⌘N from anywhere.

- **What do you want?** A title and a description in plain words.
- **Product.**
- **Where in the queue:** Bottom (default) or Top.
- **Plan:** Auto (the planner decides) or a template.
- **Ask me before starting:** off by default.
- Attachments: screenshots and links.
- "Add another" keeps the dialog open for brain dumps. Pasting a list creates one task per line.
- New task and Add product open centred and stay inside the window at every size and at 200% zoom; when there is not enough room, the dialog scrolls inside itself.

## Library

- **Roles:** cards with icon, purpose, permissions and what each one hands back. Edited in a plain-language form.
- **Tools and models:** the agents found on this machine (installed, logged in), their models and effort levels, and a Test button.
- **Templates:** example plans the planner learns from.

## Settings

Pool limit and caps per tool. Notifications. Default checkpoints. Appearance: light, dark or system. Where data lives. (There is no permission list: Petrina remembers no permission answers.)

## First run

1. Welcome: "Petrina runs a squad of AI agents on your products. You set priorities and make the calls."
2. Tools check: Claude Code, Codex and the GitHub CLI, with installed or logged-in status and a fix for anything missing.
3. Add your first product, from GitHub or a local folder.
4. Write your first task. The planner shows its plan. Go.

## Visual language

- Calm and airy, warm neutrals. Light mode puts white content on warm off-white surroundings; dark mode puts visibly raised charcoal surfaces on graphite. Both are deliberate, not inverted.
- One accent colour (Petrina violet), used for the one solid button, New task, and for selection. Decisions lead with a charcoal button in light mode and a pale one in dark mode. Secondary actions are neutral surfaces or plain text. Semantic colours: running blue, needs-you amber, done green, failed red, queued slate.
- Fewer borders, pills and chips: states, counts and tool information are quiet text.
- Each role has an icon and a colour:

| Role | Icon | Colour |
|---|---|---|
| Planner | map | indigo |
| Researcher | book | orange |
| Architect | compass | violet |
| Design reviewer | scale | purple |
| UX designer | palette | pink |
| Builder | hammer | blue |
| Tester | flask | green |
| Code reviewer | magnifier | teal |

- Tools and models are quiet text: a card shows the model ("Opus 5.5"); the sheet says it in full ("Claude Code · Opus 5.5 · high effort").
- Motion is subtle: the live dot breathes, sheets slide in, no walls of spinners. Reduced motion turns it off.

### Type

Inter, bundled with the app (the window's security policy only loads fonts from the app itself), with its standard letterforms. Sizes and line heights:

| Use | Size / line height | Weight |
|---|---|---|
| Metadata: times, counts, product names | 12 / 16 | Regular |
| Controls: buttons, tabs, fields | 13 / 20 | Medium |
| Card titles and short body text | 14 / 20 | Semibold titles, regular text |
| Questions and longer reading | 16 / 24 | Regular |
| Panel headings | 20 / 28 | Semibold |
| Page and task titles | 28 / 36 | Semibold |

- Sentence case everywhere. Nothing essential is smaller than 12px.
- Every number uses equal-width digits, so counts, durations, timestamps and pool usage never shift as they change ("You're blocking 2 agents", "2 agents are waiting on you").
- Sizes follow enlarged text: at 200% the layout gives up space the same way a narrower window does.

### Spacing

- A 4px grid, mostly 8, 12, 16, 24 and 32.
- Cards and inbox items have 16px padding; 12px between cards; 16px board margins.
- The task sheet has 32px padding and 32px between reading sections (16px in narrow windows).

### Contrast

- All enabled text is at least 4.5:1 against what it actually sits on, in both themes, including hover. Field outlines, focus rings, the amber edge and other essential boundaries are at least 3:1. Field outlines are stronger than decorative separators.
- Keyboard focus is always visible.

## Keyboard

| Key | Action |
|---|---|
| ⌘K | Command palette |
| ⌘N | New task |
| I / B / A | Inbox, Board, Agents |
| J / K | Move between cards or inbox items |
| ↵ | Open |
| ⌥↑ / ⌥↓ | Raise or lower priority |
| P | Pause or resume |
| M | Message |
| ⌘J | Join session |
| Esc | Close the topmost thing only: a menu, then a dialog, then the task sheet. Focus goes back to where it was |
| Tab / ⇧Tab | Inside the task sheet or a dialog, stay inside it until it closes |

## Edge cases

- **No tools installed:** first run stops at the tools check with the fix for each one.
- **A tool logs out mid-run:** a "Stuck" inbox item says which tool needs a login.
- **A usage limit is hit:** the agent pauses with "Resumes at 14:00" and offers to switch tool.
- **Closing the app with agents running:** asks whether to keep running in the background or pause everything.
- **Two tasks touching the same area:** the planner warns ("Might overlap with Checkout revamp").
- **A stage runs too long:** a soft time limit per stage raises an inbox item.

## Later

- Epics: the planner splits a big ask into several tasks.
- Follow-ups on pull request comments.
- A Tester role that runs the app and attaches screenshots.
- Diagrams of what a change does.
- Usage and throughput dashboard.
- Phone notifications.
