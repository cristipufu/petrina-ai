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
4. **A sequential review chain:** each reviewer sees earlier verdicts (never the builder's transcript); findings are merged and attributed.
5. **A light, live board** instead of an IDE.

Mechanics borrowed and credited:

- A stage finishes on a structured result, never on a model saying it is done (bmad-loop).
- Stage kinds with loops, caps and approval gates (Archon).
- Reviewers in fresh sessions, told to prove "done" wrong; pass/fail findings with file:line, never scores; a mechanical tamper check for deleted or skipped tests (no_human).
- One generic agent protocol for many tools (Kandev).

## Concepts

| Concept | What it is |
|---|---|
| **Product** | A GitHub repository and its local clone |
| **Task** | What the coordinator wants. Has a priority (its place in the queue) |
| **Role** | Data: name, purpose, instructions, permissions, what it sees, output contract |
| **Agent profile** | Tool × model × effort, for example Claude Code · Opus 5.5 · high |
| **Tool** | Something that can run an agent. Usually an ACP command line |
| **Plan** | Ordered stages. Each stage: kind, role, profiles, round limit, checkpoint |
| **Stage run** | One execution of a stage: rounds, agent sessions, events, result |
| **Inbox item** | Anything waiting on the coordinator |

### Stage kinds

| Kind | Behaviour |
|---|---|
| `do` | One role on one profile produces its result |
| `converge` | Author and reviewer (different profiles) alternate until the reviewer has no open blocking objection, or the round limit is reached and the coordinator decides |
| `review-chain` | Reviewers run one after another on the same change. Blocking findings send the change back to the builder as one list, then the chain runs again, up to the round limit |
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
| Resume | `session/load`, when the agent supports it |

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

A dedicated adapter is written only when a tool needs something ACP does not expose (for example reading usage limits). Things to verify per tool before relying on them: model and effort selection through ACP, use of the user's existing login, and `session/load` support.

## The Petrina bridge

Every agent session gets one extra MCP server attached: the Petrina bridge. It gives the agent a few tools that turn agent behaviour into structured events:

| Tool | Purpose |
|---|---|
| `petrina_status(text)` | A plain-language status line for the board ("Adding the guest email step") |
| `petrina_ask(question, options, blocking)` | Creates an inbox Question. Blocks until answered when `blocking` |
| `petrina_submit(result)` | The stage's result, validated against the role's output contract. Invalid results come back as a tool error naming what is wrong, so the agent fixes them. A stage is complete only when this succeeds |

The bridge is a small stdio process started by the agent. It connects back to the app over a local socket (a Unix domain socket with `0600` permissions, a named pipe on Windows) and authenticates with a random per-session secret passed in its environment. It never listens on TCP.

## Permissions

Petrina relies on each tool's own safety checker instead of building one:

| Tool | Mode | Who decides |
|---|---|---|
| Claude Code | Auto | Claude Code's classifier allows or blocks each action |
| Codex | Auto review | Codex's reviewer approves, inside Codex's own workspace sandbox |

- Petrina reads no commands. When a tool's checker flags something and asks, the question goes to the inbox unchanged, with the exact command or paths, and the coordinator allows or denies it once.
- Petrina never picks a tool's "always" option: those write settings into the working copy or switch modes.
- Nothing is remembered: every request is allowed or denied once, in the inbox or the session, with the same wording and buttons in both. There are no remembered rules per product and no list of them in Settings. Seeing and removing remembered permissions is not available yet; if remembering returns, it belongs to Product settings and board papercuts.
- If a tool's automatic mode is not available for a model, the session log says so and that tool asks before acting.
- Approval gates and round limits are enforced by the engine, never by prompting a model to stop.

## Messages to a running agent

- Messages queue per task. When the agent's current turn ends, the next queued message is sent with `session/prompt`.
- Interrupt sends `session/cancel`, then the message.
- Every delivered message and reply is written to the session transcript the Session tab shows.

## Scheduling

- The queue is an ordered list. Priority is position.
- A pool limit caps running agents, with optional caps per tool.
- A running stage holds a slot. A task waiting at a gate releases it. An agent waiting on a mid-stage question keeps its slot and is shown as waiting on the coordinator.
- When a slot frees, the scheduler starts the first queued task that is not held and whose next stage's tool is under its cap.
- Lowering the limit never kills a stage.

The scheduler is a pure function in `@petrina/core` (`pickStarts`), tested without any I/O.

## Working copies

- Each task gets a git worktree in Petrina's data folder (not inside the repository), on a branch named `petrina/<task-slug>`.
- Slugs are generated by Petrina from a strict allowlist (`[a-z0-9-]`), never from raw task text.
- Processes are started with argument arrays, never through a shell.
- The pull request is opened with the coordinator's `gh` login at the delivery gate. Petrina never merges.

## Architecture

```
apps/desktop            Tauri 2 shell + React UI
  src/                  UI (board, inbox, task sheet, session, pool)
  src-tauri/            Rust host: processes, worktrees, SQLite, sockets
packages/core           Domain model, scheduler, plan engine, simulator
docs/                   This document and the UX brainstorm
```

- **Rust is a thin host.** It starts and stops processes, manages worktrees, stores events in SQLite, runs the bridge socket, and opens pull requests with `gh`.
- **TypeScript holds everything domain-specific:** roles, plans, the scheduler, the engine, ACP handling, and the UI.
- `@petrina/core` never imports Tauri. It talks to a host interface, so the whole engine runs under Node in tests with fake agents.
- **State** is an append-only event log per task in SQLite. The UI and the engine read the same state, so tasks pick up where they left off after a restart.

## Security model

Agents start with full permissions inside their own working copy; the coordinator asked for that, and it keeps the squad fast. What stops them doing harm is layered, and it is important to know which layer is the boundary:

| Layer | What it guarantees |
|---|---|
| **The tools' own checkers** | Claude Code's Auto mode and Codex's Auto review decide what is safe to run; Codex also keeps its own workspace sandbox. Petrina does not second-guess them or re-implement them. |
| **Credentials** | Only a shipper delivering to GitHub (pull request or release) gets GitHub credentials and an SSH agent. Every other agent, and a shipper delivering locally, runs with no tokens, an empty gh config, git credential helpers reset and SSH for git disabled, so it has nothing to push or publish with. |
| **Petrina's own git steps** | Never run hooks or the file monitor, whatever an agent wrote into the repository's settings. Only fetching and GitHub lookups get credentials; everything that touches a working copy runs without them. |
| **Gates** | Plan, design and delivery checks live in the engine. No agent can skip them, and only the shipper runs after delivery approval. |
| **Read-only roles** | They run in the tool's automatic mode too, so they could change files: every change and commit they leave behind is undone when their stage ends, however it ends. |

Known limits: a shipper delivering to GitHub holds the coordinator's login, so "never merge" rests on its instructions and its tool's checker until Petrina publishes deliveries itself. Credentials are kept out of agents' environment, not locked away. Agents run as the coordinator's user, so a GitHub login saved on disk or in the keychain is only as protected as the tools' checkers keep it.

## Security notes

- Agent output is untrusted. The UI renders it as text only (no HTML, no `dangerouslySetInnerHTML`). Links are opened only when they are `https://` and only through the host.
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
