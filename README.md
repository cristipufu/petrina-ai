<p align="center">
  <img src="apps/desktop/public/icon.svg" width="72" alt="" />
</p>

<h1 align="center">Petrina</h1>

<p align="center">
  A desktop app for builders who run a squad of AI coding agents.<br />
  You set priorities and make the calls. The squad plans, designs, builds and reviews, then hands you a pull request.
</p>

<p align="center">
  <img src="docs/screenshots/board-light.png" alt="The Petrina board: task cards grouped by what they need (needs you, working, the queue), each with its own progress through its plan, and a Needs you inbox with a permission request and a question" />
</p>

## What it does

- **A board for your products.** Every task is a card, grouped by what it needs: you first, then work in progress, then the queue. Each card shows its own progress through its plan (plan, design, your check, build, review, ship) and says, in plain language, who is working on it and what they are doing.
- **A queue you control.** Drag tasks to set priority. The top of the queue starts first, as soon as a slot is free. Hold a task to keep it from starting.
- **Many products.** A searchable product switcher (⌘P) and a Products page that shows every product's pipeline and what waits on you, so twenty products stay as calm as two.
- **A pool of agents.** Choose how many agents may run at once, with caps per tool so one subscription is not exhausted. See who is in each slot.
- **Roles, not tools.** Planner, Researcher, Architect, Design reviewer, UX designer, Builder, Tester and Code reviewer are first-class. Any role can run on any tool, model and effort: Claude Code with Opus 5.5 as the architect, Codex at xhigh effort as its reviewer.
- **A plan per task.** The planner composes the stages for each task: a bug fix might be one builder and two reviewers, something new gets research, a design both architects agree on, screens, tests and three reviewers. You can change the plan before it runs.
- **Architects who have to agree.** Two architects on different tools iterate until no blocking objection is left. The disagreement log shows every objection and how it was answered.
- **Reviews in a chain.** Reviewers run one after another, each seeing earlier verdicts but never the builder's transcript. Findings are pass or fail, merged and attributed.
- **A "Needs you" inbox.** Questions, permission requests, plan and design checks, and delivery approvals, each with one-click answers. It tells you when you are the one blocking agents.
- **Join any agent.** Open the live session of the agent working on a task, read along, and message it. Messages queue until the agent finishes its current step, or interrupt it right away. Take over in your own terminal when you want to drive.
- **No code in the app.** You see plans, briefs, checklists and verdicts. The code lives in the pull request. Petrina never merges.

<p align="center">
  <img src="docs/screenshots/sheet-plan.png" alt="A task's plan: design until both architects agree, your design check, the build, a chain of two reviewers and your delivery check, each stage with its tool, model and effort" width="49%" />
  <img src="docs/screenshots/session.png" alt="Joining a code reviewer's session: each agent's activity in plain language, the planner's message, and a queued message from the coordinator" width="49%" />
</p>

## How it runs agents

Petrina talks to agents through the [Agent Client Protocol](https://agentclientprotocol.com). Claude Code and Codex both have maintained ACP adapters, and any other agent that speaks ACP works the same way, so adding a tool is usually configuration. Everything runs on your machine with the tools you are already logged into: no API keys, no Petrina server, no telemetry. Details are in [docs/design.md](docs/design.md); the UX it is built from is in [docs/ux.md](docs/ux.md).

## Status

Early, and working: the engine runs real Claude Code and Codex agents over ACP in their own git worktrees, with the planner, design convergence, review chain, permissions, questions and delivery (pull request, release, or a commit to main) wired end to end. Without the engine running, the app opens on a simulated squad (`?demo` or `?demo=portfolio`).

## Develop

You need [Bun](https://bun.sh) 1.4, and for the desktop shell, Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
bun install
bun run engine       # the engine on 127.0.0.1:4317 (data in ~/.petrina)
bun run dev          # the UI at http://localhost:1430, connected to the engine
bun run tauri dev    # the desktop app
bun run test         # core and engine tests (the engine test uses a fake ACP agent)
bun run typecheck
```

`bun run petrina state` prints the engine's state, and `bun run petrina do '<action json>'` runs an action, for scripts.

| Path | What lives there |
|---|---|
| `apps/desktop` | The Tauri app: React UI in `src/`, the Rust host in `src-tauri/` |
| `packages/core` | Domain model, scheduler, plans and the simulated squad |
| `packages/engine` | The engine: ACP agents, worktrees, credentials, prompts, SQLite, the local API |
| `docs` | Design and UX |

## License

MIT
