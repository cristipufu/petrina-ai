import { completeAll } from "@petrina/core";
import {
  applyTakeOverHandChanges,
  executionFor,
  invalidateHandEditedRepositoryWork,
  repositoryView,
  takeOverBranchProblem,
} from "@petrina/orchestrator";
// Take over in the terminal: the coordinator drives a step's agent by hand, then hands it back. The
// launcher scripts and terminals are in terminal.ts.

import { join } from "node:path";
import {
  runtimeWaitHolds,
  TAKE_OVER_TOOLS,
  TAKE_OVER_WORDS,
  takeOverBlock,
  toolName,
  type HandBackPreview,
  type Id,
  type Launched,
  type Task
} from "@petrina/core";
import * as git from "@petrina/repositories/git";
import { handBackNote } from "./prompts.js";
import {
  clearEnded,
  type FoundTerminal,
  launchPlan,
  type LaunchInput,
  openTerminal,
  pickTerminal,
  removeLauncher,
  sessionState,
  writeLauncher
} from "@petrina/agent-runtime/terminal";
import { ADAPTERS } from "@petrina/agent-runtime/tools";
import { Kernel, type RuntimeTask } from "./kernel.js";

export class TakeOver {
  constructor(private readonly k: Kernel) {}

  /**
   * The coordinator drives the current step in their own terminal: the agent's own tool, on the same
   * conversation and model, in the task's working copy, in its normal mode. Petrina first checks it can
   * open a terminal (or that every value fits in a launcher), then stops the agent and waits until its
   * process has exited, clears what it had open in the inbox, saves an editing role's unfinished work as
   * that agent's commit (a read-only role's is undone, as always), and only then opens the terminal.
   * The step keeps its seat in the pool until the coordinator hands back.
   */
  async takeOver(taskId: Id, how: "open" | "copy" = "open"): Promise<Launched> {
    const task = this.k.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    if (!task) throw new Error("Unknown task");
    this.notSwitching(taskId);
    const blocked = takeOverBlock(repositoryView(scope!) as Task, this.k.activeState());
    if (blocked) throw new Error(blocked);
    const agent = { ...task.agent! };
    const conversation = scope!.work.conversation!;
    const profile = this.k.profile(agent.profileId)!;
    const role = conversation.role ?? this.k.role(agent.roleId)!;
    const terminal = how === "open" ? pickTerminal(this.k.found, this.k.s.terminal) : undefined;
    if (how === "open" && !terminal) throw new Error(TAKE_OVER_WORDS.noTerminal);

    this.k.switching.set(taskId, "taking over");
    let driverFailure: { error: unknown } | undefined;
    try {
      const tool = await this.takeOverTool(profile.toolId);
      // Every value goes through its pattern before the agent stops, so a launcher that cannot be written never strands the step.
      launchPlan(this.launchInput(task, tool, conversation.sessionId, conversation.model, profile.effort));
      task.statusLine = "Stopping the agent so you can take over";
      this.k.commitNow();
      const settled = this.k.settling.get(taskId);
      this.k.stopDriver(taskId);
      // What it asked is moot now: the coordinator is in the conversation themselves.
      this.k.dropBlockingItems(taskId);
      try { await settled; } catch (error) { driverFailure = { error }; }
      try { await this.k.agentCleanup.wait(taskId); }
      catch (cleanup) {
        if (driverFailure && !Object.is(
          driverFailure.error,
          cleanup
        )) throw new AggregateError(
          [
          driverFailure.error,
          cleanup
        ],
          "The agent stopped with an error and its cleanup was not confirmed"
        );
        throw cleanup;
      }
      if (driverFailure) throw driverFailure.error;

      const current = this.k.task(taskId);
      if (!current) throw new Error("The task is gone");
      if (scope!.work.conversation?.step !== conversation.step || scope!.work.conversation.sessionId !== conversation.sessionId) {
        // The step handed back its result just as the coordinator took over: the next one starts as usual.
        this.backToWork(current);
        throw new Error("The agent finished its step just as you took over. Take over again on its next step if you want to.");
      }
      const worktree = this.k.agentWorktree(current);
      let saved: { sha: string; files: string[] } | undefined;
      try {
        let head: string;
        if (conversation.access?.canEdit ?? role.canEdit) {
          const before = await git.head(worktree);
          const files = (await git.changedSince(worktree, before)).map((entry) => entry.file);
          let sha: string | undefined;
          let tree: string | undefined;
          if (files.length && await git.commitChanges(
            worktree,
            `${current.title} (unfinished work)\n\nThe ${role.name}'s unfinished work, saved by Petrina before the coordinator took over in their terminal. The ${role.name} finishes it after the hand back.\n\nSaved by Petrina: ${this.k.describe(
            role.id,
            profile.id
          )}`
          )) {
            const committed = await git.commitVersion(worktree);
            sha = committed.head ?? await git.head(worktree);
            tree = committed.tree;
          }
          if (sha) saved = { sha, files };
          head = sha ?? before;
          if (worktree === scope!.work.worktree) {
            if (sha && tree) await this.k.rememberVersion(scope!, { head: sha, tree });
            else if (scope!.work.savedVersion?.commit !== head) await this.k.rememberVersion(scope!);
          }
        } else {
          await this.k.undoReadOnly(current, role.id, worktree);
          head = await git.head(worktree);
        }
        const repositoryCopies = conversation.repositoryCopies ? Object.fromEntries(await Promise.all(Object.entries(conversation.repositoryCopies).map(async ([id, path]) => [
          id,
          {
          path,
          head: path === worktree ? head : await git.head(path)
        }
        ]))) : undefined;
        current.driving = {
          ...(repositoryCopies ? { repositoryCopies } : {}),
          since: Date.now(),
          roleId: role.id,
          profileId: profile.id,
          toolId: profile.toolId,
          head,
          ...(saved ? { saved } : {})
        };
      } catch (error) {
        // The agent has stopped, but the working copy is not ready for the coordinator: the agent carries on instead.
        this.k.log(
          current,
          "warn",
          `Could not get the working copy ready for you, so the ${role.name} carries on: ${error instanceof Error ? error.message : String(error)}`,
          role.id,
          profile.id
        );
        this.backToWork(current);
        throw new Error(`Petrina couldn't save the ${role.name}'s work before you took over, so the ${role.name} carries on. ${error instanceof Error ? error.message : String(error)}`);
      }
      delete scope!.work.conversation.asked;
      scope!.work.conversation.handbackBoot = this.k.boot;
      current.agent = agent as RuntimeTask["agent"];
      current.holdsSlot = true;
      current.statusLine = TAKE_OVER_WORDS.status;
      // The coordinator's own time in the terminal is not the agent's: its clock goes on after the hand back.
      this.k.pauseStep(current);
      this.k.raise(current, "driving", `Hand back “${current.title}” when you're done`, false, {
        body: `${tool.name} is open in your terminal on the ${role.name}'s conversation. Close it there, then hand back: the ${role.name} carries on from what you did.`,
      });
      if (saved) this.k.log(
        current,
        "milestone",
        `Saved the ${role.name}'s unfinished work as one commit (${saved.files.length} file${saved.files.length === 1 ? "" : "s"})`,
        role.id,
        profile.id
      );
      this.k.log(current, "you", `You took over the ${role.name} in your terminal`, role.id, profile.id);
      this.k.say(current, "system", `You took over in your terminal · ${tool.name} on the ${role.name}'s conversation`, role.id, profile.id);
      this.k.commitNow();
      return await this.launch(current, terminal, true, tool);
    } catch (error) {
      // A failed handoff cannot leave a ghost running seat or offer another start
      // in the working copy whose cleanup remains uncertain.
      if ((driverFailure || this.k.agentCleanup.has(taskId)) && this.k.task(taskId)?.state !== "failed") this.k.fail(taskId, error);
      throw error;
    } finally {
      this.k.switching.delete(taskId);
    }
  }

