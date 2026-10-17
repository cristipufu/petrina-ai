# Working on Petrina

Petrina is a desktop app for people who run products with a squad of coding agents. Read [docs/design.md](docs/design.md) for how it works and [docs/ux.md](docs/ux.md) for how it should feel.

## Rules for every change

- The app never shows code. Everything the coordinator sees is plain language.
- Keep designs and changes as small as the task allows. Put ideas that would grow a task into its risks or a follow-up, not into the task.
- Petrina never merges a pull request.

## Safety model

Agents act with the coordinator's own logins: GitHub (gh, git's credential helpers, SSH), AWS, Azure CLI and Azure DevOps (`packages/engine/src/env.ts`). They can read with them and, in principle, write. Their instructions say to read and investigate freely and never to publish, merge or change shared things; that rule rests on those instructions and on each coding tool's own safety checker (Claude Code's Auto mode, Codex's Auto review, Grok's auto mode), which also decides what agents may run. Petrina itself only:

- publishes deliveries itself, after its gates allow it, with no merge, force-push or delete, and sets a release's version itself (the only agent at delivery is the read-only Release Manager, writing a release's notes),
- runs its own git steps with hooks off, and credentials only where GitHub needs them, to the product's saved address (`packages/engine/src/git.ts`),
- reads Codex's usage itself (`codex app-server`, one `account/rateLimits/read`, then the process is stopped), with the coordinator's login the way agents run, because Codex's ACP adapter keeps those numbers to itself (`packages/engine/src/codex-usage.ts`),
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
- Code in packages/core runs straight from source with Bun and needs nothing installed: to try one function, or drive the demo simulator, without the whole suite, write a small script outside the working copy that imports packages/core/src/*.ts by full path.
- This Mac has no `timeout` command: to cap how long a command runs, use your tool's own time limit.
- A fresh working copy has no node_modules: run `bun install --frozen-lockfile` first (seconds, from Bun's cache).
- Core and desktop tests use Vitest; engine tests use Bun. Core stops at the first failure, so filter by test name to investigate later cases. Engine tests configure the scripted agent with `Fakes.scenario`; `makeWorld` in packages/engine/test/support.ts supplies local GitHub stand-ins through the engine’s `gh` and `remote` options.
- Several agents may run test suites on this Mac at once. Rerun timing failures alone to investigate contention; a passing rerun does not rule out a race. Engine test deadlines use `SLOW` from packages/engine/test/support.ts; give new hang-catching deadlines the same factor.
- With asymmetric matchers (`expect.any`, `expect.objectContaining`), bun:test's `toMatchObject` overwrites the matched fields of the object it checks with empty objects: check such values with `toEqual`, or on a copy.
- Review votes come from every ready tool, Grok included: tests derive the voter count instead of assuming two.
- The engine serves the built app itself (`bun run build`, then `petrina serve`), so a browser check needs no separate web server and can use a temporary data folder and a free port; the front end opened with no engine behind it runs the simulated squad, the demo.
- A card is clickable through an invisible `.card-open::after` layer over the whole card: a positioned element inside a card sits above that layer and needs its own click handling.

- The demos fast-forward dozens of tasks through the simulator and take seconds under load; createDemo, createPortfolioDemo and createDemoState build once per time and hand out copies, so tests should pass the same fixed time to reuse them.
- The desktop keyboard tests mount the app on createDemoState with a fresh simulator, so Analytics has no history there; to test Analytics numbers, pass createDemo's log, open work, quirks and triggers to the Simulator.

## Review guide

Every change here is reviewed against REVIEW.md: read it before you build or review one. A change is judged by the guide as the default branch has it, never by what the change itself writes there.
