# Workflow and review contracts

Owns stage progression, Backlog, acceptance and review decisions. Back to [design overview](../design.md).

## Stage kinds

| Kind | Behaviour |
|---|---|
| `do` | One role on one profile produces its result |
| `converge` | Author and reviewer (different profiles) alternate until the reviewer has no open blocking objection, or the round limit is reached and the coordinator decides |
| `review-chain` | Petrina's tamper check and the product's checks first, then every reviewer at once, each on its own, then fresh agents voting on Important findings. Important findings that stand send the change back to the builder as one list, then the review runs again on what changed: within the planned rounds, and past them while each round resolves at least one previously open Important finding, up to five. A round that stops making progress goes to the coordinator, whose delivery check then says "your call" with the count still open |
| `do` with the Tester | The product checks run first, so the Tester can reuse verified automated evidence and focus on trying the acceptance list like a user, once on the change before its first review. Each item is pass, fail, or could not be verified; an unavailable check stays unverified and blocks delivery without being sent to the builder as a product defect. Fix rounds skip it (the code reviewers check the fixes), and right before the delivery check the tester tries the final code once more if it changed since; a reproduced failure there goes back to the builder like a failing check. Failed product checks return to the builder while their failure episode has returns left, then ask the coordinator immediately; no Tester starts while those checks fail |
| `gate` | Waits for the coordinator (design approval, delivery approval) |

Each new acceptance pass or failure records a short account of the actual scenario and observed result, or names the applicable current automated evidence. The node's details show that evidence beside the item. Missing evidence remains unverified rather than passing or creating a product defect. Previously finished records keep their original evidence without invented detail. One probe may support several items; this adds no duplicate full-suite run or workflow gate.

Agent verification instructions require a real execution deadline through the harness or an external parent process, with owned background handles retained and stopped. A tool's output wait is not a command deadline, and a program can starve its own test timers. This uses the tools' existing command controls; it adds no process scanner or memory sandbox. Engine-run product checks keep their separate external deadline, complete logs and process cleanup, and legitimate full-suite budgets are unchanged.

## Task lifecycle

```
backlog → queued → planning → designing → building → reviewing → ready → done
            │            │            │           │        │
            └──── any stage can be: running · needs-you · paused · failed
```

The stage column (planning, designing, building…) is derived from the role of the current stage; the Products page counts tasks by it. The board itself is one grid of cards grouped by what each task needs (needs you, working, waiting, queue, backlog), and every card shows its own pipeline from its plan: done steps checked, the current one named, stages the plan does not have left out (`packages/core/src/board.ts`).

Static check preparation and queued/running commands hold no agent slot. Preparation is bounded by the pool size, check commands keep their separate concurrency limit (one task at a time by default), while queued planners can still use free agent slots. Check finder, reviewer and Tester conversations acquire their actual model slots before starting. A pause or drain admits neither new checks nor new conversations.

## Backlog and finished work

A backlog task is saved work awaiting the coordinator’s review. It cannot take a pool slot or start a planner. Its request, source and delivery choices remain editable; the explicit `queueTask` command puts it into the queue. Combining Backlog requests validates the whole selection before changing it, saves one queued request and the original links together, and retains retry identity across restarts. Original bodies remain in History; pictures are copied before their original bytes are removed. Only matching product/source/delivery choices and requests without unresolved dependencies may combine; approvals are never weakened.

A queued task may return through `moveToBacklog` only before it has ever started. The engine enforces both transitions, and the simulator follows the same rules. New task defaults to Backlog in the window; API callers that omit the option retain the existing queued behavior.

When a task finishes, confirmed unrelated older bugs become Backlog cards, with reproduction, evidence and links to their source findings. Independent reviewer and verifier judgments settle first; a bounded identity check then groups reports of the same bug and reuses open follow-up cards. Uncertain or unavailable matches remain visibly untracked for retry. Nits and speculative improvements create no cards. These cards never queue themselves or prevent the original task from finishing.

Identity agents respect paused scheduling, usage limits and the ordinary global and per-tool pool caps, appear in the pool while matching, and stop with the engine. They compare only the supplied reports, in an empty temporary working folder.

Identity matching deliberately prefers high effort for semantic judgment, then medium and low when high is unavailable, with extra high last. This avoids using the deepest reasoning by default without assuming the lightest effort can reliably identify the same underlying bug.

Pictures needed by an unfinished follow-up are copied to that card before the original task's pictures are removed. A failed copy keeps its saved retry and original bytes across restarts. Cleanup reads archived bodies only for those saved pending links, rather than loading finished conversations just to remove their capture folders. Completing or cancelling the follow-up removes its picture bytes as usual.

## Maintenance completion

Scheduled tasks start directly with their saved maintenance role and profile, using the normal Queue, default-branch source, product delivery destination, pool/tool limits and working-copy lifecycle. There is no Planner turn or additional Builder.

After an accepted completed maintenance turn, compare the actual remaining product tree with its base. With no changes, retain the real report and finish in History through normal cleanup, without product checks, reviewers or delivery approval. This also applies to writable investigations and changes withdrawn during repair. Nothing actionable found is an honest report, never a replacement for errors, incomplete work or unresolved settings decisions.

