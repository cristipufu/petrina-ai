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
4. **Reviews that converge:** reviewers on different tools looking at the change at once, each on its own (never seeing the builder's transcript); Petrina's own checks as evidence; fresh agents voting on Important findings before they send work back; and review depth and the delivery check set by the task's risk.
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
| **Review guide** | `REVIEW.md` in the repository, which `AGENTS.md` points every agent to; it grows with points the coordinator accepted after a miss |
| **Risk** | Low, Medium or High, rated by the planner from what the task touches |

### Stage kinds

| Kind | Behaviour |
|---|---|
| `do` | One role on one profile produces its result |
| `converge` | Author and reviewer (different profiles) alternate until the reviewer has no open blocking objection, or the round limit is reached and the coordinator decides |
| `review-chain` | Petrina's tamper check and the product's checks first, then every reviewer at once, each on its own, then fresh agents voting on Important findings. Important findings that stand send the change back to the builder as one list, then the review runs again on what changed, up to the round limit |
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

- **Product checks.** The Check finder (an internal role) works out once per product, from its CI first, which commands prove it works; it looks again when the CI or build files change. The coordinator can set them by hand. Petrina runs them itself, side by side, as argument arrays without a shell, before the first reviewer of every round and again right before the delivery check when the code changed (`packages/engine/src/checks.ts`, `product-checks.ts`). A failing check is an Important finding with the real output, and the work goes straight back to the builder. The builder is told to run every check in full before it hands back; reviewers read Petrina's results instead of running the suite again. A check only looks: whatever one changes in files git tracks is put back, so no formatter slips unreviewed changes into the work.
- **The repository's own commit hooks.** Petrina's own git steps never run hooks, so Petrina runs the hooks git would run when committing, as the repository has them (local `.git/hooks`, or `core.hooksPath` for husky, lefthook and the like), alongside the checks: the pre-commit hook with the task's whole change staged on top of where it started (the working copy's HEAD detached at the base for the run, and put back after, even across a restart), and the commit-msg hook on the task's one commit message. They run like the checks, with no GitHub login, and a failure goes back to the builder with the hook's output, so a hook that keeps internal names out of a public repository works as it does by hand. The builder is told the hooks exist and how to run them itself.
- **Findings.** Reviewers tag each finding Important, Nit or Pre-existing (a follow-up that never blocks), report a whole class of bug once, and never repeat a finding; Petrina drops repeats itself. From round two they review only what changed since the last round, and after round three the builder is asked to step back and reconsider. Every reviewer in a round looks at the change at the same time, blind to what the others find; the same finding from a reviewer on another tool backs it. An Important finding no second tool has backed goes to a vote: one fresh agent per tool (the Verifier) says real, not a bug, a nit or pre-existing, all at once. It stands when at least half the voters say it is real; otherwise the most common other verdict settles it. Each reviewer and voter works in a copy of the change of its own (a detached worktree of the task's commit, with nothing installed, deleted when it finishes), so a test one runs or a checkout one makes never disturbs another or the task's copy. Each holds a slot of its own and starts when the pool and its tool allow, so a small pool takes turns; what each hands back is saved as it arrives, so a restart only redoes the rest. A stage with a single reviewer runs it as one ordinary step, which can pick up its conversation after a restart or be taken over. In a fix round the builder answers every finding by id. Summaries start with a count, or say "Nothing to fix".
- **Risk.** The planner rates every task Low, Medium or High from what it touches; unrated work counts as Medium. High-risk work gets a Security review on a tool other than the builder's. Where a product opts in, low-risk work with passing checks and nothing Important open ships without the delivery check. An approval covers the change itself (git's patch-id), on top of whatever main is when it ships: main moving on underneath keeps it, but if the change reads differently on top of the latest main, or the work changed, the coordinator is asked again.
- **Review guide.** `REVIEW.md` at the repository root, reached the way every agent reaches project knowledge: `AGENTS.md`, which Claude Code and Codex load by themselves, has a short "Review guide" section pointing to it, so an agent Petrina starts and one the coordinator starts read the same guide. Petrina's reviewers are told to judge by the guide as the base branch has it: whatever the change itself writes into `REVIEW.md` or `AGENTS.md` is part of what they review, never a rule, since a change cannot set the rules it is judged by. When the coordinator sends back a delivery every reviewer passed, the Guide keeper proposes one point; accepted, that task's reviewers get it with the task, like the coordinator's notes, and it is committed to `REVIEW.md` on the branch that ships (the first one also adds the section to `AGENTS.md`).
- **Measuring.** The Agents page shows how reviews are going: rounds to pass, what became of each finding, deliveries sent back, and how each reviewer profile's Important findings held up (`packages/core/src/reviews.ts`).

