# Petrina UX

How Petrina should feel. Architecture and engine contracts live in [design.md](design.md).

## Who it is for

**The Coordinator.** A builder or product person who launches and maintains products. They think in outcomes ("guests can check out without an account"), not in files. They run a squad of AI agents the way a lead runs a small team:

- they drop tasks in and put them in order,
- the squad works on its own, as many agents at once as they allow,
- agents come back when they need a decision, a permission or an opinion,
- they unblock, nudge, and ship.

They do not read code. Code lives in the pull request on GitHub, one click away for whoever wants it.

What success feels like: many pull requests a day, little time spent being the thing everyone waits on.

Confirmed unrelated review bugs appear in Backlog for coordinator review. Their source finding says “Tracked in” with a link to the follow-up; the follow-up links back to the original finding and keeps its reproduction and evidence. A report that cannot yet be matched says why it is not tracked. Opening either link stays within the task view, and nothing queues the follow-up automatically.

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
| Squad | The roles available: Planner, Architect, Builder, Reviewer…, and any you add |
| Agent | A role running on a tool, model and effort, working one stage of one task |
| Plan | The stages the planner proposes for a task |
| Inbox | Everything waiting on you |

## Layout

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ ◆ Petrina  All products ▾  ⌕ Search ⌘K   Blocking 2  ■■■□ 3/4  Inbox 4  + New task   │
├──────────┬──────────────────────────────────────────────────────────┬────────────────┤
│ Board    │ Needs you 4                                              │ Needs you 4    │
│ History  │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │ ┌────────────┐ │
│ Agents   │ │ Shop     │ │ Notes    │ │ …        │ │ …        │      │ │ Question   │ │
│ Library  │ └──────────┘ └──────────┘ └──────────┘ └──────────┘      │ └────────────┘ │
│          │ Working 1 · Waiting · Queue 4 · Backlog 2                 │                │
└──────────┴──────────────────────────────────────────────────────────┴────────────────┘
```

- **Top bar** (56px): product switcher, search (⌘K), the pool indicator, the inbox button with its count, and **New task**, the only solid violet button in the workspace. It stays quiet, with neutral buttons and a thin bottom divider. While screen use is on, or an agent is on the screen, a small screen icon shows on the pool button (see [The screen](#the-screen)).
- **Left rail** (64px): Board, History, Products, Agents, Analytics, Library, and Settings at the bottom. Icons with labels, a right-hand divider and a separate Settings footer.
- **Main area:** the board by default, with no extra page-title row. Other pages keep their descriptions and controls without repeating their name above them.
- **Right panel** (360px): the inbox. It can be hidden (I) and opened again from the top bar.
- **A task** opens a three-column workspace: a compact scrolling task list, a wider flow canvas, and a separately scrolling details panel. Selecting another task keeps this workspace open. Selecting a flow step opens its details on the right; the task information is shown initially. Overview, Plan, Design, Review and Session keep the full task information accessible. The canvas scrolls, pans and zooms, with controls to fit the whole flow or return to now. Narrow windows and 200% zoom offer Tasks, Flow and Details views of the same workspace.

### Navigation

Pages have addresses: `/` for Board, `/products`, `/agents`, `/analytics`, `/library` and `/settings`. Product settings open at `/products/:id/settings`; older `/settings/products/:id` bookmarks still work. Task workspaces open at `/tasks/:id`, with `/plan`, `/design`, `/review` or `/session` for their tabs. Selecting a flow node adds `?node=:id` to its task address. Refresh and Back/Forward restore the selected node and bring it into view; deselecting it clears the parameter. Product scope stays in the address, as does the page a task was opened from. Direct links, refresh and browser Back/Forward restore the same location. Navigation links support opening in a new tab. Demo parameters stay on every link. Missing pages and removed tasks show an unavailable link with a way back to Board. Drafts and temporary dialogs stay in the current window.

### Reaching the engine

In a browser, a lost connection shows Reconnecting. After about three seconds a slim line below the top bar says: "Can't reach the Petrina engine. In a terminal, run `bun run engine` and leave it running, then run `bun run open` in another terminal." The commands are easy to select and copy. The line disappears on reconnect, never flashes during shorter blips, and never appears in the demo.

If the engine answers but refuses this window's old key, it says instead: "The Petrina engine restarted. Run `bun run open` for a fresh window, then close this one." Restarts normally keep the key; this covers a changed key too. If the window cannot tell, it uses the first message. The desktop app starts and restarts its own engine, so it keeps its existing recovery message and **Try again**, without terminal instructions.

Starting a second engine prints one line: "Petrina's engine is already running. Open it with bun run open." It stops before opening task data and changes nothing on the board, using the same single-engine check as the desktop app.

### Window size

- The desktop window opens with 1680×1000 for the app itself, the title bar on top of that, centred and never larger than the screen's usable area: the whole window, title bar included, stays below the menu bar and clear of the Dock or taskbar, on whichever screen it opens. It can shrink to 1100×680, again not counting the title bar. On a screen smaller than that it opens at the minimum in the top-left corner of the usable area, so the title bar is always reachable.
- Narrower windows show fewer cards per row; the board itself never scrolls sideways. Wide tables, like the Products page, scroll sideways instead of squeezing.
- As the window narrows, the top bar gives things up in order: the wordmark and repeated wording first, then the search field becomes a button that opens it, then the pool shows only its count, then the pool and the theme move into a More menu. The screen icon moves with the pool onto the closed More button, with the same label. The product switcher, Inbox and New task always stay.
- Below 1200px of usable width the inbox opens over the board instead of beside it. Esc or the close button hides it and puts focus back on the Inbox button.
- Browser zoom and enlarged text count as a narrower window, so the same steps apply at 200%.

## Page contracts

Keep page-specific behavior in one place. Common typography, spacing, keyboard behavior and responsive rules remain below.

| Surface | Contract |
|---|---|
| [Board and History](ux/board-and-history.md) | Active groups, Backlog, queue order, cards and paginated finished work |
| [Task workspace and New task](ux/task-workspace.md) | Three aligned columns, chronological flow, node tabs, conversations and request editing |
| [Coordination](ux/coordination.md) | Pool, screen permission, inbox, answers and notifications |
| [Pages and settings](ux/pages-and-settings.md) | Products, Agents, Analytics, Library, preferences and first run |

Implementation details and regression examples belong in the relevant feature tests. These contracts state what the coordinator can see and do.

## Visual language

- Six looks, three light and three dark: Ink, Clay, Tide, Midnight, Ember and Fathom. Each sets its surfaces, accent, type, corners and spacing. Light looks stay light and dark looks stay dark. Semantic colours stay the same in every look: running blue, needs-you amber, done green, failed red, queued slate. The accent stays a different hue from those, and from the gold of something that needs you.
- The accent is the one solid button, New task, and selection. Decisions lead with a dark button on a light look and a pale button on a dark look. Secondary actions are neutral surfaces or plain text. The choice is in the top bar (and in More when the window is narrow), at the top of Settings, and in the command palette.
- Fewer borders, pills and chips: states, counts and tool information are quiet text.
- Each role has an icon and a colour. Roles you add pick their own:

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

The sizes and line heights below are the same in every look. A look chooses the typeface, shipped with the app (the window only loads fonts from the app itself). Inter is the fallback. Large titles use the look's display face; card titles stay on the text face. Clay and Ember use a serif for those titles.

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

- A 4px grid, mostly 8, 12, 16, 24 and 32. A look sets its own card padding, the gap between cards, the board padding and the corner radius.
- The task sheet has 32px padding and 32px between reading sections (16px in narrow windows). The task workspace's outer corners follow the look.

### Contrast

- All enabled text is at least 4.5:1 against what it actually sits on, in every look, including hover. Field outlines, focus rings, the amber edge and other essential boundaries are at least 3:1, including a step's outline on the task flow. Field outlines are stronger than decorative separators. The flow's dots are fainter than those outlines.
- Keyboard focus is always visible.

## Keyboard

| Key | Action |
|---|---|
| ⌘K | Command palette |
| ⌘N | New task |
| ⌘, | Settings (Ctrl+, on Windows and Linux) |
| I / B / A / L | Inbox, Board, Agents, Library |
| J / K | Move between cards or inbox items |
| ↵ | Open |
| ⌥↑ / ⌥↓ | Raise or lower priority |
| P | Pause or resume |
| M | Message |
| ? | Every keyboard shortcut |
| Esc | Close the topmost thing only: palette, dialog, text field (keep its text), task, then leave the inbox. Focus goes back to where it was |
| Tab / ⇧Tab | Inside the task sheet or a dialog, stay inside it until it closes |

The top-bar search opens the same palette as ⌘K (Ctrl+K on Windows and Linux). Search checks every word against task titles and product names across the whole portfolio. The palette also opens products, creates a task draft, filters the board, pauses the pool, changes its limit and opens pages. A new task always opens the usual dialog for review before creating it.

Only one area takes single keys: the open task first, otherwise the inbox after entering it, otherwise the board while it is visible. Other pages rest the board's keys. J and K follow the displayed order, including filters and folded sections; an open task remembers whether it came from the board or inbox. Tasks opened elsewhere explain that there is no list to walk. Option+arrows move queued cards beside their visible neighbours, preserving hidden products' order.

P pauses or resumes; on queued tasks it holds or releases them. Products is in the palette and left menu. M opens Session and focuses the message box. Every task keeps its own unsent message while the app stays open, with a mark on the card and Session tab. Single keys rest while typing, and can be turned off in the palette or the shared Settings page. This choice survives restarting. Join session (⌘J) is not assigned yet.

## Edge cases

- **No tools installed:** first run stops at the tools check with the fix for each one.
- **Only one agent tool:** every step runs on it, reviews included, and first run says so.
- **A tool is not ready, logs out or won't start:** a "Stuck" inbox item names the tool, with its fix and Retry, which checks the tool again first. A tool that hangs as it starts counts as not starting after a minute. A tool that wouldn't start keeps its fix and what it said behind Details, even when its check passes again. The same for the GitHub CLI before a pull request or release ships.
- **A usage limit is hit:** the agent pauses with "Resumes at 14:00" and offers to switch tool.
- **Closing the app with agents running:** asks whether to keep running in the background or pause everything.
- **Two tasks touching the same area:** the planner warns ("Might overlap with Checkout revamp").
- **A stage runs too long:** a soft time limit per stage raises an inbox item.

## Later

- Epics: the planner splits a big ask into several tasks.
- Follow-ups on pull request comments.
- A Tester role that runs the app and attaches screenshots.
- Diagrams of what a change does.
- Phone notifications.
