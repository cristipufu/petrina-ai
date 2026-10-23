# Coordinating active work

Owns pool controls, screen requests, inbox, permissions and notifications. Back to [UX overview](../ux.md).

## The pool

How many agents may run at once.

- The top bar shows one square per slot, filled with the colour of the role in it: `■■■□ 3/4`.
- Clicking opens a popover:
  - a stepper for the limit (1 to 12),
  - caps per tool (for example Claude Code 3, Codex 2), so one subscription is not exhausted,
  - **Pause pool**: running agents finish, no new agent starts,
  - the list of who is in each slot,
  - **Agents may use the screen**: Off, For an hour or On (see [The screen](#the-screen)).
- Rules:
  - Taking a slot immediately records its agent and tool, so each tool's cap counts it before setup finishes.
  - Before every following agent, even on the same tool, the task checks the limits again. If other tasks fill its tool or the pool, or the pool is paused, it waits at its current step with a line such as "Waiting for a free Codex slot". It keeps its working copy and progress and continues ahead of queued tasks. Work already holding a slot keeps it when there is room.
  - A task at a checkpoint (waiting for your OK between stages) releases its slot.
  - An agent that asked you something mid-stage keeps its slot, and the slot turns amber. The top bar then says "You're blocking 1 agent", because the coordinator is the bottleneck and should know it.
  - Lowering the limit never stops a running agent. Each finishes, then its next agent waits until there is room, so the pool shrinks as agents finish.
- The **Agents** page is the same information large: one tile per slot with the live status line and a Join button.
- In the popover, under the slots, **Today**: the tokens and agent time used since local midnight across all products, the same split by tool with each tool's nearest limit when known (how much is used, when it resets and when that was reported; a limit drops out the moment its reset time passes, so an old percentage never shows as current), one line saying agent time adds up agents running at once, and a link to Analytics. With nothing yet today it says so in words.

## The screen

Agents work in the background while you use the computer. Some checks need the running app on screen: clicking through it, menus, the Dock, real window behaviour. The screen is something an agent asks for, and you decide.

### Agents may use the screen

Sits in the pool menu (in the More menu in narrow windows) with three choices: **Off** (the default), **For an hour** and **On**. A quiet line under it says what the choice means; For an hour says when it turns off ("On until 15:40"), and after that it is Off without anyone touching it. When an agent is on the screen it names the task and the role, and it says how many tasks are waiting for the screen. The choice is saved like the pool limit.

### The screen icon

While screen use is on, or an agent is on the screen, a small screen icon shows on the pool button, or on the closed More button in narrow windows. Its label says which of the two ("Agents may use the screen", "An agent is using the screen"), so screen use is never on without you seeing it. With the switch Off and nobody on the screen, nothing extra shows.

### Asking

Every agent except the Release Manager can ask, including Petrina's internal roles and reviewers working side by side. An agent does everything it can in the background first, then asks, with its reason. Allowed and free: it gets the screen at once and keeps its slot. Otherwise its task gives up its slot, moves to Waiting, and says "Waiting for the screen", with the reason and **Allow now** on the card, in the task sheet, at the end of the Session tab and as a quiet inbox item.

### Allowing

Allow now (for this request), switching to For an hour or On, or **Allow the screen for this task** in the task sheet's More menu (for any unfinished task, queued ones included) lets it continue. It picks up where it left off, and the timeline says it is using the screen. If the pool is full, it waits for a free slot as usual.

### One at a time

Only one agent uses the screen, first asked, first served, until its step ends. Others needing it wait their turn without a slot and without a button.

### Turning it off

Never stops the agent on the screen: it finishes its step, and the icon stays until then. Nobody new gets the screen; tasks only the switch allowed go back to waiting for your OK. A request you allowed with Allow now keeps its OK.

- Pausing or cancelling a task waiting for the screen removes its inbox item. Messages sent while it waits reach the agent when it continues.

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
| **Your call: checks still failing / checks unverified** | Unresolved checks, their original results and Builder answers; why work stopped | **Run checks again**, See original checks, Send back… with a note. Rerunning requests a fresh execution without approving delivery. Real failures and incomplete verification stay distinct when both occur |
| **Stuck** | A stage failed, or a tool needs you to log in | **Try again**, See what happened, Cancel task |
| **Screen** | "Needs the screen for: Click the menu bar icon and check the quick note window opens in front" | Allow now. Quiet: listed after every other item, no notification or toast, never counted in "You're blocking" |

A Stuck item recorded for a missing tool follows a later Couldn't check answer: its explanation says the latest check couldn't run, Petrina can't confirm the tool is missing, and Retry carries on. Details shows the latest reason, with no install command. A later Ready answer still says the tool is ready now. The stored heading and task card keep naming the original failure until Retry. Items for a tool that wouldn't start or was logged out keep their existing advice.

Every agent is told: when you ask the coordinator a question with choices, put the answer you recommend first. The demo squad does the same, and keeps every answer in its order.

### Permissions

Agents start with full permissions inside their own working copy, so they rarely need to ask. Petrina relies on each tool's own safety checker (Claude Code in Auto mode, Codex in Auto review) and does not read commands itself. When a tool's checker flags something, its request comes to the inbox unchanged:

### Allow

Lets it go ahead this once. **Deny** blocks it.

- Nothing is remembered: the next request asks again, in any task and any product. Petrina never picks a tool's own "always" option.
- Because nothing is remembered, there is no list of saved permissions in the app. Seeing and removing remembered permissions is not available yet; if remembering ever comes back, it belongs to Product settings and board papercuts.
- Plan, design and delivery checks are the engine's gates, not permissions: an agent cannot skip them, and only Petrina itself ever delivers. The only agent at delivery is the Release Manager, which writes a release's notes across everything since the previous release; pull requests and commits to main need none.

### Notifications

When something new lands in the inbox and you are not looking at Petrina, you get a notification: system notifications in the desktop app, the browser's own in a browser tab once you allow them. They only arrive while Petrina (or its tab) is open; minimized is fine.

### What notifies

A question, a permission request, a stuck task, a task waiting at a checkpoint (plan, design, disagreement, ready to ship), and a delivery Petrina could not confirm. A screen request never notifies: it waits quietly in the inbox.

### Only what is new

Items already waiting when the app opens only show in the counts. After the connection to the engine drops and comes back, only what arrived during the gap notifies. No item notifies twice.

### In front or away

While Petrina is in front (its window focused, or its tab visible and focused), the small in-app message appears instead; its View button does exactly what a click on the notification does. A Petrina window visible on a second screen without focus counts as away.

### Calm pacing

At most one notification every ten seconds. The first goes out at once. What arrives during the pause goes out when it ends: one item on its own, two or more as one summary ("3 more things need you", naming up to two of their tasks). Held items that were handled meanwhile, or that you saw because Petrina came to the front, are dropped; if none are left, nothing goes out.

### Nothing shown is taken back

On macOS and Windows a notification for an item already handled stays in the system's list until you clear it; clicking it shows "Already handled". In a browser a notification closes once its item is handled, and a summary once all of its items are.

### Wording

Plain words: what is needed, who is asking, for which task and product. "Builder needs your permission", then "Add a new package: Stripe.js" and "Guest checkout, Shop". Who is asking is the agent's role when the item records one, otherwise Petrina ("Petrina: Guest checkout is stuck"); never an agent the item does not record, never blank.

Questions are shortened, and every web address in them becomes "a link": with or without http or www (example.com), this machine (localhost:3000), local names and IP addresses (192.168.1.20, [::1]:5173). Email addresses become "an email address". File names and code keep their words (README.md, setup.py, node.js, item.id).

A notification never contains the command behind a permission, the error of a stuck task, or any link: those stay in the app, since notifications can show on the lock screen and in the system's history.

### Clicking one

Brings Petrina to the front (restored if minimized), opens the inbox if it is hidden, scrolls to the item, highlights it and moves keyboard focus to it, and briefly highlights its task card when the board shows it. The page and the product filter stay as they are; menus and pop-overs close. An item already handled (here, in another window, or because its task was cancelled) opens the inbox with a short "Already handled" note, and nothing else changes.

### Nothing typed is lost

If New task, Add product, or a task sheet with an unsent message or note is open, it stays open with everything typed in it. A line at its top names what is waiting ("Builder needs your permission. Guest checkout") and says it opens when you are done. As soon as that window closes, finished or cancelled, the inbox opens at the item. A later click replaces an earlier one. A task sheet with nothing typed closes at once, so the item is in view.

### Never a guess

A summary, or a click the system does not trace to one notification, opens the inbox with nothing selected. macOS reports clicks on screen and from Notification Center. Windows reports a click only while the notification is on screen; from the notification list it opens Petrina again, which brings the running one forward with the inbox open and nothing selected (once Petrina has sent a notification in that run).

### One Petrina

Opening Petrina while it runs, by hand or by the system for a notification, brings the running one to the front. There is never a second window.

### Counts

The Dock badge (macOS), a small number drawn over the taskbar button (Windows), or the launcher's badge (Linux desktops that show one) has the same number as the Inbox button, disappears at zero, and keeps working with notifications switched off. In a browser the tab's title starts with it: "(3) Petrina".

### On or off

In Settings: on by default in the desktop app, off in a browser until you turn them on, which asks the browser for permission. In a browser the inbox panel also offers it once; the offer never comes back after it is answered or dismissed, and never shows in the desktop app. With the switch off nothing goes to the system or the browser; in-app messages and counts still work. The desktop app and each browser remember their own choice.

### The demo

Never sends notifications or sets the icon's count. Its in-app messages work, and so does the test.

- If the desktop app and a browser tab are both open with notifications on, each notifies.
- Later: an optional sound, quiet hours, and keeping Petrina alive in the background after its window closes.