  /** The agent stopped for a take-over that did not happen: the step starts again as usual, picking its conversation back up. */
  private backToWork(task: RuntimeTask): void {
    delete task.agent;
    task.holdsSlot = false;
    this.k.toWaiting(task);
    this.k.commitNow();
    this.k.schedule();
  }

  /**
   * Open the terminal again, or get the command again. Never a second copy: refused while one runs, and
   * while Petrina is still opening one or handing back.
   */
  async reopenTerminal(taskId: Id, how: "open" | "copy" = "open"): Promise<Launched> {
    const task = this.k.task(taskId);
    if (!task?.driving) throw new Error("You're not driving this task");
    this.notSwitching(taskId);
    const terminal = how === "open" ? pickTerminal(this.k.found, this.k.s.terminal) : undefined;
    if (how === "open" && !terminal) throw new Error(TAKE_OVER_WORDS.noTerminal);
    this.k.switching.set(taskId, "reopening");
    try {
      const tool = toolName(task.driving.toolId);
      if ((await sessionState(this.takeOverDir(taskId), this.k.machine.platform)) === "running") throw new Error(TAKE_OVER_WORDS.alreadyOpen(tool));
      if (!task.driving) throw new Error("You're not driving this task");
      return await this.launch(task, terminal, false);
    } finally {
      this.k.switching.delete(taskId);
    }
  }

