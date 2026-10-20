# Board and History

Owns task grouping, queue order, card summaries and archived-task navigation. Back to [UX overview](../ux.md).

## Board

One grid of task cards, ordered by what each task needs rather than by stage. Every card carries its own progress, so nothing has to move between columns:

| Group | What is in it |
|---|---|
| **Needs you** | A question, a permission, a checkpoint, or a task that failed. Agents kept waiting come first, in the same order as the inbox |
| **Working** | An agent is on it right now |
| **Waiting** | Waiting for a free slot or for the screen, paused, or delivered and waiting for you to merge |
| **Queue** | Not started yet, in priority order |
| **Backlog** | Awaiting the coordinator’s review before it can join the queue. It never starts automatically |

Empty active groups are not shown. Queue and Backlog remain visible, in that order, with their counts even at zero. An empty Backlog explains that requests await review and offers Add a request. The product switcher and search filter the whole board. Finished and cancelled tasks leave the board and appear in History.

Backlog tasks can be edited in their Overview, including their title, request, starting point and delivery choices. **Queue for work** is a separate, explicit action after review. A queued task that has never started can return to Backlog. Holding a queued task remains separate from reviewing a backlog task.

Starts next and the free-slot previews omit held tasks and tasks waiting for dependencies to land. A finished shared task can still block a dependent while one of its deliveries is unfinished.

The run state is written on the card, never shown by dimming it:

### Working

A soft pulsing dot and the current item of the agent's own to-do list. Reading, searching and running commands never replace it. Tools that share no to-do list fall back to their latest action. When several reviewers or voters work at once, the card keeps one agent's summary, switching to whoever needs your answer while they wait.

### Needs you

These cards sit under the Needs you heading with an amber edge, and their status line says what they wait for ("Waiting for your permission"). They carry no extra badge.

### On hold, Paused, Waiting for a slot, Waiting for the screen, Failed, Awaiting merge, Completed, Cancelled

Said in words at the top of the card. Held cards sit on a quieter surface; failed ones get a red edge.

### Waiting for the screen

The status line says "Needs the screen for: …" in the agent's words, and an always-visible **Allow now** sits on the card. Once allowed, while another agent is on the screen, it says "Waiting its turn on the screen", with no button.

### The queue

- Drag cards to reorder. ⌥↑ / ⌥↓ moves the focused card. "Move to top" is a card shortcut.
- The cards that start as soon as a slot frees say **Starts next**.

### Hold

Keeps a task in the queue without starting it ("not yet"). It is in the card's More menu and the task sheet.

- New tasks go to the bottom by default; the new-task dialog offers "Top".

### Card

```
┌────────────────────────────────────────────┐
│ ● Shop                                     │  product
│ Guest checkout                             │  title, semibold, wraps
│ ● Connecting guest checkout                │  current to-do item, wraps
│ ✓ ✓ ✓ ◉ Build ○ ○                          │  its own pipeline: done steps checked, the current one named
│ 🔨 Builder  Opus 5.5  ◷ 19m  Round 2  ✉ ⏸ … │  agent, model (quiet), time, rounds · shortcuts
└────────────────────────────────────────────┘
```

- The main line is one plain-text summary, wrapping so its words stay readable. To-do items have formatting removed and at most about 100 characters. When the task needs you, waits for a slot, is paused, stuck, cancelled or delivered, it says that first instead of the to-do item. The Agents page uses the same main line. Without a to-do list, an architect following your call keeps saying so; its tool activity stays in the sheet.
- What comes next is shown in the task’s Overview, under Right now. Cards show no Next line or popup.

- The pipeline comes from the task's plan, for example Plan, Design, Your check, Build, Review, Ship. Stages the plan does not have are absent. Hovering or focusing any step names it in a small tooltip ("Plan, done", "Build, now", "Review, next"), so the whole pipeline is readable without opening the task. The strip is one tab stop; the arrow keys move between its steps. It always fits on one line: on long plans (seven steps or more) the gaps tighten and the finished steps fold into one check with a count ("✓ 4", named in its tooltip: "Plan, Research, Design and Screens, done"); a very long plan also folds its furthest steps into "+N". The task sheet lists every step by name too.
- Delivery shows in the footer in words: "Pull request #237 · awaiting merge", "Released v1.4.0", "Delivered locally to main".
- Shortcuts (Message, Pause or Resume, Move to top, and More: Open, Join the session, Hold, Cancel) appear on hover and on keyboard focus, in space the footer always keeps for them, so nothing moves or gets covered.

A task taking a slot leaves the queue immediately, before its working copy is ready or its planner speaks: no queue number, drag handle, queue count or next-up entry remains. The card's Plan step is current, its planner is named, and the Products page counts it under Plan. Resumed tasks show their own current step immediately too.

- The queue and the pool stay global: priority is across products, because the pool of agents is shared.
- Cards always carry their product, so an all-products board stays readable.

### Combining small backlog tasks

Backlog offers **Select tasks**, then **Combine and queue** for two to twenty small requests. The confirmation shows every original request and lets the coordinator name the combined task. Compatible product, starting-point and delivery choices are preserved, as are the stricter plan and shipping approvals. Conflicting choices, long requests or unresolved dependencies explain what must be resolved first. Originals move to History as combined requests with a link to the replacement; the combined task links back, includes every request and picture, and runs one plan and review flow. Nothing is combined merely by selecting cards.

## History

History sits directly below Board in the rail. It shows a grid of completed and cancelled tasks, newest first, with product, title, finish date and delivery outcome. There is no Done section on Board. The product switcher scopes History without leaving the page; its search matches the beginnings of words in task titles. Search and product changes return to the newest matching page.

The command palette also searches finished task titles, returning at most 40 task matches across live and finished work. Matching products offer **Finished tasks in [product]** to open scoped History without loading the product’s entire archive.

Only 24 task summaries are loaded per page. Previous and Next move through indexed pages without downloading older conversations or plans. Opening a task fetches its full details once and shows the same task workspace, with the current History page in its left task list. Closing returns to the same product, search and page. Task and selected-node links keep that return point across refreshes and browser navigation. A directly bookmarked older page can return to the newest page even when there is no previous-page trail.
