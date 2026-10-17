# Working on Petrina

Petrina is a desktop app for people who run products with a squad of coding agents. Read [docs/design.md](docs/design.md) for how it works and [docs/ux.md](docs/ux.md) for how it should feel.

## Rules for every change

- The app never shows code. Everything the coordinator sees is plain language.
- Keep designs and changes as small as the task allows. Put ideas that would grow a task into its risks or a follow-up, not into the task.
- Petrina never merges a pull request.

## Safety model

Agents act with the coordinator's own logins: GitHub (gh, git's credential helpers, SSH), AWS, Azure CLI and Azure DevOps (`packages/engine/src/env.ts`). They can read with them and, in principle, write. Their instructions say to read and investigate freely and never to publish, merge or change shared things; that rule rests on those instructions and on each coding tool's own safety checker (Claude Code's Auto mode, Codex's Auto review), which also decides what agents may run. Petrina itself only:

- publishes deliveries itself, after its gates allow it, with no merge, force-push or delete, and sets a release's version itself (the only agent at delivery is the read-only Release Manager, writing a release's notes),
- runs its own git steps with hooks off, and credentials only where GitHub needs them, to the product's saved address (`packages/engine/src/git.ts`),
- enforces its checkpoints (plan, design, delivery) in the engine, and
- undoes whatever a read-only role leaves behind.

Petrina also runs each product's checks itself (`packages/engine/src/checks.ts`), so a passing check is evidence, not an agent's word. Those commands come from the Check finder agent or the coordinator, run as argument arrays without a shell or GitHub login, and do not pass through a tool's safety checker: a repository that misleads the Check finder could get a harmful command run. The coordinator sees and can change the checks in the product's settings. In the same way, Petrina runs the repository's own commit hooks (pre-commit, commit-msg), as git would find them, on each task's whole change: they are the repository's code, run with no GitHub login, never by Petrina's own git steps.

Do not add security or sandboxing mechanisms of Petrina's own unless the task is about that.

## Checks

- `bun run typecheck` and `bun run test` must pass.
- UI changes: check light and dark, and the demo (`?demo`, `?demo=portfolio`).

## Learnings

What agents learned about working in this repository, added with the coordinator's OK.

- Desktop tests run in happy-dom at 1024px wide, where the inbox opens over the board: to test the docked inbox, widen the window to 1200px or more with `window.happyDOM.setViewport({ width: 1400 })` inside `act()`, and set it back afterwards.