Changed maintenance work remains Medium risk and runs ordinary product checks, two fresh Code reviewers and delivery approval. Reviewers prefer different available tools and avoid the maintenance profile when another tool is available; with one tool they use independent conversations. Existing finding verification, repair limits and update-conflict handling apply, returning to the frozen maintenance role and profile. Maintenance adds no Security review, risk classifier or delivery system. Agents never publish or merge.

## Checks, reviews and risk

### Check output

Each check and commit hook streams its complete output into a separate private file in the engine's data folder. The saved result keeps its exact location across restarts; state and prompts keep only a short excerpt. A builder fixing a failed check receives the file's location and reads it instead of rerunning the command to recover a lost error. A failed or incomplete log write is reported separately and never changes whether the command passed. Older runs without a log say so.

### Acceptance evidence

Testers and reviewers see whether saved results still match the code and all required commands and hooks, using the same freshness rule as the gates. Current complete passes can satisfy automated acceptance without another full run; user acceptance still needs to be tried. Changed or uncommitted code, changed checks, incomplete runs and uncertain hook inputs never become a current pass by being shown to an agent. A read-only review does not invalidate a run on unchanged work.

Before a fresh Tester, each repository is brought up to date once before preparing its checks. A saved Tester or Check finder first finishes the version it was already examining.

Each check operation shares one observation of its commit, tree, tracked changes and hook definition. Queue waits refresh that observation before executing. Review-context capture remains a fresh boundary; a saved current flag alone proves nothing. Settled native failures remain in history without repeating their old diagnostics to reviewers; open failures and agent finding history remain visible.

A Tester must report each item in a saved acceptance checklist; missing items are repaired in the same conversation. A failed acceptance run never satisfies final acceptance, even if a Builder claims it fixed without changing the patch. Final acceptance failures return to the Builder twice, then stop at the coordinator's delivery decision; that boundary survives a restart. A new change request authorizes another bounded attempt.

### Product checks

The Check finder (an internal role) works out once per product, from its CI first, which commands prove it works; it looks again when the CI or build files change. The coordinator can set them by hand. Petrina runs them itself as argument arrays without a shell, before the first reviewer of every round and again right before the delivery check when the code changed (`packages/engine/src/checks.ts`, `product-checks.ts`).

A failing check is an Important finding with the real output, and the work goes straight back to the builder. The builder runs focused tests for changed behavior while working, then hands the change back without rerunning the full product checks or test suite; Petrina runs the configured checks and reviewers read those results. A check only looks: whatever one changes in files git tracks is put back, so no formatter slips unreviewed changes into the work.

Automatic returns are counted per product and per failure episode: at most two Builder turns between a failing result and the next genuine pass, saved across restarts. Only every check and hook passing on the current code and check definitions ends the episode, with no check failure of that product left open, including a saved pass reread on that same code; a new commit that still fails, a check that did not finish, one check fixed while another fails, or a pass on checks or hooks replaced while it ran continues it. Rereading a saved failure after an unchanged return reruns nothing and is no extra attempt; the send-back that follows counts. A Builder answer, including one blaming the environment, leaves the check finding open. Each return walks forward from the Builder through every stage up to the one the checks guarded: a pending review round keeps its number and incremental anchor, a fix made after reviews passed is reviewed again, and acceptance is retried on the final code before the delivery check. Shared repairs started at the delivery check or right before shipping return through the first review after the Builder.

When the episode's returns are used up, the task waits at the guarded step (review, acceptance testing or the delivery check; a failure right before shipping goes back to the delivery check) and raises a check problem: a "your call" delivery item naming each failing check with its short diagnostic, the Builder turns spent and the Builder's last answer, where the task stopped, review fixes no reviewer has confirmed yet, the steps still to come and the next action. Asking for changes gives the Builder one more turn, not a fresh allowance; a still-failing run returns straight to the check problem. Approving never ships failing checks: the decision comes back, and a product without a delivery check stops for Retry instead. Review convergence limits and acceptance returns are separate.

Conventional type checks and lint run first. A static failure skips the remaining commands and hooks, without settling their older failures or treating skipped work as passing evidence. Other commands run serially within the working copy to avoid shared build-output races.

