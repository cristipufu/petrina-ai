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
7. **Agents ask, you answer.** Every question and permission request comes with suggested answers. One click unblocks.

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
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ ◆ Petrina   All products ▾     ⌕ Search ⌘K            Pool ■■■□ 3/4     Inbox  4   │
├──────┬───────────────────────────────────────────────────────────────┬──────────────┤
│ Board│ Queue · 4   Planning · 1  Designing · 1  Building · 1  Review… │ Needs you    │
│ Agents│ ┌───────┐  ┌──────────┐   ┌──────────┐   ┌──────────┐         │ ┌──────────┐ │
│ Library│ │ #1 …  │  │ …        │   │ …        │   │ …        │         │ │ Question │ │
│ Settings│└───────┘  └──────────┘   └──────────┘   └──────────┘         │ └──────────┘ │
└──────┴───────────────────────────────────────────────────────────────┴──────────────┘
```

- **Top bar:** product switcher, search and command palette (⌘K), the pool indicator, the inbox button with its count.
- **Left rail:** Board, Agents, Library, Settings. Icons with labels; it collapses to icons.
- **Main area:** the board by default.
- **Right panel:** the inbox. It opens on its own when something new needs you (setting), and it can be pinned or hidden.
- **A task** opens as a wide sheet over the board, so the board stays in view. ⌘↵ makes it full screen.

## Board

A kanban board. Columns follow the life of a task:

| Column | What is happening |
|---|---|
| **Queue** | Waiting to start, in priority order |
| **Planning** | The planner is composing the plan, or the plan waits for your OK |
| **Designing** | Research, architecture and design review rounds |
| **Building** | Builder (and tester) at work |
| **Reviewing** | The review chain |
| **Ready** | Waiting for your delivery OK, or the pull request is open for you to merge on GitHub. Merged and cancelled tasks fold into a "Done" list at the bottom, so the whole flow fits on one screen |

The run state is shown on the card, not as a column, so a task never jumps around:

- **Running:** a soft pulsing dot and the live status line.
- **Needs you:** amber edge and a "Needs you" pill. These cards float to the top of their column.
- **Waiting for a slot:** in the queue, below the "starts next" line.
- **Paused, Failed, Held:** grey, red and striped respectively.

### The queue

- Drag cards to reorder. ⌥↑ / ⌥↓ moves the focused card. "Move to top" is in the card menu.
- A dashed **starts next** line sits under as many cards as there are free slots. Everything above it starts as soon as possible.
- **Hold** keeps a task in the queue without starting it ("not yet").
- New tasks go to the bottom by default; the new-task dialog offers "Top".

### Card

```
┌────────────────────────────────────────────┐
│ #2  Guest checkout                    Shop │  priority, title, product
│ ▰▰▰▱▱  Building                            │  stage progress
│ 🔨 Builder · Claude Code · Opus 5.5 ●●●    │  who is working: role, tool, model, effort
│ ● Adding the guest email step              │  live status line
│ 12m · round 1 · Needs you                  │  time, rounds, blockers
└────────────────────────────────────────────┘
```

Hover shows quick actions: Message, Pause or Resume, Join session, and a menu (Move to top, Hold, Cancel).

## Many products

A coordinator may run twenty products or more, so nothing assumes a handful.

- **Product switcher** (⌘P) in the top bar: a search field, then products grouped as *Needs you*, *Active* and *Quiet*, each with badges for what waits on you, agents working and tasks queued. The board keeps its full width.
- **Products page:** the portfolio on one screen. One row per product with its pipeline (queue, plan, design, build, review, ready), what shipped, and what waits on you. Products that need you sort first; clicking one filters the board to it.
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

Everything waiting on you, ordered by task priority, then by age. Each item says which product and task, who is asking (role, tool, model), how long it has waited, and whether it is blocking an agent.

| Kind | Example | Actions |
|---|---|---|
| **Question** | "Should dark mode follow the system setting, or be a manual toggle?" | Suggested answers as buttons, free text, "Decide for me" (the agent takes its own recommendation) |
| **Permission** | "Builder wants to add a new package: Stripe.js" | Allow once, Always allow in this product, Deny with a note. "Details" shows the exact command |
| **Plan** | The planner's plan, if you asked to approve plans | Approve, Edit, Re-plan with a note |
| **Design checkpoint** | The design brief and the disagreement log | Approve, Request changes with a comment. After your call it says how many objections the call settled, and changes go to the architect only |
| **Disagreement** | The architects did not agree after the round limit | Both positions side by side. Side with the architect, or write your call: it is final, the architect updates the brief to follow it with no further review round, and you check the brief before building (a design checkpoint is added if the plan has none) |
| **Delivery** | Acceptance checklist and review summary | Open pull request, Send back with a note |
| **Stuck** | A stage failed twice, or a tool needs you to log in | Retry, Switch tool or model, Edit plan, Cancel |

### Permissions

Agents start with full permissions inside their own working copy, so they rarely need to ask. A short **ask-me list** escalates to you instead:

- adding or removing dependencies,
- deleting anything outside the working copy,
- network access to hosts not seen before,
- pushing, and force-pushing in particular,
- reading secrets or `.env` files,
- anything that spends money (paid APIs, cloud resources),
- running for longer than the stage's time limit.

The list is editable in Settings, with overrides per product ("Always allow in Shop").

### Notifications

- A system notification for anything blocking. Clicking it opens that inbox item.
- The dock or taskbar badge shows the inbox count.
- Optional sound. Quiet hours.

## Task sheet

**Header:** title (editable), product, priority, a status pill, and a stage stepper (`Plan · Design · Build · Review · Ship`). Actions: Message, Pause, Join session, and a menu.

**Tabs:**

- **Overview:** the live timeline. One section per stage: who did it, how many rounds, the outcome, and plain-language events. The current stage is expanded with its streaming status lines.
- **Plan:** the plan card. You can edit it: reorder stages, swap the tool or model on a role, add a reviewer, change round limits, toggle checkpoints. "Re-plan" sends a note to the planner.
- **Design:** the brief (what changes for users, which parts of the product, the acceptance checklist, risks) and the disagreement log. Each objection shows who raised it, whether it is open, accepted or rejected, and why. Objections your call settled carry a "Your call" tag, your words, and the architect's note on how the brief follows them.
- **Review:** the merged findings. Blocking ones first, each with who raised, confirmed or disputed it, plus the result of the tamper check.
- **Session:** join the agent that is working right now (below).

A composer stays at the bottom of every tab: "Message the agent on this task…".

## Session: join an agent

This is the "open in terminal" experience, made friendly.

- A chat transcript of the current agent. Its messages are plain text. Tool activity is folded into readable lines ("Ran the tests: 42 passed", "Edited 3 files in Checkout"). Questions appear inline with their answer buttons.
- The composer has two modes:
  - **Queue** (default): delivered when the agent finishes its current step. Queued messages show as chips you can edit, reorder or delete.
  - **Interrupt**: stops the current step and delivers now.
- **Take over:** opens the agent's own CLI in your terminal, resumed on the same session in its working copy. Petrina pauses the stage while you drive. **Hand back** resumes it, with a note of what you did.
- Anything the task is waiting on (a question, a permission, a checkpoint) shows above the composer with the same buttons as the inbox, so you can unblock without leaving the session.
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

## Library

- **Roles:** cards with icon, purpose, permissions and what each one hands back. Edited in a plain-language form.
- **Tools and models:** the agents found on this machine (installed, logged in), their models and effort levels, and a Test button.
- **Templates:** example plans the planner learns from.

## Settings

Pool limit and caps per tool. The ask-me list. Notifications. Default checkpoints. Appearance: light, dark or system. Where data lives.

## First run

1. Welcome: "Petrina runs a squad of AI agents on your products. You set priorities and make the calls."
2. Tools check: Claude Code, Codex and the GitHub CLI, with installed or logged-in status and a fix for anything missing.
3. Add your first product, from GitHub or a local folder.
4. Write your first task. The planner shows its plan. Go.

## Visual language

- Light and airy, warm neutrals. Dark mode is first class.
- One accent colour (Petrina violet). Semantic colours: running blue, needs-you amber, done green, failed red, queued slate.
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

- Tool chip: tool name, model, and effort as dots (●●●○ for high).
- Motion is subtle: cards glide between columns, the live dot breathes, no walls of spinners.
- System font, 13 to 14 px base, generous spacing, tabular numbers.
- A density toggle: comfortable or compact.

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
