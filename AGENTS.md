# Working on Petrina

Petrina is a desktop app for people who run products with a squad of coding agents. Read [docs/design.md](docs/design.md) for how it works and [docs/ux.md](docs/ux.md) for how it should feel.

## Rules for every change

- The app never shows code. Everything the coordinator sees is plain language.
- Keep designs and changes as small as the task allows. Put ideas that would grow a task into its risks or a follow-up, not into the task.
- Petrina never merges a pull request.

## Safety model

Petrina relies on each coding tool's own safety checker (Claude Code's Auto mode, Codex's Auto review) for what agents may run. Petrina itself only:

- keeps GitHub logins away from every agent except a shipper delivering to GitHub (`packages/engine/src/env.ts`),
- runs its own git steps with hooks off and credentials only where GitHub needs them (`packages/engine/src/git.ts`),
- enforces its checkpoints (plan, design, delivery) in the engine, and
- undoes whatever a read-only role leaves behind.

Petrina also runs each product's checks itself (`packages/engine/src/checks.ts`), so a passing check is evidence, not an agent's word. Those commands come from the Check finder agent or the coordinator, run as argument arrays without a shell or GitHub login, and do not pass through a tool's safety checker: a repository that misleads the Check finder could get a harmful command run. The coordinator sees and can change the checks in the product's settings.

Do not add security or sandboxing mechanisms of Petrina's own unless the task is about that.

## Checks

- `bun run typecheck` and `bun run test` must pass.
- UI changes: check light and dark, and the demo (`?demo`, `?demo=portfolio`).
