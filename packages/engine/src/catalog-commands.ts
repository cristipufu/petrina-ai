// Coordinator commands for profiles, routines, roles, products, terminals and first-run setup.

import { randomUUID } from "node:crypto";
import { opendirSync, realpathSync, rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as library from "@petrina/core";
import {
  applyProductSettings,
  fixFor,
  isGuide,
  productHistory,
  productName,
  SETUP_STEPS,
  suggestProductName,
  type Clone,
  type DeliveryMode,
  type Id,
  type NewTaskInput,
  type ProductSettings,
  type RoleChanges,
  type RoleDraft,
  type SetupStep,
} from "@petrina/core";
import { resolveMaintenanceSettings, scopesFor } from "@petrina/orchestrator";
import { pickLocalFolder } from "@petrina/platform/folder-picker";
import { expandPath, findClones } from "@petrina/repositories/discovery";
import * as git from "@petrina/repositories/git";
import type { Engine } from "./engine.js";
import { TONES, type RuntimeTask } from "./kernel.js";
import { browserCommand } from "./setup.js";
import type { ToolChecks } from "./tool-checks.js";

export class CatalogCommands {
  private pickingFolder: Promise<string | null> | undefined;

  constructor(
    private readonly engine: Engine,
    private readonly tools: ToolChecks,
    private readonly createTask: (input: NewTaskInput) => Id,
  ) {}

  async saveProfile(draft: library.ProfileDraft, clientId: Id, profileId?: Id): Promise<Id> {
    const choices = await this.engine.profileChoices({ toolId: draft.toolId, modelId: draft.modelId });
    if (this.engine.stopped) throw new Error("The engine is stopping.");
    if (profileId) this.assertProfileNotRunning(profileId);
    const id = library.saveProfile(this.engine.s, draft, choices, clientId, profileId);
    this.engine.s.planner = this.engine.onUsable(this.engine.s.planner ?? "opus-high");
    this.engine.commitNow();
    return id;
  }

  private assertProfileNotRunning(profileId: Id): void {
    for (const task of this.engine.s.tasks) {
      const runningWithProfile = this.engine.drivers.has(task.id)
        && task.plan?.stages.some((stage) => [...stage.profileIds, ...(stage.reviewerProfileIds ?? [])].includes(profileId));
      if (runningWithProfile) {
        throw new Error("Wait for this profile's task to finish stopping before changing it.");
      }
    }
  }

  removeProfile(profileId: Id): void {
    this.assertProfileNotRunning(profileId);
    library.removeProfile(this.engine.s, profileId);
    this.engine.s.planner = this.engine.onUsable(this.engine.s.planner ?? "opus-high");
    this.engine.commitNow();
  }

  saveRoutine(draft: library.RoutineDraft, routineId?: Id): Id {
    const previous = routineId ? this.engine.s.routines?.find((r) => r.id === routineId) : undefined;
    if (routineId && !previous) {
      throw new Error("That routine was removed. Close this editor and create a new routine.");
    }
    const id = routineId ?? `routine-${randomUUID()}`;
    const next = library.saveRoutine(draft, this.engine.s, id, Date.now(), previous);
    this.engine.s.routines = [
      ...(this.engine.s.routines ?? []).filter((r) => r.id !== id),
      next,
    ] as typeof this.engine.s.routines;
    this.engine.commitNow();
    return id;
  }

  setRoutineEnabled(routineId: Id, enabled: boolean): void {
    const routine = this.engine.s.routines?.find((r) => r.id === routineId);
    if (!routine) throw new Error("That routine was removed.");
    // Disable remains available even if a reference has disappeared.
    if (!enabled) {
      routine.enabled = false;
      this.engine.commitNow();
      return;
    }
    this.saveRoutine({ ...routine, enabled }, routineId);
  }

  removeRoutine(routineId: Id): void {
    this.engine.s.routines = (this.engine.s.routines ?? []).filter((r) => r.id !== routineId);
    this.engine.commitNow();
  }

  resolveMaintenanceSettings(taskId: Id, choice: "keep" | "stop"): void {
    resolveMaintenanceSettings(
      {
        note: (task, text) => this.engine.log(task, "you", text),
        removeDecision: (id) => {
          this.engine.s.inbox = this.engine.s.inbox.filter(
            (item) => !(item.taskId === id && item.kind === "maintenance-settings"),
          );
        },
        cancel: (id) => this.engine.cancel(id),
        checkpoint: (task) => this.engine.commitNow(task),
        schedule: () => this.engine.schedule(),
      },
      this.engine.task(taskId),
      choice,
    );
  }

  /** A synchronous admission decision, saved before the ordinary driver sees it. */
  pollRoutines(now = Date.now()): void {
    if (this.engine.stopped) return;
    const before = structuredClone(this.engine.s.routines);
    const ids = new Set(this.engine.s.tasks.map((t) => t.id));
    try {
      const changed = library.admitRoutines(this.engine.s, now, (routine, scheduledAt) => {
        const id = this.createTask({
          productId: routine.productId,
          title: routine.name,
          kind: "chore",
          approvePlan: false,
          approveDelivery: true,
        });
        const task = this.engine.task(id)!;
        library.prepareMaintenanceTask(task, routine, this.engine.s as library.State, scheduledAt, now);
        this.engine.log(
          task,
          "milestone",
          `Queued by routine “${routine.name}” for ${library.occurrenceText(scheduledAt, routine.zone)}`,
        );
        return id;
      });
      if (changed) this.engine.commitNow();
    } catch (error) {
      this.engine.s.routines = before;
      this.engine.s.tasks = this.engine.s.tasks.filter((t) => ids.has(t.id));
      throw error;
    }
  }

  saveRole(roleId: Id, draft: RoleDraft): void {
    this.changeRoles((changes) => library.editRole(changes, roleId, draft));
  }

  addRole(draft: RoleDraft): Id {
    let created = "";
    this.changeRoles((changes) => {
      const added = library.addRole(changes, draft);
      created = added.roleId;
      return added.changes;
    });
    return created;
  }

  resetRole(roleId: Id): void {
    this.changeRoles((changes) => library.resetRole(changes, roleId));
  }

  /** Planned tasks still run a removed role, and past ones still show its name and icon. */
  removeRole(roleId: Id): void {
    const used = this.engine.s.tasks.some((task) => library.planUses(task, roleId))
      || this.engine.store.history.usesRole(roleId);
    this.changeRoles((changes) => library.removeRole(changes, roleId, used));
  }

  private changeRoles(change: (changes: RoleChanges) => RoleChanges): void {
    const next = change((this.engine.s.roleChanges ?? library.NO_ROLE_CHANGES) as RoleChanges);
    // New role objects every time: agents already working keep the ones they started with.
    this.engine.s.roleChanges = next as typeof this.engine.s["roleChanges"];
    this.engine.s.roles = library.libraryRoles(next) as typeof this.engine.s["roles"];
    this.engine.commitNow();
  }

  async addProduct(input: string, name?: string): Promise<Id> {
    const shown = input.trim();
    const path = expandPath(shown, this.engine.options.home);
    const found = await stat(path).catch(() => undefined);
    if (!found) throw new Error(`There is no folder at ${shown}.`);
    if (!found.isDirectory()) {
      throw new Error(`${shown} is a file, so pick the folder you cloned the product into.`);
    }
    // Checked without running Git, so a Mac without Apple's developer tools never opens their installer.
    if (this.tools.status("git") !== "ready") await this.tools.check("git");
    if (this.tools.status("git") === "not-installed") {
      const platform = this.engine.s.setup?.platform ?? "linux";
      const terminal = platform === "win32" ? "a terminal" : "Terminal";
      throw new Error(
        `Petrina needs Git to add a product, and Git isn't installed: run ${fixFor("git", "not-installed", platform)!.command} in ${terminal}, then try again.`,
      );
    }
    let info: git.RepoInfo;
    try {
      info = await git.repoInfo(path);
    } catch {
      throw new Error("That folder isn't a copy of a repository, so pick the folder you cloned the product into.");
    }
    const existing = this.engine.s.products.find((product) => product.path === info.root);
    if (existing) return existing.id;
    const displayName = productName(name ?? suggestProductName(info.root), this.engine.s.products);
    const base = info.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "product";
    // An id is never handed out again: not one in use, not a removed product's, not one in the work log.
    let id = base;
    for (let n = 2; this.engine.tracking.productIdTaken(id); n += 1) id = `${base}-${n}`;
    this.engine.tracking.product({ id, name: displayName, repo: `${info.owner}/${info.name}` }, { addedAt: Date.now() });
    this.engine.s.products.push({
      id,
      name: displayName,
      repo: `${info.owner}/${info.name}`,
      // Exactly as configured now: every fetch and push with the coordinator's login goes to this address.
      ...(info.remote ? { remote: info.remote } : {}),
      tone: TONES[this.engine.s.products.length % TONES.length]!,
      path: info.root,
      defaultBranch: info.defaultBranch,
      delivery: info.github ? "pull-request" : "local",
      approveDelivery: true,
    });
    this.engine.commitNow();
    return id;
  }

  setProductDelivery(productId: Id, delivery: DeliveryMode, approveDelivery: boolean): void {
    const product = this.engine.s.products.find((entry) => entry.id === productId);
    if (!product) return;
    this.engine.updateProduct(productId, { name: product.name, delivery, approveDelivery });
  }

  setProductChecks(productId: Id, checks: readonly { name: string; command: string }[] | null): void {
    const engine = this.engine;
    const executions = function* () {
      for (const task of engine.s.tasks) for (const { work } of scopesFor(task)) yield work;
    };
    library.configureProductChecks(
      this.engine.s.products.find((product) => product.id === productId),
      checks,
      executions(),
    );
    this.engine.commit();
  }

  setProductCheckSetup(productId: Id, requirements: readonly library.CheckPrerequisite[]): void {
    const engine = this.engine;
    const executions = function* () {
      for (const task of engine.s.tasks) for (const { work } of scopesFor(task)) yield { taskId: task.id, work };
    };
    const changed = library.configureProductCheckSetup(
      this.engine.s.products.find((product) => product.id === productId),
      requirements,
      executions(),
      { id: (prefix) => this.engine.id(prefix), now: () => Date.now() },
    );
    if (changed) this.engine.commitNow();
  }

  setProductRemoteChecks(productId: Id, checks: readonly string[]): void {
    const engine = this.engine;
    const executions = function* () {
      for (const task of engine.s.tasks) for (const { work } of scopesFor(task)) yield work;
    };
    const changed = library.configureProductRemoteChecks(
      this.engine.s.products.find((product) => product.id === productId),
      checks,
      executions(),
    );
    if (changed) this.engine.commitNow();
  }

  updateProduct(productId: Id, settings: ProductSettings): void {
    const product = this.engine.s.products.find((entry) => entry.id === productId);
    if (!product) throw new Error("This product is no longer in Petrina.");
    applyProductSettings(product, settings, this.engine.s.products);
    // The permanent list keeps the latest name, so a removed product shows under the name it last had.
    this.engine.tracking.product(product);
    this.engine.commit();
  }

  removeProduct(productId: Id): void {
    const outstanding = this.engine.extraValidations.outstanding(productId);
    if (outstanding) {
      throw new Error(
        `Extra validation “${outstanding.name}” still needs this product for cleanup. Wait for it to finish and cleanup to be confirmed before removing the product.`,
      );
    }
    const { unfinished } = productHistory(this.engine.s.tasks, productId);
    if (unfinished) {
      throw new Error(
        `${unfinished} task${unfinished === 1 ? " must" : "s must"} finish or be cancelled before this product can be removed.`,
      );
    }
    const product = this.engine.s.products.find((entry) => entry.id === productId);
    if (!product) return;
    this.engine.activeState();
    const tasks = this.engine.s.tasks.flatMap((task) => {
      const retained = library.withoutProduct(task, productId);
      return retained ? [retained as RuntimeTask] : [];
    });
    const ids = new Set(
      this.engine.s.tasks.filter((task) => !tasks.some((kept) => kept.id === task.id)).map((task) => task.id),
    );
    // History may contain millions of finished tasks, while picture folders exist only where
    // there are actual bytes to remove. Read membership for those folders, never the full archive.
    try {
      const captures = opendirSync(join(this.engine.dataDir, "captures"));
      try {
        for (let entry = captures.readSync(); entry; entry = captures.readSync()) {
          if (!entry.isDirectory() || ids.has(entry.name)) continue;
          const item = this.engine.store.history.item(entry.name);
          const products = item?.productIds ?? (item ? [item.productId] : []);
          if (products.length === 1 && products[0] === productId) ids.add(entry.name);
        }
      } finally {
        captures.closeSync();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = {
      ...this.engine.activeState(),
      inbox: this.engine.s.inbox.filter((item) => {
        const archived = this.engine.store.history.item(item.taskId);
        const products = archived?.productIds ?? (archived ? [archived.productId] : []);
        return !ids.has(item.taskId) && !(products.length === 1 && products[0] === productId);
      }),
      tasks,
      products: this.engine.s.products.filter((entry) => entry.id !== productId),
      ...(this.engine.s.work ? { work: { ...this.engine.s.work, version: this.engine.s.work.version + 1 } } : {}),
    };
    // Save all three changes together before showing removal. A failed disk write leaves the live
    // product, its history, and the permanent product record exactly as they were.
    this.engine.store.removeProduct(productId, next, () =>
      this.engine.tracking.log.recordProduct({
        id: product.id,
        name: product.name,
        repo: product.repo,
        removedAt: Date.now(),
      }),
    );
    this.engine.s.inbox = next.inbox;
    this.engine.s.tasks = next.tasks;
    this.engine.s.products = next.products;
    this.engine.s.work = next.work;
    this.engine.forgetProductHistory(productId);
    for (const id of ids) rmSync(join(this.engine.dataDir, "captures", id), { recursive: true, force: true });
    this.engine.commit();
  }

  async findClones(): Promise<Clone[]> {
    const real = (path: string) => {
      try {
        // Native resolution also expands Windows short names, which Git reports in their full form.
        return realpathSync.native(path);
      } catch {
        return path;
      }
    };
    const added = new Set(
      this.engine.s.products
        .map((product) => product.path)
        .filter((path): path is string => !!path)
        .map(real),
    );
    return findClones({
      ...(this.engine.options.home ? { home: this.engine.options.home } : {}),
      skip: (path) => added.has(real(path)),
    });
  }

  pickFolder(): Promise<string | null> {
    if (this.pickingFolder) return this.pickingFolder;
    const run = (
      this.engine.options.pickFolder
        ? this.engine.options.pickFolder()
        : pickLocalFolder({
            signal: this.engine.stopRequested.signal,
            ...(this.engine.options.home ? { home: this.engine.options.home } : {}),
          })
    ).finally(() => {
      if (this.pickingFolder === run) this.pickingFolder = undefined;
    });
    this.pickingFolder = run;
    return run;
  }

  setSetupStep(step: SetupStep): void {
    const setup = this.engine.s.setup;
    const order = (value: SetupStep | undefined) =>
      SETUP_STEPS.findIndex((entry) => entry.id === (value ?? "welcome"));
    if (!setup || setup.done || order(step) <= order(setup.step)) return;
    setup.step = step;
    this.engine.commitNow();
  }

  skipSetup(): void {
    if (!this.engine.s.setup || this.engine.s.setup.done) return;
    this.engine.s.setup.done = true;
    this.engine.commitNow();
  }

  dismissTip(): void {
    if (!this.engine.s.setup || this.engine.s.setup.tipDismissed) return;
    this.engine.s.setup.tipDismissed = true;
    this.engine.commit();
  }

  openGuide(url: string): void {
    if (!isGuide(url)) throw new Error("Petrina only opens the guides it links to.");
    Bun.spawn(browserCommand(url), { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
  }

  setTerminal(terminalId: Id): void {
    if (!terminalId) delete this.engine.s.terminal;
    else if (this.engine.found.some((terminal) => terminal.id === terminalId)) this.engine.s.terminal = terminalId;
    else throw new Error("That terminal is not on this machine");
    this.engine.commit();
  }
}