  /** What hand back would find: whether the tool is still open, the branch, and what changed since the take-over. */
  async handBackPreview(taskId: Id): Promise<HandBackPreview> {
    const task = this.k.task(taskId);
    if (!task?.driving) throw new Error("You're not driving this task");
    const driving = task.driving;
    const worktree = this.k.agentWorktree(task);
    const [open, where, files, commits, clean] = await Promise.all([
      sessionState(this.takeOverDir(taskId), this.k.machine.platform),
      git.workingState(worktree),
      git.changedSince(worktree, driving.head),
      git.commitsSince(worktree, driving.head),
      git.isClean(worktree),
    ]);
    const problem = this.branchProblem(task, where);
    return {
      open,
      tool: toolName(driving.toolId),
      ...(problem ? { problem } : {}),
      commits,
      files: files.length,
      names: files.slice(0, 5).map((entry) => entry.file),
      unsaved: !clean,
      ...(driving.saved ? { saved: { files: driving.saved.files.length, names: driving.saved.files.slice(0, 3) } } : {}),
    };
  }

  /**
   * The coordinator closed the tool and hands the step back. Refused while Petrina can see the tool
   * running ("anyway" only counts when it cannot tell), or when the working copy left the task's branch.
   * What they left unsaved becomes one commit marked as theirs, never undone. The note of what changed
   * goes into the session, the timeline and the task's notes. If files changed, the tests check runs at
   * once and nothing ships before a review chain has looked at them. Then the same agent carries on with
   * the same step, on the same conversation when its tool can reopen it.
   */
  async handBack(taskId: Id, note = "", anyway = false): Promise<void> {
    const task = this.k.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    if (!task?.driving) throw new Error("You're not driving this task");
    this.notSwitching(taskId);
    this.k.switching.set(taskId, "handing back");
    try {
      const driving = task.driving;
      const tool = toolName(driving.toolId);
      const dir = this.takeOverDir(taskId);
      const open = await sessionState(dir, this.k.machine.platform);
      if (open === "running") throw new Error(TAKE_OVER_WORDS.stillOpen(tool));
      if (open === "unknown" && !anyway) throw new Error(TAKE_OVER_WORDS.cannotTell(tool));
      const worktree = this.k.agentWorktree(task);
      const problem = this.branchProblem(task, await git.workingState(worktree));
      if (problem) throw new Error(problem);
      const role = this.k.role(driving.roleId)!;
      const [commits, files, status] = await Promise.all([
        git.commitsSince(
        worktree,
        driving.head
      ),
        git.changedSince(
        worktree,
        driving.head
      ),
        git.worktreeStatus(worktree)
      ]);
      let leftovers: string | undefined;
      let leftoverTree: string | undefined;
      if (!status.clean && await git.commitChanges(
        worktree,
        `${task.title} (changes made by hand)\n\nMade by the coordinator in their own terminal while driving the ${role.name}, and saved by Petrina at the hand back.\n\nDriven by hand: ${this.k.describe(
        role.id,
        driving.profileId
      )}`
      )) {
        const committed = await git.commitVersion(worktree);
        leftovers = committed.head ?? await git.head(worktree);
        leftoverTree = committed.tree;
      }
      const text = handBackNote({
        role: role.name,
        tool,
        took: Date.now() - driving.since,
        ...(driving.saved ? { saved: driving.saved.files } : {}),
        commits,
        files,
        leftovers: leftovers !== undefined,
        note
      });
      const head = leftovers ?? status.head;
      if (!head) throw new Error("The working copy has no saved commit. Restore it in your terminal, then hand back again.");

      const changedProducts = new Set<Id>(files.length ? [scope!.work.productId] : []);
      const knownHeads: Record<Id, string> = worktree === scope!.work.worktree ? { [scope!.work.productId]: head } : {};
      if (task.repositories && driving.repositoryCopies) {
        const inspected = await completeAll(Object.entries(driving.repositoryCopies).map(async ([id, copy]) => {
          const work = task.repositories!.find(entry => entry.productId === id);
          if (!work?.worktree || copy.path === work.worktree) return undefined;
          const copyStatus = await git.worktreeBranchStatus(copy.path);
          if (copyStatus.branch) throw new Error(`Keep ${work.source!.product.name} on its saved review snapshot, then hand back again.`);
          if (!copyStatus.clean) await git.commitChanges(copy.path, `${task.title} (changes made by hand)`);
          if (!(await git.changedSince(copy.path, copy.head)).length) return undefined;
          const [copyHead, parent] = await Promise.all([
            copyStatus.clean && copyStatus.head ? Promise.resolve(copyStatus.head) : git.head(copy.path),
            git.head(work.worktree),
          ]);
          const merged = await git.mergeTree(work.worktree, parent, copyHead);
          if (!merged || merged.conflicts.length) throw new Error(`Your changes to ${work.source!.product.name} overlap with its task copy. Resolve them in the snapshot, then hand back again.`);
          return {
            work,
            head: copyHead,
            tree: merged.tree,
            sha: await git.commitTree(
            work.worktree,
            merged.tree,
            parent,
            `${task.title} (changes made by hand)`
          )
          };
        }));
        const prepared = inspected.filter(entry => entry !== undefined);
        // Validate every product before advancing task copies. Keep the old snapshot anchors
        // until every advance succeeds, so a partial failure remains visible on the next hand-back.
        await completeAll(prepared.map(async kept => {
          await git.moveTo(kept.work.worktree!, kept.sha);
          await this.k.rememberVersion({ task, work: kept.work }, { head: kept.sha, tree: kept.tree });
          knownHeads[kept.work.productId] = kept.sha;
          changedProducts.add(kept.work.productId);
          invalidateHandEditedRepositoryWork(task, kept.work);
        }));
        for (const kept of prepared) {
          driving.repositoryCopies[kept.work.productId]!.head = kept.head;
        }
      }
      // A reviewer works detached from the task's branch. Keep the coordinator's edits in both:
      // its conversation continues in its own copy, and the task's later checks and reviews see them.
      let primaryRemembered: {
        head: string;
        tree: string
      } | undefined = worktree === scope!.work.worktree && leftovers && leftoverTree ? {
        head: leftovers,
        tree: leftoverTree
      } : undefined;
      if (files.length && worktree !== scope!.work.worktree && (!task.repositories || !driving.repositoryCopies)) {
        const parent = await git.head(scope!.work.worktree!);
        const merged = await git.mergeTree(scope!.work.worktree!, parent, head);
        if (!merged || merged.conflicts.length) throw new Error("Your changes overlap with the task's working copy. Resolve them in the reviewer's copy, then hand back again.");
        const kept = await git.commitTree(scope!.work.worktree!, merged.tree, parent, `${task.title} (changes made by hand)\n\n${text}`);
        await git.moveTo(scope!.work.worktree!, kept);
        knownHeads[scope!.work.productId] = kept;
        primaryRemembered = { head: kept, tree: merged.tree };
      }

      if (primaryRemembered) await this.k.rememberVersion(scope!, primaryRemembered);
      else if (!(worktree === scope!.work.worktree && !files.length && scope!.work.savedVersion?.commit === head)) await this.k.rememberVersion(scope!);
      this.k.say(task, "system", `You handed back to the ${role.name}`, role.id, driving.profileId);
      this.k.say(task, "you", text);
      const changed = files.length ? `${files.length} file${files.length === 1 ? "" : "s"} changed in ${commits + (leftovers ? 1 : 0)} commit${commits + (leftovers ? 1 : 0) === 1 ? "" : "s"}` : "nothing changed";
      this.k.log(task, "you", `You handed back to the ${role.name}: ${changed}${note.trim() ? `. Your note: ${note.trim()}` : ""}`, role.id, driving.profileId);
      this.k.remember(task, text);
      // The conversation carries on from here, and a read-only role's clean-up keeps everything done by hand.
      if (scope!.work.conversation) {
        scope!.work.conversation.head = head;
        scope!.work.conversation.handback = text;
      }
      if (changedProducts.size) await this.reviewHandChanges(task, [...changedProducts], knownHeads);
      delete task.driving;
      this.k.s.inbox = this.k.s.inbox.filter((item) => !(item.taskId === taskId && item.kind === "driving"));
      await removeLauncher(dir);
      task.state = "running";
      task.holdsSlot = true;
      task.statusLine = `${role.name} is getting back to work`;
      this.k.commitNow();
      // Hand-back saves the coordinator's work as usual, but a runtime wait defers reopening the agent.
      if (runtimeWaitHolds(task)) {
        this.k.waitForUsage(task, this.k.taskAdmissionWait(task));
        this.k.schedule();
      } else this.k.startDriver(taskId, true);
    } finally {
      this.k.switching.delete(taskId);
    }
  }

