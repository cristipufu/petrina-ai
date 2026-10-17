# Petrina design

How Petrina works inside. The user-facing side is in [ux.md](ux.md).

## Goals

- Run a squad of local coding agents on a product's GitHub repository, many tasks at once, with roles as first-class objects.
- Never show code in the app. Every stage hands back plain-language results.
- Make adding a tool, a model or a role cheap: usually configuration, rarely code.
- Run entirely on the user's machine with the tools they are already logged into. No API keys, no Petrina server, no telemetry.
- Never merge a pull request.

## What Petrina does better than the tools around it

Competitive research (October 2026) found the building blocks in other tools, but nobody combines them:

1. **A planner composes each task's plan from roles,** choosing tool, model and effort per stage, shown as an editable plan before anything runs.
2. **Roles are separate from tools:** instructions, permissions, what they see, and what they must hand back.
3. **Design convergence:** two architects on different tools iterate until no blocking objection is open, with a disagreement log and a round limit.
4. **Reviews that converge:** reviewers on different tools, each seeing earlier verdicts (never the builder's transcript); Petrina's own checks as evidence; Important findings verified on another tool before they send work back; and review depth and the delivery check set by the task's risk.
5. **A light, live board** instead of an IDE.

Mechanics borrowed and credited:

- A stage finishes on a structured result, never on a model saying it is done (bmad-loop).
- Stage kinds with loops, caps and approval gates (Archon).
- Reviewers in fresh sessions, told to prove "done" wrong; pass/fail findings with file:line, never scores; a mechanical tamper check for deleted or skipped tests (no_human).
- One generic agent protocol for many tools (Kandev).
- From "Solving code review at Anthropic": checks the agent cannot talk its way past, findings tagged Important, Nit or Pre-existing, a finding verified before it counts, every finding answered, convergence rules (no repeats, whole classes of bug, diff-only re-review, a step back after three rounds), approval by risk set from the change, an approval that covers one commit, a per-repository REVIEW.md that learns from misses, and measuring rounds to pass.

## Concepts

| Concept | What it is |
|---|---|
| **Product** | A GitHub repository and its local clone |
| **Task** | What the coordinator wants. Has a priority (its place in the queue) |
| **Role** | Data: name, purpose, permissions, what it sees, and whether only Petrina runs it (internal: the planner never hears of it) |
| **Role contract** | What a role is told, which parts of the context it reads, and the result it must hand back (`packages/engine/src/roles.ts`) |
| **Agent profile** | Tool × model × effort, for example Claude Code · Opus 5.5 · high |
| **Tool** | Something that can run an agent. Usually an ACP command line |
| **Plan** | Ordered stages. Each stage: kind, role, profiles, round limit, checkpoint |
| **Stage run** | One execution of a stage: rounds, agent sessions, events, result |
| **Inbox item** | Anything waiting on the coordinator |
| **Product checks** | The commands that prove a product works (type check, lint, tests, build), run by Petrina itself |
| **Review guide** | `REVIEW.md` in the repository, plus points the coordinator accepted after a miss |
| **Risk** | Low, Medium or High, rated by the planner from what the task touches |

### Stage kinds

| Kind | Behaviour |
|---|---|
| `do` | One role on one profile produces its result |
| `converge` | Author and reviewer (different profiles) alternate until the reviewer has no open blocking objection, or the round limit is reached and the coordinator decides |
| `review-chain` | Petrina's tamper check and the product's checks first, then reviewers one after another on the same change, then Important findings verified on another tool. Important findings send the change back to the builder as one list, then the chain runs again on what changed, up to the round limit |
| `gate` | Waits for the coordinator (design approval, delivery approval) |

### Task lifecycle

```
queued → planning → designing → building → reviewing → ready → done
            │            │            │           │        │
            └──── any stage can be: running · needs-you · paused · failed
```

The stage column (planning, designing, building…) is derived from the role of the current stage; the Products page counts tasks by it. The board itself is one grid of cards grouped by what each task needs (needs you, working, waiting, queue, done), and every card shows its own pipeline from its plan: done steps checked, the current one named, stages the plan does not have left out (`packages/core/src/board.ts`).

## Tools: ACP first

Petrina talks to agents through the [Agent Client Protocol](https://agentclientprotocol.com) (ACP). Both main tools have maintained ACP adapters:

| Tool | ACP adapter |
|---|---|
| Claude Code | `agentclientprotocol/claude-agent-acp` (Claude Agent SDK) |
| Codex | `agentclientprotocol/codex-acp` (Codex App Server) |
| Others | Any agent that speaks ACP: Gemini CLI, OpenCode, and more as they add it |

ACP gives Petrina what it needs without per-tool code:

| Need | ACP |
|---|---|
| Start a session in a working copy | `session/new` with `cwd` and the MCP servers to attach |
| Send a message | `session/prompt` (one turn at a time, which is what makes queued messages natural) |
| Interrupt | `session/cancel` |
| Live activity for the status line | `session/update` notifications (messages, tool calls, plans) |
| Permission prompts | `session/request_permission`, sent only when the tool's own safety check flags something; the coordinator answers |
| Pick up after a restart | `session/resume`, or `session/load` (which replays the conversation) when that is all the agent offers |

So a tool is mostly configuration:

```json
{
  "id": "codex",
  "name": "Codex",
  "command": ["npx", "-y", "@agentclientprotocol/codex-acp"],
  "models": ["…"],
  "efforts": ["low", "medium", "high", "xhigh"]
}
```

A dedicated adapter is written only when a tool needs something ACP does not expose (for example reading usage limits). Things to verify per tool before relying on them: model and effort selection through ACP, use of the user's existing login, and `session/resume` or `session/load` support.

## Results and questions

An agent hands back its result as one fenced `petrina` block of JSON at the end of its last message, in the shape its role contract shows it. A stage finishes only when that block parses and passes the role's schema; otherwise the agent is told exactly what is wrong, twice at most. An agent that cannot go on without a decision ends with a `needsInput` block instead: the question goes to the inbox, and the answer comes back to the same conversation. The status line comes from the agent's own plan and tool activity over ACP. Agents get no extra MCP servers.

## Permissions

Petrina relies on each tool's own safety checker instead of building one:

| Tool | Mode | Who decides |
|---|---|---|
| Claude Code | Auto | Claude Code's classifier allows or blocks each action |
| Codex | Auto review | Codex's reviewer approves, inside Codex's own workspace sandbox |

- Petrina reads no commands. When a tool's checker flags something and asks, the question goes to the inbox unchanged, with the exact command or paths, and the coordinator allows or denies it once.
- Petrina never picks a tool's "always" option: those write settings into the working copy or switch modes.
- Nothing is remembered: every request is allowed or denied once, in the inbox or the session, with the same wording and buttons in both. There are no remembered rules per product or permission controls in product settings.
- If a tool's automatic mode is not available for a model, the session log says so and that tool asks before acting.
- Approval gates and round limits are enforced by the engine, never by prompting a model to stop.

## Messages to a running agent

- Messages queue per task. When the agent's current turn ends, the next queued message is sent with `session/prompt`.
- Interrupt sends `session/cancel`, then the message.
- Every delivered message and reply is written to the session transcript the Session tab shows.

## Checks, reviews and risk

- **Product checks.** The Check finder (an internal role) works out once per product, from its CI first, which commands prove it works; it looks again when the CI or build files change. The coordinator can set them by hand. Petrina runs them itself, side by side, as argument arrays without a shell, before the first reviewer of every round and again right before the delivery check when the code changed (`packages/engine/src/checks.ts`, `product-checks.ts`). A failing check is an Important finding with the real output, and the work goes straight back to the builder. The builder is told to run every check in full before it hands back; reviewers read Petrina's results instead of running the suite again.
- **Findings.** Reviewers tag each finding Important, Nit or Pre-existing (a follow-up that never blocks), report a whole class of bug once, and never repeat a finding; Petrina drops repeats itself. From round two they review only what changed since the last round, and after round three the builder is asked to step back and reconsider. Before an Important finding sends work back, a fresh agent on another tool (the Verifier) checks it, unless a reviewer on another tool already confirmed it, and can mark it real, not a bug, a nit or pre-existing. In a fix round the builder answers every finding by id. Summaries start with a count, or say "Nothing to fix".
- **Risk.** The planner rates every task Low, Medium or High from what it touches; unrated work counts as Medium. High-risk work gets a Security review on a tool other than the builder's. Where a product opts in, low-risk work with passing checks and nothing Important open ships without the delivery check. An approval covers one commit: if the work changes before the shipper starts, the coordinator is asked again.
- **Review guide.** Reviewers, the Verifier and the builder read `REVIEW.md` as the base branch has it (never as the change has it), plus points the coordinator accepted. When the coordinator sends back a delivery every reviewer passed, the Guide keeper proposes one point; accepted, reviewers check it from their next turn, and it is committed to `REVIEW.md` on the branch that ships.
- **Measuring.** The Agents page shows how reviews are going: rounds to pass, what became of each finding, deliveries sent back, and how each reviewer profile's Important findings held up (`packages/core/src/reviews.ts`).

## Scheduling

- The queue is an ordered list. Priority is position.
- A pool limit caps running agents, with optional caps per tool.
- Taking a slot records the next agent and its profile (and therefore its tool) at the same moment, before working-copy setup or agent I/O. The card shows the correct step immediately; a new task shows Plan with its planner.
- Before every new agent, including the same tool, a new design/review round or a new stage, check the pool and tool limits again, excluding this task's old slot. Keep the slot if there is room; otherwise release it and wait at the current step, keeping the working copy and progress. The status names the busy tool, a full pool, or a paused pool.
- A task waiting at a gate releases its slot. An agent waiting on a mid-stage question keeps it and is shown as waiting on the coordinator.
- When a slot frees, work already in progress continues first, then the first queued task that is not held and whose next tool is under its cap.
- Lowering a limit never stops a running agent. Each finishes, and its successor waits if the other tasks still fill the new limit. Pausing the pool also holds tasks between agents.

The scheduler is a pure function in `@petrina/core` (`pickStarts`), tested without any I/O.

## Working copies

- Each task gets a git worktree in Petrina's data folder (not inside the repository), on a branch named `petrina/<task-slug>`.
- Slugs are generated by Petrina from a strict allowlist (`[a-z0-9-]`), never from raw task text.
- Processes are started with argument arrays, never through a shell.
- The pull request is opened with the coordinator's `gh` login at the delivery gate. Petrina never merges.

## Architecture

```
apps/desktop            Tauri 2 shell + React UI
  src/                  UI (board, inbox, task sheet, session, agents, library, settings)
  src-tauri/            Rust host: starts the engine, notifications, single instance
packages/core           Domain model, scheduler, the flow rules, review numbers, demo simulator
packages/engine         The engine process (Bun): agents over ACP, git, SQLite, the local API
docs/                   This document and the UX notes
```

Inside the engine, `Engine` (`engine.ts`) is a thin front with the coordinator's commands. Each part of the work is a module of its own, sharing state and bookkeeping (lookups, the timeline, the inbox, saving) through the kernel (`kernel.ts`):

| Module | Owns |
|---|---|
| `driver.ts` | Scheduling, the task loop, checkpoints, recovery after a restart |
| `planning.ts`, `design.ts`, `work.ts`, `review.ts` | The stage kinds: plan, converge, do, review chain with verification |
| `turn.ts` | One agent working one step: its conversation, instructions, result and questions |
| `roles.ts`, `context.ts`, `prompts.ts` | Role contracts, what each role is shown, and the prompt around them |
| `product-checks.ts`, `checks.ts` | The product's checks and running them |
| `guide-keeper.ts`, `guide.ts` | The review guide |
| `shipping.ts` | Delivery, never repeated blindly, and pull request polling |
| `take-over.ts`, `terminal.ts` | Take over in the terminal |

Adding a role is one entry in `roles.ts` (and its data in `@petrina/core`'s library); a role the coordinator makes, with no entry, is told its purpose and hands back notes. The rules a task's run follows (board column, checkpoint wording, where a request for changes goes, how rounds end) live in `@petrina/core`'s `flow.ts`, shared by the engine and the demo simulator.

- **Rust is a thin host.** It starts the engine, passes the engine's address and key to the window, and stops the engine it started when the app quits. It also shows the window's notifications, sets the count on the Dock or taskbar icon, and keeps Petrina to one running copy, with Tauri's own notification and single-instance plugins. The window gets none of those plugins' commands: only the shell's own three (the engine's details, show a notification, set the count), each refused to any window but the main one. No web client, no other plugins.
- **TypeScript holds everything domain-specific:** roles, plans, the scheduler, the engine, ACP handling, worktrees, SQLite, and the UI.
- `@petrina/core` never imports Tauri. It talks to a host interface, so the whole engine runs under Node in tests with fake agents.
- **State** is one snapshot in SQLite, saved shortly after every change and at once for anything the coordinator says. The UI and the engine read the same state, so tasks pick up where they left off after a restart.

## The engine process

The engine is one Bun process per Petrina folder (`~/.petrina`, or `PETRINA_HOME`).

- **One engine per folder.** The engine holds an exclusive SQLite transaction on `engine.lock` for as long as it runs; the operating system releases it the moment the process ends, crash included. A second engine finds it through the lock, or through `engine.json` for an engine started before the lock existed, and refuses ("already running"), or in app mode steps aside and hands over the running engine's address. The engine decides this, not the shell.
- **App mode.** The desktop shell starts `cli.ts app` with its stdin and stdout as a private line. The engine picks a free port, writes `engine.json` for scripts, and says it is ready in one JSON line on stdout; that line, with the key, never goes to a log. Everything else the engine prints goes to `engine.log`, written only by the engine that holds the folder. When stdin closes (the app quit, crashed or was force-quit) the engine stops its agents the way pausing does, saves, removes `engine.json` and exits; the shell forces it after 8 seconds. An engine the app did not start is left alone. Started from the Dock, the engine asks the login shell for the PATH the terminal has.
- **The key.** The window asks the shell for the address and key through a Tauri command that only the main window may call (`capabilities/default.json`), keeps them in memory, and presents the key as a WebSocket subprotocol when the connection opens. The engine refuses any request with the key in its address, a wrong or missing key, and pages that are not Petrina's own.
- **Restarts are safe.** Everything the coordinator says during a step (messages, answers, the note with a "No", the change request that started the step) is saved before any agent sees it, and kept on the task until the step hands back its result. An agent that starts the step again gets all of it, in order, in its opening instructions. The window keeps what it sent until the engine confirms it, and sends it again after reconnecting, with an id so a resend counts once.
- **Agents pick up where they left off.** The moment an agent's conversation opens, the engine saves a note of it on the task: the step (stage, design round, reviewer position), the role, the tool and model, the conversation's id, and the working copy's commit when the step first started. The note goes when the step finishes or fails, or the coordinator pauses, cancels or asks for changes; stopping Petrina keeps it. After a restart, a step whose note matches its step, role, tool and model reopens that conversation in the same working copy, with resume, or load when that is all the tool offers (what load replays is not shown again). Model, effort and the automatic safety mode are set again, mode last, and the GitHub login rules are the same as for a new conversation. The agent gets one line (Petrina restarted, the stage, the last thing it was doing, check the working copy and continue), then only what it has not heard: the answer to its open question and messages still in line. The timeline says "Picked up where it left off". When the conversation cannot be reopened (the tool cannot, it is gone, an error, or no answer within a minute), a fresh one starts with the usual opening instructions plus where it was: the stage and role, its last 10 activities in the step, and up to 30 files added, changed or removed since the step started. The timeline says "Started this step again" with the reason. A question open at the restart stays in the inbox without holding a slot, and its answer goes to the conversation that asked it, once; an open permission request is dropped with a note, and the agent asks again if it still needs to. A read-only role's clean-up goes back to the commit from when the step first started. The shipper never reopens a conversation, and pausing, resuming and "Try again" start the step fresh.
- **Shipping is never repeated blindly.** Before the shipper gets any work, the engine saves that shipping started, with the branch's head, where main was and the latest release. If shipping is interrupted (a quit, a crash, a pause, a failed attempt), the next run looks for the delivery first: a pull request for the branch, the work on the default branch, or a release published since shipping started that contains it. It asks GitHub about the product's own repository, from outside the working copy, so a remote an agent rewrote cannot fake a delivery. Found: it is recorded. Not found, half done, or GitHub unreachable: the coordinator decides ("Check again", "Ship it again", "Mark as done"), and a second shipper is told what the first one left behind.

## Take over in the terminal

The coordinator can drive a step's agent by hand, in their own terminal:

- **Take over.** Allowed while an agent other than the shipper works or waits on the coordinator, on Claude Code or Codex, in a conversation that already has its instructions (`takeOverBlock` in `@petrina/core`). Petrina checks it can open a terminal and that every value fits in a launcher, then stops the agent and waits for its process to exit. Open questions and permission requests go. An editing role's uncommitted work becomes one commit marked as its unfinished work; a read-only role's is undone. Petrina notes the commit the task is on, keeps the step's conversation note, and the step keeps its seat in the pool (it counts toward its tool's cap) with "You're driving" in the inbox. Pause, Cancel and the inbox actions wait for the hand back; a restart keeps all of it.
- **The launcher** (`packages/engine/src/terminal.ts`). One small script in `takeover/<task>/` in Petrina's folder (`0700`): `open.command` on macOS, `open.sh` on Linux, `open.ps1` on Windows. It starts the tool Petrina found on PATH in the working copy: `claude --resume <id> --model <model> --effort <effort> --permission-mode manual` (`default` when the installed copy's help does not list `manual`, as before Claude Code renamed it), or `codex resume <id> --model <model> -c model_reasoning_effort=<effort> --sandbox workspace-write --ask-for-approval on-request -c approvals_reviewer=user --no-daemon`. The adapters' conversation ids are the ids the apps reopen (the Claude Agent SDK's session id, Codex's thread id). Every value is checked against a strict pattern first (absolute paths without quotes, `$`, `;`, `&`, `|`, `%` or line breaks; a UUID; a model name; an effort; the permission mode), and nothing typed by a person or an agent goes in. The Windows launcher starts with a UTF-8 byte order mark, so Windows PowerShell reads accented folder names as written. Each copy of the launcher keeps a record (`run.<pid>`: its process id and start time) while it runs. Only one copy opens the tool: on macOS and Linux it takes a `lock` that appears holding its record in one step (a hard link), and one left by a copy that is gone is set aside; on Windows it holds the `lock` file open for itself, which the system lets go of when it ends. Every other copy, even one started at the same moment, says the tool is already open and stops. The copy that opened the tool writes `state=ended` when it exits, or when its window is closed. The terminal gets the coordinator's environment minus Petrina's own variables.
- **Terminals.** macOS: Terminal by default, iTerm2, Ghostty, WezTerm, Alacritty or kitty when installed (`open -a`). Windows: Windows Terminal, else a PowerShell window. Linux: `xdg-terminal-exec`, `x-terminal-emulator`, the desktop's own (GNOME, KDE, Xfce, MATE, LXDE), then common ones; none without a display. The coordinator's choice is kept in the state. Copying the command runs the same launcher.
- **Hand back.** Refused while any copy's record shows it running (pid alive with the same start time, so a reused number does not count); "anyway" only when Petrina cannot tell (no copy reported starting since the terminal was last opened, or a record can't be checked). Take over, Reopen terminal and Hand back run one at a time per task, and Reopen terminal clears the last session's end first, so an earlier "it has closed" never lets a hand back through while the terminal opens again. Refused when the working copy is off the task's branch or a merge, rebase, cherry-pick or revert is half done. What is left uncommitted becomes one commit marked as the coordinator's. The note (the agent's saved work, commits, up to 10 files, the coordinator's note) goes into the session, the timeline and the task's notes, and onto the conversation note, whose commit moves to the new head so a read-only role's clean-up keeps the hand changes. The launcher folder goes. The same driver starts at once: the step's conversation reopens and hears the note, or a fresh one gets its usual instructions plus the note.
- **Review after hand changes.** If files changed, the tamper check runs on the whole branch at once and the task is marked as having hand changes; the delivery check and the shipper never start while that mark is set, and it clears only when a review chain starts from its first reviewer. A chain still ahead covers the changes. Otherwise the chain being driven, or the last one behind, runs again from its first reviewer once the driven step finishes, without using up a round.
- **How it was checked.** macOS: by hand with the real Claude Code and Codex, in Terminal. Linux: Petrina's own launcher in every terminal it finds (the system default ones, Console, GNOME Terminal, Konsole, Xfce, MATE, LXTerminal, kitty, XTerm), on a virtual screen in a container. Windows: the `open.ps1` launcher run by PowerShell 7 in a container; Windows itself is not checked yet.