Tasks’ checks use a separate bounded queue (see [Scheduling](engine-runtime.md#scheduling)); full suites and builds compete for the same machine.

### The repository's own commit hooks

Petrina's own git steps never run hooks, so Petrina runs the hooks git would run when committing, as the repository has them (local `.git/hooks`, or `core.hooksPath` for husky, lefthook and the like), alongside the checks: the pre-commit hook with the task's whole change staged on top of where it started (the working copy's HEAD detached at the base for the run, and put back after, even across a restart), and the commit-msg hook on the task's one commit message.

They run like the checks, with no GitHub login, and a failure goes back to the builder with the hook's output, so a hook that keeps internal names out of a public repository works as it does by hand. The builder is told the hooks exist and how to run them itself.

### Findings

The default Code reviewer checks nearby cases affected by the changed code or rule against the starting version on every product, even without a local review guide. A confirmed regression caused by the change is Important even when the intended case now works. Reviewers tag each finding Important, Nit or Pre-existing (a follow-up that never blocks), report a whole class of bug once, and confirm or dispute an earlier report by its id. New reports keep separate ids: wording never establishes identity or cross-tool agreement. The Builder can resolve several reports with one fix, answering every id. Finding counts therefore count reports, not distinct underlying bugs. From round two reviewers inspect only what changed since the last round, and after round three the builder is asked to step back and reconsider.

### Reopening a settled finding

Confirming a dismissed finding or one the Builder claimed to fix reopens that same finding only with its explicit id and a current reproduction; an old id alone asks that reviewer to correct its result in the same conversation, before any finding changes. This applies to code, security and added reviewers. A separately worded new report never silently reopens a historical finding. The current reproduction reaches the next Builder and voters, while the earlier evidence, votes, confirmations and disputes stay in history.

The reopened finding needs fresh support on the changed code; its original raiser is not assumed to endorse it again. Older saved reopened findings with pre-fix verification are checked again too. A prior dismissal stays settled without new current proof; a fresh reproduction keeps the earlier verdict as history and receives a new check without counting the original raiser as current support. Native check findings follow the actual check results.

Reproduction evidence accompanies open findings to Builders and voters.

### Independent review and voting

Every reviewer in a round looks at the change at the same time, blind to what the others find. An explicit confirmation of a supplied finding id from another tool backs it; ids absent from the saved input are refused. Separate blind reports never create agreement from equal or similar prose. An Important finding no second tool has backed goes to a vote: one fresh agent per tool (the Verifier) says real, not a bug, a nit or pre-existing, all at once. Verifiers prefer high-effort profiles for these specific claims; discovery reviewers keep their configured effort. It stands when at least half the voters say it is real; otherwise the most common other verdict settles it. Petrina waits for every admitted tool’s ballot before handing findings to the Builder; a mathematical majority does not cancel running Verifiers. Every vote and its reason remain with the finding.

Before any reviewer starts, the engine saves the round's brief, Builder reports, check evidence, earlier findings and follow-up cards as one immutable snapshot. Queued reviewers and interrupted rounds read that same snapshot after a restart; a faster peer's current-round report never enters their input or result-validation baseline. Coordinator messages remain live and reach each intended participant.

The same preparation saves each product's base-version review guide and commit-specific full, incremental and port comparisons in private files. Fix-round Code reviewers read a separate incremental file rather than rereading the original patch. Lockfile changes remain listed in the statistics and have separate patch files; they remain in review scope, including dependency and integrity checks. Security reviewers and Verifiers retain full-change scope. Reviewers receive file references rather than repeating Git discovery. Raw diffs stay out of task/window state. The in-memory input is reused without disk reads; after a restart its files are verified when loaded. Detached copies use the snapshot's exact commits.

### Reviewer working copies

Each reviewer and voter works in a copy of the change of its own (a detached worktree of the task's commit, with nothing installed, deleted when it finishes), so a test one runs or a checkout one makes never disturbs another or the task's copy. Each holds a slot of its own and starts when the pool and its tool allow, so a small pool takes turns; what each hands back is saved as it arrives, so a restart only redoes the rest.

A stage with a single reviewer runs it as one ordinary step, which can pick up its conversation after a restart or be taken over. In a fix round the builder answers every finding by id. Summaries start with a count, or say "Nothing to fix".

### Risk

The planner rates every task Low, Medium or High from what it touches; unrated work counts as Medium. High-risk work gets a Security review on a tool other than the builder's. Where a product opts in, low-risk work with passing checks and nothing Important open ships without the delivery check. An approval covers the change itself (git's patch-id), on top of whatever main is when it ships: main moving on underneath keeps it, but if the change reads differently on top of the latest main, or the work changed, the coordinator is asked again.

### Review guide

`REVIEW.md` at the repository root, reached the way every agent reaches project knowledge: `AGENTS.md`, which Claude Code and Codex load by themselves, has a short "Review guide" section pointing to it, so an agent Petrina starts and one the coordinator starts read the same guide. Petrina's reviewers are told to judge by the guide as the base branch has it: whatever the change itself writes into `REVIEW.md` or `AGENTS.md` is part of what they review, never a rule, since a change cannot set the rules it is judged by.

When the coordinator sends back a delivery every reviewer passed, the Guide keeper proposes one point; accepted, that task's reviewers get it with the task, like the coordinator's notes, and it is committed to `REVIEW.md` on the branch that ships (the first one also adds the section to `AGENTS.md`).

Review-guide points retain the exact commit that incorporated them: they are no longer written into deliveries, but still accompany reviews pinned before that commit. A later base that already incorporated a rule respects subsequent edits or removal instead of restoring the old instruction. Instructions only on an unpublished branch stay pending; an unreadable repository proves nothing.

### Measuring

The Analytics page shows how reviews are going: rounds to pass, what became of each finding, deliveries sent back, and how each reviewer profile's Important findings held up (`packages/core/src/reviews.ts`).