## Scheduling

- The queue is an ordered list. Priority is position.
- A pool limit caps running agents, with optional caps per tool.
- Taking a slot records the next agent and its profile (and therefore its tool) at the same moment, before working-copy setup or agent I/O. The card shows the correct step immediately; a new task shows Plan with its planner.
- Before every new agent, including the same tool, a new design/review round or a new stage, check the pool and tool limits again, excluding this task's old slot. Keep the slot if there is room; otherwise release it and wait at the current step, keeping the working copy and progress. The status names the busy tool, a full pool, or a paused pool.
- A step where several agents work at once (a review round's reviewers, its voters) holds a slot for each of them: the first takes the task's own slot, and each other one starts only when a slot of its own is free under the pool limit and its tool's cap. One that cannot get a slot waits for the next round of scheduling, like any other agent.
- A task waiting at a gate releases its slot. An agent waiting on a mid-stage question keeps it and is shown as waiting on the coordinator.
- When a slot frees, work already in progress continues first, then the first queued task that is not held and whose next tool is under its cap.
- Lowering a limit never stops a running agent. Each finishes, and its successor waits if the other tasks still fill the new limit. Pausing the pool also holds tasks between agents.

The scheduler is a pure function in `@petrina/core` (`pickStarts`), tested without any I/O.

## Working copies

- Each task gets a git worktree in Petrina's data folder (not inside the repository), on a branch named `petrina/<task-slug>`.
- Slugs are generated by Petrina from a strict allowlist (`[a-z0-9-]`), never from raw task text.
- Processes are started with argument arrays, never through a shell.
- The shipper only gets a delivery ready, on the task branch. Petrina publishes it itself (see Delivery). Petrina never merges.

## Delivery

- After review, and the delivery check when the task asks for one, Petrina makes sure the work is still what was approved: an approval holds for the approved change (its fingerprint), delivery mode and destination, and anything else asks again. It brings the one commit up to date with the latest default branch (freshly fetched from GitHub for pull requests and releases; if that fetch fails, Petrina publishes nothing and waits for Retry) and runs the checks on it.
- Then the delivery gets ready. For a pull request the shipper writes only the title and description, and commits nothing. For a release Petrina works out the version (the latest release plus the product's bump, or the version files' own for a first release, or 0.1.0), and the shipper sets it in one version commit on top of the work and writes the release notes. "Commit to main" needs no shipper. Petrina reads only the product's main version files at their usual places: package.json and Cargo.toml at the top, and tauri.conf.json at the top or in src-tauri. Main version files that do not follow the latest release, or that Petrina cannot read, stop for the coordinator.
- Petrina checks the handoff: the working copy is on the task branch and the branch itself points at the handed-back commit (not a side branch or a copy on no branch), with nothing uncommitted; a pull request's branch has not moved; a release's version commit sits directly on the work, changes only version files, and every main version file that exists says exactly the new version (one Petrina cannot read does not pass); the text fits GitHub's limits. Anything wrong goes back to the shipper to fix; Petrina never commits for it. A release's checks run again on the version commit. Subfolders, lock files and other files are the reviewers' to check.
- "Failed" publishes nothing in any mode: the version change goes, and the task goes back to the builder, review and the delivery check with a blocking finding. After two failures Petrina stops and asks.
- Petrina then publishes the exact tested commit: it pushes the task branch (never over other work already there) and opens the pull request; or pushes the default branch and the new tag in one all-or-nothing push, refused if the tag exists, and creates the release on that tag, only once GitHub shows the tag at the tested commit (Retry and "Ship it again" included); or fast-forwards the local default branch, only if it is still where Petrina saw it. Meanwhile it holds git's own lock on the main copy's staging area, so the main copy cannot switch branches halfway; if it switched just before, Petrina refuses and changes nothing. If the default branch moved before a release or local delivery goes out, Petrina brings the work up to date again, runs the checks again and, for a release, has the version commit made again (three times at most). A pull request is not prepared again.
- Each step is saved before it starts, and each product's credentialed steps (fetches, pushes and gh) run one at a time. Pause and cancel are checked when a step actually starts, not when it joins the product's line. Before reporting success Petrina checks the result on GitHub or in the main clone. Interrupted deliveries go through the one check under "Shipping is never repeated blindly".
- Fetches and pushes go to the GitHub address saved when the product was added. For a product added before Petrina kept it, the first step that needs it shows the current address once and asks whether it is the product's; the answer is kept. After a "No", Petrina does nothing for that product that needs a login; "Commit to main" still works.

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
| `guide-keeper.ts`, `points.ts` | The review guide, and the files of points it shares with the learnings |
| `learnings.ts` | Lessons agents pass on, offered at the delivery check, written to AGENTS.md's Learnings section |
| `update.ts` | One commit per task, put on top of the latest main before the delivery check and before shipping |
| `shipping.ts` | Delivery, never repeated blindly, and pull request polling |
| `take-over.ts`, `terminal.ts` | Take over in the terminal |

Adding a role is one entry in `roles.ts` (and its data in `@petrina/core`'s library); a role the coordinator makes, with no entry, is told its purpose and hands back notes. The rules a task's run follows (board column, checkpoint wording, where a request for changes goes, how rounds end) live in `@petrina/core`'s `flow.ts`, shared by the engine and the demo simulator. Every command the window can send the engine is listed once, in `@petrina/core`'s `commands.ts`: the Engine implements them, the local API has one argument schema for each, and the window's two clients (the real engine's and the demo's) are built from the list, all held to it by the compiler.

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
- **Agents pick up where they left off.** The moment an agent's conversation opens, the engine saves a note of it on the task: the step (stage, design round, reviewer position), the role, the tool and model, the conversation's id, and the working copy's commit when the step first started. The note goes when the step finishes or fails, or the coordinator pauses, cancels or asks for changes; stopping Petrina keeps it. After a restart, a step whose note matches its step, role, tool and model reopens that conversation in the same working copy, with resume, or load when that is all the tool offers (what load replays is not shown again). Model, effort and the automatic safety mode are set again, mode last, and the agent's environment is the same as for a new conversation. The agent gets one line (Petrina restarted, the stage, the last thing it was doing, check the working copy and continue), then only what it has not heard: the answer to its open question and messages still in line. The timeline says "Picked up where it left off". When the conversation cannot be reopened (the tool cannot, it is gone, an error, or no answer within a minute), a fresh one starts with the usual opening instructions plus where it was: the stage and role, its last 10 activities in the step, and up to 30 files added, changed or removed since the step started. The timeline says "Started this step again" with the reason. A question open at the restart stays in the inbox without holding a slot, and its answer goes to the conversation that asked it, once; an open permission request is dropped with a note, and the agent asks again if it still needs to. A read-only role's clean-up goes back to the commit from when the step first started. The shipper never reopens a conversation, and pausing, resuming and "Try again" start the step fresh.
- **One commit per task, on top of the latest main.** After every build Petrina folds the branch into one commit on top of where it forked, under the builder's title in the repository's own style, so the repository's commit-message rules see what will land. Right before the delivery check, and again right before it gets the delivery ready, Petrina puts that commit on top of the latest default branch itself (from GitHub for pull requests and releases, the local branch for "Commit to main"), with `git merge-tree` and `commit-tree`, which never leave a working copy halfway through a rebase (`packages/engine/src/update.ts`). Clean: the checks run on the result, and the delivery check shows it. Overlapping: the working copy is put on main with the change applied, conflict markers and all, and the builder brings it up to date (it learns what main changed from its commits, ports the change, leaves no markers, runs every check); then the reviews look at the whole change again, with fresh rounds, before the delivery check. The shipper never rebases, merges or changes code; for a release it adds only the version commit. Petrina delivers the result itself, as a fast-forward, a pull request or a release.
- **Learnings in AGENTS.md.** The builder, reviewers and testers can pass on, with their results, what they learned about working in the repository (how to build or test it, a trap, an unwritten convention): one line each, at most three, never about the task itself. Petrina keeps them on the task, without repeats or lines AGENTS.md already has, and at the delivery check offers them in one inbox item, without holding anything up. Accepted ones join the "Learnings" section of AGENTS.md with the next delivery, in its one commit (`packages/engine/src/learnings.ts`). Petrina adds nothing to agents' prompts for this: Claude Code and Codex both load AGENTS.md by themselves, so a session Petrina starts and one the coordinator starts in the repository know the same things.
- **The builder keeps its conversation.** A fix round, or bringing work up to date, goes back to the builder's own conversation from its last step (same tool and model), so it keeps what it learned, compactions and all, and hears only its job now and where things stand. The round where it is asked to step back and rethink starts fresh on purpose. When the tool cannot reopen it, a fresh conversation gets what the builder reported last time.
- **Shipping is never repeated blindly.** The shipper only prepares; Petrina publishes, and saves each publishing step before it starts. One check runs before Petrina publishes, and again after any interruption (a quit, a crash, a pause, a failed step and its Retry, a cancel): it looks for the pull request from the task branch at the tested commit, the release on the saved tag at that commit, or the work on the local default branch. Releases published before this delivery started never count. It asks GitHub about the product's own repository, from outside the working copy, so a remote an agent rewrote cannot fake a delivery, and it first makes sure the login can see that repository: GitHub answers "not found" alike for a missing release and a repository the login cannot see. Found: it is recorded. Clearly not there: Petrina carries on with the saved step; pushing the same commit again overwrites nothing, and GitHub refuses a second open pull request for a branch, a second tag and a second release. GitHub unreachable, or something else there: Petrina publishes nothing more on its own and the coordinator decides ("Check again", "Ship it again", which gets it ready again and still runs the check, or "Mark as done"). A cancelled task stays cancelled, but what went out keeps its link; if GitHub cannot be asked then, Petrina asks again every minute and after a restart. A delivery saved by a Petrina from before this design, whose shipper published it itself, is never acted on by Petrina: no check, no update from GitHub, no preparation. The task shows "This delivery was interrupted before Petrina was updated: check GitHub, then choose", with "It went out (mark as done)" and "Ship it again" (a fresh delivery, from the delivery approval as the task sets it), and nothing happens until the coordinator picks one. Cancelling it keeps the note on the task.

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
| **Logins** | Agents act with the coordinator's own logins: they get the coordinator's normal environment with nothing stripped, so gh's login, git's credential helpers as configured, SSH, AWS (the aws CLI, `~/.aws` and its SSO caches), the Azure CLI (`~/.azure`) and Azure DevOps (`az devops`, and git to dev.azure.com and visualstudio.com through the coordinator's credential manager) all work. Only prompts are switched off (`GIT_TERMINAL_PROMPT=0`, `GH_PROMPT_DISABLED=1`) so nothing hangs, and windows stay closed (`BROWSER=none`, `PETRINA_AGENT=1`). Agents can therefore read and, in principle, write GitHub and the coordinator's other accounts. Every agent's instructions say to read and investigate freely and never to push, open, merge, close or comment on pull requests, create releases or change anything on GitHub, nor publish, merge or change other shared resources unless the task asks for it. That rule rests on those instructions and the tools' checkers, not on Petrina. |
| **Petrina publishes** | Petrina publishes deliveries with its own code, never a shell: it pushes the exact tested commit and opens the pull request, pushes the default branch and the new tag together and creates the release on that tag, or fast-forwards the local default branch. It has no merge, force-push or delete. Titles, descriptions and release notes stay text. |
| **Petrina's own git steps** | Never run hooks or the file monitor, whatever an agent wrote into the repository's settings. Only fetching, pushing and gh use the coordinator's normal git and GitHub setup, and only right after the repository's own settings pass an allowlist, so a credential helper, SSH command, address rewrite, proxy or include an agent planted stops them. Fetches and pushes name the address saved when the product was added, never a remote, so a changed remote or push address cannot redirect them. Pushes are never forced and carry only the refs Petrina names: no tags followed, no submodules. gh runs from a neutral folder, pinned to the product's repository. Each product's credentialed steps run one at a time, the update before a delivery included. Everything that touches a working copy, the product's checks and the repository's commit hooks run without credentials. |
| **Gates** | Plan, design and delivery checks live in the engine and decide what Petrina itself publishes. No agent's answer can skip them or grant permission to publish: that is the coordinator's approval, or the task's own setting to deliver without asking, for the approved change, delivery mode and destination. They do not stop an agent that disobeys its instructions from using the coordinator's logins directly. |
| **Read-only roles** | They run in the tool's automatic mode too, so they could change files: every change and commit they leave behind is undone when their stage ends, however it ends. What the coordinator changed while driving one is kept. |
| **Take over in the terminal** | Not a Petrina boundary: it is the coordinator acting with their own setup and logins, in the tool's normal mode with its usual prompts, where some actions may run without a prompt. Petrina adds no blocks there and does not change their GitHub access, connectors or plugins. It only keeps credentials, its engine key and its own variables out of the launcher, its command lines and the terminal, and makes sure delivery through Petrina still goes through review. |

Known limits: anything done in a take-over session (a push, a pull request, a connector action) happens for real without Petrina's review, and Petrina does not notice it; someone can also reopen the conversation by hand in another terminal after handing back, and Petrina only tracks the sessions it opened. Agents run as the coordinator's user and act with the coordinator's logins. "Never publish without approval" for agents rests on their instructions and on Claude Code's and Codex's own checkers; Petrina's gates decide only what Petrina itself publishes. Saved logins, settings in the home folder, Petrina's own connection file and its approval controls are only as protected as the tools' checkers keep them. Petrina adds no operating-system boundary.

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