### Needs a real device: Windows

These do not block shipping. Run them once a Windows PC is available:

1. Take over a Claude Code agent and a Codex agent with Windows Terminal installed: a new Windows Terminal window opens in the task's working copy, on the agent's conversation with its history.
2. The same without Windows Terminal: a Windows PowerShell 5.1 window opens instead.
3. With an accented letter in the user's folder or the product's path (say `C:\Users\José`): the app still opens in the right folder.
4. Close the app: Petrina says it has closed, and Hand back works. Close the window with the app still open: the same.
5. Run the copied command twice at once, and click Reopen terminal while the app is open: only one copy of the app runs, and the other window says it is already open.
6. Claude Code and Codex installed through npm (`claude.cmd`, `codex.cmd`): the launcher starts them with every option intact.

## Security model

Agents start with full permissions inside their own working copy; the coordinator asked for that, and it keeps the squad fast. What stops them doing harm is layered, and it is important to know which layer is the boundary:

| Layer | What it guarantees |
|---|---|
| **The tools' own checkers** | Claude Code's Auto mode and Codex's Auto review decide what is safe to run; Codex also keeps its own workspace sandbox. Petrina does not second-guess them or re-implement them. |
| **Credentials** | Only a shipper delivering to GitHub (pull request or release) gets GitHub credentials and an SSH agent. Every other agent, and a shipper delivering locally, runs with no tokens, an empty gh config, git credential helpers reset and SSH for git disabled, so it has nothing to push or publish with. |
| **Petrina's own git steps** | Never run hooks or the file monitor, whatever an agent wrote into the repository's settings. Only fetching and GitHub lookups get credentials; everything that touches a working copy runs without them. |
| **Gates** | Plan, design and delivery checks live in the engine. No agent can skip them, and only the shipper runs after delivery approval. |
| **Read-only roles** | They run in the tool's automatic mode too, so they could change files: every change and commit they leave behind is undone when their stage ends, however it ends. What the coordinator changed while driving one is kept. |
| **Take over in the terminal** | Not a Petrina boundary: it is the coordinator acting with their own setup and logins, in the tool's normal mode with its usual prompts, where some actions may run without a prompt. Petrina adds no blocks there and does not change their GitHub access, connectors or plugins. It only keeps credentials, its engine key and its own variables out of the launcher, its command lines and the terminal, and makes sure delivery through Petrina still goes through review. |