  /**
   * Files changed by hand: the tests check on the whole branch right away, and nothing ships until a
   * review chain has looked at them from its first reviewer. A chain still ahead does that as planned.
   * Otherwise the chain the coordinator drove in, or the last one behind, runs again once the step
   * they drove finishes, without using up a review round.
   */
  private async reviewHandChanges(task: RuntimeTask, changedProducts: readonly Id[], knownHeads?: Readonly<Record<Id, string>>): Promise<void> {
    const inspected = await Promise.all(changedProducts.map(async (productId) => {
      const scope = executionFor(task, productId);
      const known = knownHeads?.[productId];
      const [problems, sha] = await Promise.all([
        git.tamperCheck(
          scope.work.worktree!,
          scope.work.baseSha ?? scope.work.base!,
        ),
        known ? Promise.resolve(known) : git.head(scope.work.worktree!),
      ]);
      return { productId, problems, sha };
    }));
    const outcomes = applyTakeOverHandChanges(task, inspected, {
      nextFindingId: () => this.k.id(task.id),
    });
    for (const { scope, problems } of outcomes) {
      this.k.log(
        scope,
        problems.length ? "warn" : "done",
        problems.length
          ? `Tests check on your changes: ${problems.length} problem${problems.length === 1 ? "" : "s"}`
          : "Tests check on your changes passed: no tests removed or skipped",
      );
    }
  }

