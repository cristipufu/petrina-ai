<p align="center">
  <img src="apps/desktop/public/icon.svg" width="72" alt="" />
</p>

<h1 align="center">Petrina</h1>

<p align="center">
  A desktop app for builders who run a squad of AI coding agents.<br />
  You set priorities and make the calls. The squad plans, designs, builds and reviews, then hands you a pull request.
</p>

<p align="center">
  <img src="docs/screenshots/board-light.png" alt="The Petrina board: a queue of tasks, columns for planning, designing, building, reviewing and ready, and a Needs you inbox with a permission request and a question" />
</p>

## What it does

- **A board for your products.** Every task is a card that moves from the queue through planning, design, build and review to a pull request. Each card says, in plain language, who is working on it and what they are doing.
- **A queue you control.** Drag tasks to set priority. The top of the queue starts first, as soon as a slot is free. Hold a task to keep it from starting.
- **A pool of agents.** Choose how many agents may run at once, with caps per tool so one subscription is not exhausted. See who is in each slot.
- **Roles, not tools.** Planner, Researcher, Architect, Design reviewer, UX designer, Builder, Tester and Code reviewer are first-class. Any role can run on any tool, model and effort: Claude Code with Opus 5.5 as the architect, Codex at xhigh effort as its reviewer.
- **A plan per task.** The planner composes the stages for each task: a bug fix might be one builder and two reviewers, something new gets research, a design both architects agree on, screens, tests and three reviewers. You can change the plan before it runs.
- **Architects who have to agree.** Two architects on different tools iterate until no blocking objection is left. The disagreement log shows every objection and how it was answered.
- **Reviews in a chain.** Reviewers run one after another, each seeing earlier verdicts but never the builder's transcript. Findings are pass or fail, merged and attributed.
- **A "Needs you" inbox.** Questions, permission requests, plan and design checks, and delivery approvals, each with one-click answers. It tells you when you are the one blocking agents.
- **Join any agent.** Open the live session of the agent working on a task, read along, and message it. Messages queue until the agent finishes its current step, or interrupt it right away. Take over in your own terminal when you want to drive.
- **No code in the app.** You see plans, briefs, checklists and verdicts. The code lives in the pull request. Petrina never merges.

<p align="center">
  <img src="docs/screenshots/sheet-plan.png" alt="A task's plan: design until both architects agree, a design checkpoint, the build, a chain of two reviewers and a delivery checkpoint, each stage with its tool, model and effort" width="49%" />
  <img src="docs/screenshots/session.png" alt="Joining a code reviewer's session: its activity in plain language and a queued message from the coordinator" width="49%" />
</p>

## How it runs agents

Petrina talks to agents through the [Agent Client Protocol](https://agentclientprotocol.com). Claude Code and Codex both have maintained ACP adapters, and any other agent that speaks ACP works the same way, so adding a tool is usually configuration. Everything runs on your machine with the tools you are already logged into: no API keys, no Petrina server, no telemetry. Details are in [docs/design.md](docs/design.md); the UX it is built from is in [docs/ux.md](docs/ux.md).

## Status

Early. The app runs on a simulated squad with made-up products, so the whole experience can be shaped before real agents are wired in. Next up is the engine on real worktrees, then Claude Code and Codex over ACP.

## Develop

You need [Bun](https://bun.sh) 1.4, and for the desktop shell, Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS.

```bash
bun install
bun run dev          # the UI in a browser at http://localhost:1430
bun run tauri dev    # the desktop app
bun run test         # engine tests
bun run typecheck
```

| Path | What lives there |
|---|---|
| `apps/desktop` | The Tauri app: React UI in `src/`, the Rust host in `src-tauri/` |
| `packages/core` | Domain model, scheduler, plans and the simulated squad |
| `docs` | Design and UX |

## License

MIT