Known limits: anything done in a take-over session (a push, a pull request, a connector action) happens for real without Petrina's review, and Petrina does not notice it; someone can also reopen the conversation by hand in another terminal after handing back, and Petrina only tracks the sessions it opened. A shipper delivering to GitHub holds the coordinator's login, so "never merge" rests on its instructions and its tool's checker until Petrina publishes deliveries itself. Credentials are kept out of agents' environment, not locked away. Agents run as the coordinator's user, so a GitHub login saved on disk or in the keychain is only as protected as the tools' checkers keep it.

## Security notes

- Agent output is untrusted. The UI renders it as text only (no HTML, no `dangerouslySetInnerHTML`). Links are opened only when they are `https://` and only through the host.
- Petrina runs each product's checks itself, outside the tools' safety checkers (see `AGENTS.md`). Reviews, the tamper check and the review guide compare against the base commit pinned when the working copy was made, never a ref an agent could move.
- Agents get the repository's content as context. Treat it as untrusted input to the model: approval gates and permission decisions are enforced in code, not by prompting.
- Every result from an agent is validated against a schema before it changes state. IDs coming from agents are validated before use.
- Round limits and time limits cap every loop.
- The window has a strict Content Security Policy and only the Tauri permissions it needs.
- CI uses read-only permissions and actions pinned to commit SHAs.

## Milestones

| Milestone | Scope |
|---|---|
| **M0** | Repository, docs, clickable UI on a simulated squad |
| **M1** | Engine on fake agents: plans, stage kinds, structured results, SQLite, worktrees |
| **M2** | ACP tools: Claude Code and Codex end to end, permissions, bridge, pull requests |
| **M3** | Planner, design convergence, review chain, tamper check, checkpoints |
| **M4** | More ACP agents, usage display, signed builds for macOS, Windows and Linux |