  /** One take-over step at a time per task: taking over, opening the terminal again, or handing back. */
  private notSwitching(taskId: Id): void {
    const busy = this.k.switching.get(taskId);
    if (busy) throw new Error(TAKE_OVER_WORDS.busy[busy]);
  }

  /** "You're driving" in the inbox only goes with a hand back. */
  notDrivingItem(itemId: Id): void {
    if (this.k.s.inbox.some((entry) => entry.id === itemId && entry.kind === "driving")) throw new Error(TAKE_OVER_WORDS.handBackFirst);
  }

  notDriving(task: RuntimeTask | undefined): void {
    if (task && (task.driving || this.k.switching.has(task.id))) throw new Error(TAKE_OVER_WORDS.handBackFirst);
  }

  /** The tool's own app, as found on this machine, and for Claude Code the name its installed copy gives its ask-before-acting mode. */
  private async takeOverTool(toolId: Id): Promise<LaunchInput["tool"]> {
    const adapter = ADAPTERS[toolId];
    const path = adapter && TAKE_OVER_TOOLS[toolId]
      ? this.k.options.toolPath?.(toolId) ?? (this.k.options.requireAgentCommand ? undefined : Bun.which(adapter.cli))
      : undefined;
    if (!adapter || !path) throw new Error(TAKE_OVER_WORDS.missing(toolName(toolId)));
    const id = toolId as LaunchInput["tool"]["id"];
    const mode = adapter.resolveTerminalMode ? await adapter.resolveTerminalMode(path) : undefined;
    return { id, name: adapter.name, path, ...(mode ? { mode } : {}) };
  }

  /** The launcher's folder: only the coordinator can read it, and it goes at hand back. */
  private takeOverDir(taskId: Id): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(taskId)) throw new Error("Unknown task");
    return join(this.k.dataDir, "takeover", taskId);
  }

  private launchInput(task: RuntimeTask, tool: LaunchInput["tool"], sessionId: string, model: string, effort: string): LaunchInput {
    return { platform: this.k.machine.platform, dir: this.takeOverDir(task.id), worktree: this.k.agentWorktree(task), tool, sessionId, model, effort };
  }

  /** Write the launcher and open it in the terminal, or only write it for the coordinator to run. */
  private async launch(task: RuntimeTask, terminal: FoundTerminal | undefined, fresh: boolean, tool?: LaunchInput["tool"]): Promise<Launched> {
    const scope = executionFor(task);
    const driving = task.driving!;
    const conversation = scope.work.conversation!;
    const effort = this.k.profile(driving.profileId)?.effort ?? "high";
    const dir = this.takeOverDir(task.id);
    const plan = launchPlan(this.launchInput(task, tool ?? (await this.takeOverTool(driving.toolId)), conversation.sessionId, conversation.model, effort));
    // Opening again: until the new copy reports, Petrina can't tell, so an old "it has closed" never lets a hand back through.
    if (!fresh) await clearEnded(dir, this.k.machine.platform);
    await writeLauncher(plan, dir, fresh);
    if (!terminal) {
      delete driving.terminal;
      delete driving.problem;
      this.k.commit();
      return { command: plan.copy };
    }
    const problem = await openTerminal(terminal, plan.file);
    driving.terminal = terminal.name;
    if (problem) {
      driving.problem = problem;
      this.k.log(task, "warn", `${problem}. Reopen the terminal, or copy the command and run it yourself`);
    } else {
      delete driving.problem;
    }
    this.k.commit();
    return { command: plan.copy, terminal: terminal.name, ...(problem ? { problem } : {}) };
  }

  /** Why hand back cannot go on with the working copy as it is, in plain words. */
  private branchProblem(task: RuntimeTask, where: { branch?: string; busy?: string }): string | undefined {
    const scope = executionFor(task);
    return takeOverBranchProblem(scope.work, this.k.agentWorktree(task), where);
  }
}
