import { completeAll } from "./parallel.js";
import { createTaskState, queueBacklogTask, returnQueuedTaskToBacklog, editBacklogRequest, combineBacklogTasks, validateTaskDependencies, assignFutureProfile, appendFutureReviewer, pauseTaskState, resumeTaskState, cancelTaskState } from "@petrina/core";
import { executionFor, scopesFor } from "./repository-context.js";
// The real engine: the same state the UI renders, driven by real agents over ACP.
// Each task runs as one async driver while it holds a pool slot. Gates and the queue
// live in state; questions and permissions wait on the coordinator in code.
// Three rules make restarts safe: what the coordinator says during a step is on disk before any
// agent sees it, and kept until the step finishes; each step's conversation is noted the moment it
// opens, so its agent picks it up after a restart; and shipping is never repeated blindly.
//
// Engine is the thin front: the coordinator's commands live here. Each part of the work lives in a
// module of its own (driver, planning, design, work, review, shipping, take-over, product checks,
// review guide, tools check, turns, context), and they share state and bookkeeping through the kernel.

import { opendirSync, realpathSync, rmSync, renameSync } from "node:fs";
import { join } from "node:path";
import { stat, mkdir, copyFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { combinedBacklogInput } from "@petrina/core";
import { routeMessages } from "./messages.js";
import {
  AFTER_WORDS,
  endYouStep,
  fixFor,
  isGuide,
  JOURNEY_WORDS as W,
  legacyJourney,
  productHistory,
  productName,
  queueNeighbour,
  queueOf,
  queuePlacement,
  SCREEN_HOUR_MS,
  SCREEN_WORDS,
  settleAsk,
  SETUP_STEPS,
  suggestProductName,
  syncWait,
  stopCheckProgress,
  validateProductSettings,
  type AskAnswer,
  type CheckId,
  type Clone,
  type Commands,
  type DeliveryMode,
  type HandBackPreview,
  type Id,
  type InboxItem,
  type Launched,
  type NewTaskInput,
  type ProductSettings,
  type SaidContext,
  type ScreenMode,
  type SetupStep,
  type Task,
  type UsageRequest,
  type UsageViewFor,
  type RoleChanges,
  type RoleDraft,
  type WorkChoice,
} from "@petrina/core";
import * as library from "@petrina/core";
import * as git from "./git.js";
import { parseCommand } from "./checks.js";
import { CODEX_USAGE_EVERY_MS } from "./codex-usage.js";
import { Kernel, TONES, type EngineOptions, type MTask } from "./kernel.js";
import { browserCommand, expandPath, findClones } from "./setup.js";
import { ToolChecks } from "./tool-checks.js";
import { Turns } from "./turn.js";
import { GuideKeeper } from "./guide-keeper.js";
import { Context } from "./context.js";
import { ProductChecks } from "./product-checks.js";
import { CARRIED_OVER, Shipping } from "./shipping.js";
import { Connections } from "./connection.js";
import { Updates } from "./update.js";
import { Learnings } from "./learnings.js";
import { Reviews } from "./review.js";
import { Design } from "./design.js";
import { Planning } from "./planning.js";
import { Work } from "./work.js";
import { TakeOver } from "./take-over.js";
import { Sources } from "./sources.js";
import { Driver } from "./driver.js";
import { Checkpoints } from "./checkpoints.js";
import { Cleanup } from "./cleanup.js";
import { FollowUps } from "./follow-ups.js";
import { AcceptedPoints } from "./accepted-points.js";
import { readTaskImage } from "./image-preview.js";

export type { EngineOptions } from "./kernel.js";
export type { NewTaskInput, SaidContext } from "@petrina/core";
export { recordDisputes } from "./review.js";

/** The engine: every command the window can send (Commands) is a method here. */
export class Engine extends Kernel implements Commands {
  private readonly tools: ToolChecks;
  private readonly sources: Sources;
  private readonly turns: Turns;
  private readonly guide: GuideKeeper;
  private readonly context: Context;
  private readonly checks: ProductChecks;
  private readonly shipping: Shipping;
  private readonly connections: Connections;
  private readonly updates: Updates;
  private readonly learnings: Learnings;
  private readonly reviews: Reviews;
  private readonly design: Design;
  private readonly planning: Planning;
  private readonly work: Work;
  private readonly takeover: TakeOver;
  private readonly driver: Driver;
  private readonly checkpoints: Checkpoints;
  private readonly cleanup: Cleanup;
  private readonly followUps: FollowUps;
  private readonly acceptedPoints: AcceptedPoints;

  constructor(dataDir: string, options: EngineOptions = {}) {
    super(dataDir, options);
    this.tools = new ToolChecks(this);
    this.connections = new Connections(this);
    this.sources = new Sources(this, this.connections);
    this.turns = new Turns(this, this.tools, this.sources);
    this.guide = new GuideKeeper(this, this.turns);
    this.context = new Context(this, this.guide, (scope) => this.checks.current(scope));
    this.checks = new ProductChecks(this, this.turns, this.context);
    this.updates = new Updates(this, this.connections, this.sources);
    this.shipping = new Shipping(this, this.turns, this.updates, this.checks, this.connections, this.tools);
    this.learnings = new Learnings(this);
    this.reviews = new Reviews(this, this.turns, this.context, this.checks, this.learnings, this.updates);
    this.design = new Design(this, this.turns, this.context);
    this.planning = new Planning(this, this.turns, this.sources);
    this.work = new Work(this, this.turns, this.context, this.guide, this.updates, this.learnings);
    this.takeover = new TakeOver(this);
    this.checkpoints = new Checkpoints(this, this.sources, this.shipping);
    this.driver = new Driver(this, this.planning, this.work, this.design, this.reviews, this.checks, this.guide, this.updates, this.learnings, this.shipping, this.connections, this.sources);
    this.cleanup = new Cleanup(this);
    this.followUps = new FollowUps(this);
    this.onTaskDone = (task) => { void this.followUps.noteDone(task); };
    this.beforeCaptureRemoval = (task) => this.followUps.beforeRemoval(task);
    this.acceptedPoints = new AcceptedPoints(this);
    // Tasks from before journeys were recorded: one step per finished stage, and the step under way, so new steps follow on from there.
    for (const task of this.s.tasks) if (!task.journey && task.startedAt !== undefined) task.journey = legacyJourney(task as unknown as Task, this.s.inbox as InboxItem[], this.s.roles) as MTask["journey"];
    // Deliveries a Petrina from before this version left halfway: never acted on by themselves.
    this.shipping.carryOverShipping();
    this.driver.recover();
    // Recovered Builders get a short login check on their saved tool before fallback selection.
    // Other roles keep their existing recovery rules; the usual check timeout bounds this wait.
    for (const task of this.s.tasks.filter((task) => task.state === "waiting")) {
      const planned = task.plan?.stages[task.stageIndex]?.profileIds[0];
      const own = planned ? this.builderConversation(task, planned) : undefined;
      if (own) void this.tools.check(own.toolId as CheckId).then(() => { if (!this.stopped) this.schedule(); });
    }
    this.armScreenTimer();
    this.timers.push(
      setInterval(() => {
        this.pollPullRequests();
        this.shipping.monitor.settleCancelledTasks();
        // Apart from GitHub: a slow lookup never holds up removing copies.
        // Confirmed older bugs are linked before a finished task's pictures are removed.
        void this.trackWork(this.followUps.catchUp().catch(() => undefined).then(() => this.cleanup.sweep()));
        void this.trackWork(this.acceptedPoints.sweep());
      }, options.checkEveryMs ?? 60_000),
      // Codex's usage, every ten minutes while any agent runs (Claude Code reports its own on every turn).
      setInterval(() => {
        if (this.runs.size || [...this.helperRuns.values()].some((runs) => runs.size)) this.readUsage();
      }, CODEX_USAGE_EVERY_MS),
    );
    // A long command may send no activity. Save its working time too, so a forced stop loses little of it.
    this.timers.push(
      setInterval(() => {
        try {
          if (!this.stopped && this.s.tasks.some((task) => task.stepClock?.since !== undefined || Object.values(task.hunt?.work ?? {}).some((work) => work.clock?.since !== undefined))) this.save();
        } catch (error) {
          console.error("Could not save step times:", error);
        }
      }, 15_000),
    );
    this.shipping.monitor.settleCancelledTasks();
    this.pollPullRequests();
    this.schedule();
    this.readUsage();
    // Catch up at start: link any older bug saved only part-way, then remove finished working copies.
    void this.trackWork(this.followUps.catchUp().catch(() => undefined).then(() => this.cleanup.sweep()));
    void this.trackWork(this.acceptedPoints.sweep());
  }

  schedule(): void {
    if (this.stopped) return;
    if (!this.startupComplete) {
      this.syncScreen();
      this.commitNow();
      this.startupSchedulePending = true;
      return;
    }
    this.driver.schedule();
  }

  private pollPullRequests(): void {
    void this.trackWork(this.shipping.monitor.pollPullRequests()).catch(error => console.error("Could not refresh pull requests:", error));
  }

  startDriver(taskId: Id, resume = false): void {
    this.driver.startDriver(taskId, resume);
  }

  tidy(taskId: Id): void {
    void this.trackWork(this.cleanup.removeCopy(taskId));
  }

  private shutdownDone?: Promise<void>;

  /** Picture contents are fetched separately, through a saved report's reference. */
  async reportImage(taskId: string, imageId: string): Promise<Blob | undefined> {
    // Finished records retain captions and references, never accessible image bytes.
    const task = this.s.tasks.find((task) => task.id === taskId);
    if (!task || task.state === "done" || task.state === "cancelled") return;
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId) || !/^[a-f0-9-]{36}$/.test(imageId) || !task?.session.some((line) => line.images?.some((image) => image.id === imageId))) return;
    const file = Bun.file(join(this.dataDir, "captures", taskId, `${imageId}.png`));
    return await file.exists() ? file : undefined;
  }

  /** Save and close immediately; resolves once agents and their remaining file handling have stopped. */
  shutdown(): Promise<void> {
    if (this.shutdownDone) return this.shutdownDone;
    if (this.stopped) return Promise.resolve();
    // Stopped first: stopping agents still changes state, and nothing may save after the store closes.
    this.stopped = true;
    this.stopIdleSleep();
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    for (const timer of this.timers) clearInterval(timer);
    this.usageCoordinator.stop();
    this.screens.stop();
    const runs = [...this.runs.values(), ...[...this.helperRuns.values()].flatMap((runs) => [...runs])];
    for (const controller of this.drivers.values()) controller.abort();
    this.shutdownDone = Promise.allSettled([this.tools.shutdown(), this.followUps.stop(), ...runs.map((run) => run.stop()), ...this.settling.values()]).then(() => undefined);
    // An ordinary quit keeps each step's working time up to now, and not the time Petrina is closed.
    this.s.now = Date.now();
    for (const task of this.s.tasks) { this.pauseStep(task, this.s.now); stopCheckProgress(task, this.s.now); }
    try {
      this.save();
    } catch (error) {
      console.error("Could not save while stopping:", error);
    } finally {
      // Turns still running stay unfinished in the log: the next start marks them lost.
      this.tracking.close();
      this.store.close();
    }
    return this.shutdownDone;
  }

  /** The numbers one view needs, worked out from the work log. The log itself never leaves the engine. */
  usage<R extends UsageRequest>(request: R): UsageViewFor<R> {
    return this.tracking.usage(request);
  }

  async previewImage(taskId: Id, path: string, productId?: Id): Promise<{ mime: string; data: string }> {
    const task = this.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    if (!task || task.state === "done" || task.state === "cancelled") throw new Error("Images are available while the task's working copy exists.");
    const works = task.repositories?.filter((entry) => !entry.removed) ?? [];
    const work = works.find((entry) => entry.productId === productId);
    if (productId && !work && (task.repositories || scope!.work.productId !== productId)) throw new Error("This product is outside the task.");
    const root = work ? work.worktree : scope!.work.worktree;
    const products = new Set([scope!.work.productId, ...works.map((entry) => entry.productId)]);
    const absoluteRoots = [scope!.work.worktree, ...works.map((entry) => entry.worktree), ...[...products].map((id) => join(this.dataDir, "worktrees", id, `${task.id}.copies`))].filter((folder): folder is string => !!folder);
    return readTaskImage(root, path, absoluteRoots);
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
    this.changeRoles((changes) => library.removeRole(changes, roleId, this.s.tasks.some((task) => library.planUses(task as unknown as Task, roleId)) || this.store.history.usesRole(roleId)));
  }

  private changeRoles(change: (changes: RoleChanges) => RoleChanges): void {
    const next = change((this.s.roleChanges ?? library.NO_ROLE_CHANGES) as RoleChanges);
    // New role objects every time: agents already working keep the ones they started with.
    this.s.roleChanges = next as typeof this.s["roleChanges"];
    this.s.roles = library.libraryRoles(next) as typeof this.s["roles"];
    this.commitNow();
  }

  /**
   * Add a product from its local clone: the clone's folder or any folder inside it, ~ for the home
   * folder. Every refusal is one plain sentence. Adding a clone that is already there opens it. A
   * clone not linked to GitHub keeps its finished work on this machine instead of opening pull requests.
   */
  async addProduct(input: string, name?: string): Promise<Id> {
    const shown = input.trim();
    const path = expandPath(shown, this.options.home);
    const found = await stat(path).catch(() => undefined);
    if (!found) throw new Error(`There is no folder at ${shown}.`);
    if (!found.isDirectory()) throw new Error(`${shown} is a file, so pick the folder you cloned the product into.`);
    // Checked without running Git, so a Mac without Apple's developer tools never opens their installer.
    if (this.tools.status("git") !== "ready") await this.tools.check("git");
    if (this.tools.status("git") === "not-installed") {
      const platform = this.s.setup?.platform ?? "linux";
      throw new Error(`Petrina needs Git to add a product, and Git isn't installed: run ${fixFor("git", "not-installed", platform)!.command} in ${platform === "win32" ? "a terminal" : "Terminal"}, then try again.`);
    }
    let info: git.RepoInfo;
    try {
      info = await git.repoInfo(path);
    } catch {
      throw new Error("That folder isn't a copy of a repository, so pick the folder you cloned the product into.");
    }
    const existing = this.s.products.find((product) => product.path === info.root);
    if (existing) return existing.id;
    const displayName = productName(name ?? suggestProductName(info.root), this.s.products);
    const base = info.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "product";
    // An id is never handed out again: not one in use, not a removed product's, not one in the work log.
    let id = base;
    for (let n = 2; this.tracking.productIdTaken(id); n += 1) id = `${base}-${n}`;
    this.tracking.product({ id, name: displayName, repo: `${info.owner}/${info.name}` }, { addedAt: Date.now() });
    this.s.products.push({
      id,
      name: displayName,
      repo: `${info.owner}/${info.name}`,
      // Exactly as configured now: every fetch and push with the coordinator's login goes to this address.
      ...(info.remote ? { remote: info.remote } : {}),
      tone: TONES[this.s.products.length % TONES.length]!,
      path: info.root,
      defaultBranch: info.defaultBranch,
      delivery: info.github ? "pull-request" : "local",
      approveDelivery: true,
    });
    this.commitNow();
    return id;
  }

  setProductDelivery(productId: Id, delivery: DeliveryMode, approveDelivery: boolean): void {
    const product = this.s.products.find((entry) => entry.id === productId);
    if (!product) return;
    this.updateProduct(productId, { name: product.name, delivery, approveDelivery });
  }

  /**
   * The coordinator sets a product's checks by hand (never replaced on its own), or clears them so
   * the Check finder looks again at the next review.
   */
  setProductChecks(productId: Id, checks: readonly { name: string; command: string }[] | null): void {
    const product = this.s.products.find((entry) => entry.id === productId);
    if (!product) throw new Error("This product is no longer in Petrina.");
    for (const task of this.s.tasks) for (const { work } of scopesFor(task)) {
      if (work.productId === productId && work.checks) work.checks.current = false;
    }
    if (checks === null) {
      delete product.checks;
      delete product.checksBy;
      delete product.checksFingerprint;
      delete product.checksSeen;
    } else {
      const parsed = checks.map((check) => ({ name: check.name.trim(), argv: parseCommand(check.command) })).filter((check) => check.name && check.argv.length);
      if (!parsed.length) throw new Error("Give at least one check, as a name and a command.");
      product.checks = parsed;
      product.checksBy = "coordinator";
      delete product.checksFingerprint;
    }
    this.commit();
  }

  updateProduct(productId: Id, settings: ProductSettings): void {
    const product = this.s.products.find((entry) => entry.id === productId);
    if (!product) throw new Error("This product is no longer in Petrina.");
    const validated = validateProductSettings(settings, this.s.products, productId);
    Object.assign(product, validated);
    // The permanent list keeps the latest name, so a removed product shows under the name it last had.
    this.tracking.product(product);
    this.commit();
  }

  removeProduct(productId: Id): void {
    const { unfinished } = productHistory(this.s.tasks, productId);
    if (unfinished) throw new Error(`${unfinished} task${unfinished === 1 ? " must" : "s must"} finish or be cancelled before this product can be removed.`);
    const product = this.s.products.find((entry) => entry.id === productId);
    if (!product) return;
    this.activeState();
    const tasks = this.s.tasks.flatMap((task) => {
      const retained = library.withoutProduct(task, productId);
      return retained ? [retained as MTask] : [];
    });
    const ids = new Set(this.s.tasks.filter((task) => !tasks.some((kept) => kept.id === task.id)).map((task) => task.id));
    // History may contain millions of finished tasks, while picture folders exist only where
    // there are actual bytes to remove. Read membership for those folders, never the full archive.
    try {
      const captures = opendirSync(join(this.dataDir, "captures"));
      try {
        for (let entry = captures.readSync(); entry; entry = captures.readSync()) {
          if (!entry.isDirectory() || ids.has(entry.name)) continue;
          const item = this.store.history.item(entry.name);
          const products = item?.productIds ?? (item ? [item.productId] : []);
          if (products.length === 1 && products[0] === productId) ids.add(entry.name);
        }
      } finally { captures.closeSync(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = {
      ...this.activeState(),
      inbox: this.s.inbox.filter((item) => {
        const archived = this.store.history.item(item.taskId);
        const products = archived?.productIds ?? (archived ? [archived.productId] : []);
        return !ids.has(item.taskId) && !(products.length === 1 && products[0] === productId);
      }),
      tasks,
      products: this.s.products.filter((entry) => entry.id !== productId),
      ...(this.s.work ? { work: { ...this.s.work, version: this.s.work.version + 1 } } : {}),
    };
    // Save all three changes together before showing removal. A failed disk write leaves the live
    // product, its history, and the permanent product record exactly as they were.
    this.store.removeProduct(productId, next, () => this.tracking.log.recordProduct({ id: product.id, name: product.name, repo: product.repo, removedAt: Date.now() }));
    this.s.inbox = next.inbox;
    this.s.tasks = next.tasks;
    this.s.products = next.products;
    this.s.work = next.work;
    this.forgetProductHistory(productId);
    for (const id of ids) rmSync(join(this.dataDir, "captures", id), { recursive: true, force: true });
    this.commit();
  }

  // ── First run and the tools check ──────────────────────────────────────

  /** Check every tool again, each on its own, so a slow one never holds up the others. */
  checkTools(): Promise<void> {
    return this.tools.checkAll().then(() => { if (!this.stopped) this.schedule(); });
  }

  /** GitHub clones in the usual code folders, most recently changed first, without the ones already added. */
  async findClones(): Promise<Clone[]> {
    const real = (path: string) => {
      try {
        // Native resolution also expands Windows short names, which Git reports in their full form.
        return realpathSync.native(path);
      } catch {
        return path;
      }
    };
    const added = new Set(this.s.products.map((product) => product.path).filter((path): path is string => !!path).map(real));
    return findClones({ ...(this.options.home ? { home: this.options.home } : {}), skip: (path) => added.has(real(path)) });
  }

  /** The furthest first-run screen reached, so closing Petrina partway reopens there. */
  setSetupStep(step: SetupStep): void {
    const setup = this.s.setup;
    const order = (value: SetupStep | undefined) => SETUP_STEPS.findIndex((entry) => entry.id === (value ?? "welcome"));
    if (!setup || setup.done || order(step) <= order(setup.step)) return;
    setup.step = step;
    this.commitNow();
  }

  /** "Skip setup": first run never comes back. */
  skipSetup(): void {
    if (!this.s.setup || this.s.setup.done) return;
    this.s.setup.done = true;
    this.commitNow();
  }

  /**
   * First run's Start: add the task and finish setup together, saved before the window hears back.
   * Sent again after a lost reply, it finds the same task.
   */
  startFirstTask(input: NewTaskInput & { clientId: Id }): Id {
    const id = this.addTask(input);
    const setup = this.s.setup;
    if (setup) {
      setup.done = true;
      setup.firstTaskId ??= id;
    }
    this.commitNow();
    return id;
  }

  /** The board's one-time tip about the first task. */
  dismissTip(): void {
    if (!this.s.setup || this.s.setup.tipDismissed) return;
    this.s.setup.tipDismissed = true;
    this.commit();
  }

  /** Open one of the official guides a fix links to, in the default browser. No other page. */
  openGuide(url: string): void {
    if (!isGuide(url)) throw new Error("Petrina only opens the guides it links to.");
    Bun.spawn(browserCommand(url), { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
  }

  // ── The queue and the pool ─────────────────────────────────────────────

  addTask(input: NewTaskInput): Id {
    const id = this.createTask(input);
    this.commit();
    this.schedule();
    return id;
  }

  private createTask(input: NewTaskInput): Id {
    const known = input.clientId ? this.s.tasks.find((task) => task.clientId === input.clientId)?.id ?? this.store.history.byClient(input.clientId) : undefined;
    if (known) return known;
    // Validate before reserving ids, so a refused request changes no state.
    const task = createTaskState(input, this.s.products, { id: "", timelineId: "", now: Date.now(), priority: queueOf(this.s.tasks).length });
    let id = this.id("task");
    while (this.tracking.taskIdTaken(id)) id = this.id("task");
    task.id = id; task.timeline[0]!.id = this.id(id);
    const product = this.s.products.find((entry) => entry.id === task.productId);
    task.repository = {
      productId: task.productId, delivery: task.delivery, workChoice: structuredClone(task.workChoice),
      ...(product ? { workProduct: { id: product.id, name: product.name, repo: product.repo, path: product.path, remote: product.remote, defaultBranch: product.defaultBranch ?? "main" } } : {}),
    };
    this.s.tasks.push(task);
    this.renumberQueue();
    return id;
  }

  queueTask(taskId: Id): void {
    const task = this.task(taskId);
    if (!task || !queueBacklogTask(task, queueOf(this.s.tasks).length)) return;
    this.log(task, "you", "You reviewed the request and queued it for work");
    this.commitNow(); this.schedule();
  }

  combineBacklog(taskIds: Id[], title: string, clientId: Id): Promise<Id> {
    return this.trackWork(this.combineBacklogRequests(taskIds, title, clientId));
  }

  private async combineBacklogRequests(taskIds: Id[], title: string, clientId: Id): Promise<Id> {
    const known = this.s.tasks.find((task) => task.clientId === clientId) ?? (() => { const id = this.store.history.byClient(clientId); return id ? this.task(id) : undefined; })();
    if (known) {
      if (JSON.stringify(known.combinedFrom?.map((entry) => entry.id)) !== JSON.stringify(taskIds)) throw new Error("This request reference was already used for a different selection.");
      return known.id;
    }
    const input = combinedBacklogInput(this.s.tasks as Task[], taskIds, title);
    const sources = taskIds.map((id) => this.task(id)!);
    const before = JSON.stringify(sources);
    const captures = join(this.dataDir, "captures");
    await mkdir(captures, { recursive: true });
    const tempName = `combine-${randomUUID()}`;
    const release = this.holdFollowUp(tempName);
    const temp = join(captures, tempName);
    try {
      await mkdir(temp);
      const images = await completeAll(sources.flatMap(source => source.session.flatMap(line => (line.images ?? []).filter(image => /^[a-f0-9-]{36}$/.test(image.id)).map(async image => {
        const id = randomUUID();
        await copyFile(join(captures, source.id, `${image.id}.png`), join(temp, `${id}.png`));
        return { id, caption: `${source.title}: ${image.caption}` };
      }))));
      // Other commands may have edited or queued a request while the pictures were copied.
      if (this.stopped || JSON.stringify(taskIds.map((id) => this.task(id))) !== before) throw new Error("A selected task changed. Review the selection and try again.");
      combinedBacklogInput(this.s.tasks as Task[], taskIds, title);
      const id = this.createTask({ ...input, clientId });
      const combined = this.task(id)!;
      try { renameSync(temp, join(captures, id)); }
      catch (error) { this.s.tasks = this.s.tasks.filter((task) => task.id !== id); throw error; }
      if (images.length) combined.session.push({ id: this.id(id), from: "system", at: Date.now(), text: "Pictures from the original requests", images });
      combineBacklogTasks(combined, sources, Date.now(), queueOf(this.s.tasks).length);
      for (const source of sources) this.log(source, "you", source.statusLine);
      this.log(combined, "you", `You combined ${sources.length} backlog requests and queued them as one task`);
      this.renumberQueue();
      this.commitNow();
      for (const source of sources) void this.cleanup.removeCaptures(source.id);
      this.schedule();
      return id;
    } finally { release(); await rm(temp, { recursive: true, force: true }).catch(() => undefined); }
  }

  moveToBacklog(taskId: Id): void {
    const task = this.task(taskId);
    if (!task || !returnQueuedTaskToBacklog(task)) return;
    this.renumberQueue();
    this.log(task, "you", "You moved it to the backlog for review");
    this.commitNow();
  }

  updateBacklog(taskId: Id, changes: { title: string; description: string }): void {
    const task = this.task(taskId);
    if (!task) throw new Error("Only backlog requests can be edited before work starts.");
    editBacklogRequest(task, changes);
    this.log(task, "you", "You updated the backlog request");
    this.commitNow();
  }

  async setTaskStart(taskId: Id, choice: WorkChoice): Promise<void> {
    const task = this.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    if (task?.workValidating) throw new Error("Wait for validation to finish, then edit the choices.");
    if (task?.workRows) return this.setTaskProducts(taskId, task.workRows.map((row) => row.choice.productId === choice.productId ? choice : choice.lead ? { ...row.choice, lead: false } : row.choice));
    if (!task || scope!.work.worktree || !this.s.inbox.some((item) => item.taskId === taskId && item.kind === "plan")) throw new Error("The starting point can be edited at the plan check before work starts.");
    await this.sources.propose(task, [choice]);
    this.commitNow();
  }

  async setTaskProducts(taskId: Id, choices: readonly WorkChoice[]): Promise<void> {
    const task = this.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    if (!task || task.repositories?.some((entry) => entry.completedStages.length) || (!task.repositories && scope!.work.worktree) || !this.s.inbox.some((item) => item.taskId === taskId && ["plan", "stuck"].includes(item.kind))) throw new Error("Change products at the plan check before work starts.");
    if (task.workValidating) throw new Error("Wait for validation to finish, then edit the choices.");
    if (!task.approveDelivery) {
      const added = choices.find((choice) => !task.workRows?.some((row) => row.choice.productId === choice.productId) && this.s.products.find((product) => product.id === choice.productId)?.approveDelivery !== false);
      if (added) { task.approveDelivery = true; task.approvalExplanation = "The added product asks before shipping, so shared delivery approval is on. You can change it here."; }
    }
    for (const choice of choices) {
      const prepared = task.repositories?.find((work) => work.productId === choice.productId && (work.worktree || work.preparingCopy));
      if (prepared?.workChoice && (JSON.stringify(prepared.workChoice.startFrom) !== JSON.stringify(choice.startFrom) || prepared.delivery !== choice.delivery)) throw new Error("Keep the approved source and delivery for a prepared product. You can leave it out while revising this saved plan.");
    }
    task.selectedProducts = [...choices];
    await this.sources.propose(task, choices, true);
    if (!this.s.inbox.some((item) => item.taskId === taskId && item.kind === "plan")) {
      this.s.inbox = this.s.inbox.filter((item) => !(item.taskId === taskId && item.kind === "stuck"));
      task.stageIndex = -1;
      this.gate(task, "plan");
    }
    this.commitNow();
  }

  async setTaskAddition(taskId: Id, repository: string, name: string, path: string): Promise<void> {
    const task = this.task(taskId);
    if (!task) throw new Error("Unknown task.");
    await this.sources.configureAddition(task, repository, name, path);
  }

  setTaskApproval(taskId: Id, ask: boolean): void {
    const task = this.task(taskId);
    if (!task || !this.s.inbox.some((item) => item.taskId === taskId && item.kind === "plan")) throw new Error("Change this choice at the plan check.");
    task.approveDelivery = ask;
    delete task.approvalExplanation;
    this.commitNow();
  }

  moveInQueue(taskId: Id, index: number): void {
    const queue = queueOf(this.s.tasks as Task[]).map((task) => task.id);
    const from = queue.indexOf(taskId);
    if (from < 0) return;
    queue.splice(from, 1);
    queue.splice(Math.max(0, Math.min(queue.length, index)), 0, taskId);
    queue.forEach((id, position) => {
      const task = this.task(id);
      if (task) task.priority = position;
    });
    this.commit();
    this.schedule();
  }

  moveToTop(taskId: Id): void {
    this.moveInQueue(taskId, 0);
  }

  placeInQueue(taskId: Id, anchorId: Id, side: "before" | "after"): number {
    const queue = queueOf(this.s.tasks).map((task) => task.id);
    const index = queuePlacement(queue, taskId, anchorId, side);
    if (index === undefined) return -1;
    const hidden = Math.max(0, Math.abs(queue.indexOf(taskId) - queue.indexOf(anchorId)) - 1);
    this.moveInQueue(taskId, index);
    return hidden;
  }

  moveVisibleInQueue(taskId: Id, visibleIds: Id[], direction: -1 | 1): number {
    const queue = queueOf(this.s.tasks).map((task) => task.id);
    const anchor = queueNeighbour(queue, visibleIds, taskId, direction);
    return anchor ? this.placeInQueue(taskId, anchor, direction < 0 ? "before" : "after") : -1;
  }

  setHeld(taskId: Id, held: boolean): void {
    const task = this.task(taskId);
    if (!task) return;
    task.held = held;
    this.log(task, "you", held ? "You put it on hold" : "You released the hold");
    this.commit();
    this.schedule();
  }

  /** Start this task only after the given tasks have landed. An empty list removes the wait. */
  setAfter(taskId: Id, after: readonly Id[]): void {
    const ids = validateTaskDependencies(taskId, after, (id) => this.task(id));
    const task = this.task(taskId)!;
    task.after = ids;
    syncWait(task, this.blockers(task), (id) => this.task(id), Date.now());
    this.log(task, "you", ids.length ? AFTER_WORDS.starts(ids.map((id) => this.task(id)!.title)) : AFTER_WORDS.none);
    this.commit(); this.schedule();
  }

  setPoolLimit(limit: number): void {
    this.s.pool.limit = Math.max(1, Math.min(12, Math.round(limit)));
    this.commit();
    this.schedule();
  }

  /** How many agents of one tool may run at once (keeps one subscription from being exhausted). */
  setToolCap(toolId: Id, cap: number): void {
    if (!this.s.tools.some((tool) => tool.id === toolId)) throw new Error("Unknown tool");
    this.s.pool.toolCaps = { ...this.s.pool.toolCaps, [toolId]: Math.max(1, Math.min(12, Math.round(cap))) };
    this.commit();
    this.schedule();
  }

  setPoolPaused(paused: boolean): void {
    if (!paused && this.draining) throw new Error("Petrina is stopping or restarting. Wait for that operation to finish before resuming.");
    this.s.pool.paused = paused;
    this.commitNow();
    this.schedule();
  }

  /** The terminal take-overs open in. Empty: the usual one on this machine. */
  setTerminal(terminalId: Id): void {
    if (!terminalId) delete this.s.terminal;
    else if (this.found.some((terminal) => terminal.id === terminalId)) this.s.terminal = terminalId;
    else throw new Error("That terminal is not on this machine");
    this.commit();
  }

  /**
   * "Agents may use the screen": Off, For an hour, or On. Turning it off never stops the agent on the
   * screen; it keeps it until its step ends, and nobody new gets it.
   */
  setScreenUse(mode: ScreenMode): void {
    this.s.pool.screen = mode === "hour" ? { mode, until: Date.now() + (this.options.screenHourMs ?? SCREEN_HOUR_MS) } : { mode };
    this.armScreenTimer();
    // Scheduling commits, once each waiting request's line says what it waits for now.
    this.schedule();
  }

  /** Allow now: this request may use the screen, still one agent at a time. */
  allowScreen(taskId: Id): void {
    const task = this.task(taskId);
    if (!task?.screen || task.screen.granted || task.screen.allowed) return;
    task.screen.allowed = true;
    this.log(task, "you", SCREEN_WORDS.allowedNow);
    this.schedule();
  }

  /** "Allow the screen for this task": its requests go ahead even while the switch is off, one agent at a time. */
  setTaskScreen(taskId: Id, allowed: boolean): void {
    const task = this.task(taskId);
    if (!task || task.state === "done" || task.state === "cancelled" || (task.screenAllowed === true) === allowed) return;
    if (allowed) task.screenAllowed = true;
    else delete task.screenAllowed;
    this.log(task, "you", allowed ? SCREEN_WORDS.taskOn : SCREEN_WORDS.taskOff);
    this.schedule();
  }

  pause(taskId: Id): void {
    const task = this.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    this.takeover.notDriving(task);
    if (!task || !["running", "needs-you", "waiting"].includes(task.state)) return;
    this.stopDriver(taskId);
    pauseTaskState(task, scope!.work, Date.now());
    this.discardScreenTurns(task);
    this.releaseScreen(task);
    this.stopStep(task);
    this.dropBlockingItems(taskId);
    this.log(task, "you", "You paused it");
    this.commit(task);
    this.schedule();
  }

  resume(taskId: Id): void {
    const task = this.task(taskId);
    if (!task || !resumeTaskState(task, this.s.inbox.some((item) => item.taskId === taskId && !item.blocking))) return;
    this.log(task, "you", "You resumed it");
    this.commit(task); this.schedule();
  }

  cancel(taskId: Id): void {
    const task = this.task(taskId);
    const scope = task ? executionFor(task) : undefined;
    if (!task) return;
    this.takeover.notDriving(task);
    this.stopDriver(taskId);
    this.tracking.cancelled(task);
    cancelTaskState(task, scope!.work, Date.now());
    this.discardScreenTurns(task);
    this.releaseScreen(task);
    this.stopStep(task);
    // A delivery from before the update keeps its note: what went out is for the coordinator to check.
    task.statusLine = scope!.work.shipping?.carriedOver ? `Cancelled. ${CARRIED_OVER}: check GitHub for what went out` : "Cancelled";
    this.dropBlockingItems(taskId);
    this.s.inbox = this.s.inbox.filter((item) => item.taskId !== taskId);
    this.log(task, "you", "You cancelled it");
    this.commit(task);
    // Pictures need no delivery lookup or agent shutdown before they can be discarded.
    void this.cleanup.removeCaptures(taskId);
    // Stopped mid-delivery with no step running (it failed, say): what went out is looked up now, then the copy goes.
    // With an agent still stopping, its driver removes the copy once it has let go of it.
    void this.trackWork(this.shipping.monitor.settleCancelled(taskId).then(() => this.tidy(taskId)));
    this.schedule();
  }

  /**
   * Start a failed task again from the stage it failed in. Stuck on a tool: check the tool again
   * first, and while it is still not installed or not logged in, the item stays with its fix.
   */
  async retry(itemId: Id): Promise<void> {
    const stuck = this.s.inbox.find((entry) => entry.id === itemId);
    if (stuck?.kind !== "stuck") return;
    this.takeover.notDrivingItem(itemId);
    if (stuck?.toolId && (await this.tools.stillNotReady(stuck.toolId, this.task(stuck.taskId)))) return;
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    const task = item && this.task(item.taskId);
    const scope = task ? executionFor(task) : undefined;
    if (item !== stuck || item.kind !== "stuck" || !task) return;
    this.takeover.notDrivingItem(itemId);
    this.s.inbox = this.s.inbox.filter((entry) => entry.id !== itemId);
    delete task.error;
    // An explicit Retry refreshes checks, pass or fail, even on unchanged work. Keep the output visible
    // until that run finishes; ordinary stage changes and restarts keep its identity and reuse it.
    if (scope!.work.checks) {
      delete scope!.work.checks.sha;
      delete scope!.work.checks.tree;
    }
    this.tracking.retried(task);
    task.state = "waiting";
    task.statusLine = "Waiting for a free slot";
    this.log(task, "you", "You asked to try again");
    endYouStep(task, { outcome: W.triedAgain, reason: W.tryAgain }, Date.now());
    this.commit();
    this.schedule();
  }

  sendMessage(taskId: Id, text: string, mode: "queue" | "interrupt" = "queue", clientId?: Id): Id | undefined {
    const task = this.task(taskId);
    const trimmed = text.trim();
    if (!task || !trimmed || !this.firstTime(task, clientId)) return;
    const message = { id: this.id(taskId), text: trimmed, at: Date.now() };
    this.remember(task, trimmed, message.id);
    const run = this.runs.get(taskId);
    const runs = new Set(this.helperRuns.get(taskId) ?? []);
    if (run) runs.add(run);
    const interrupt = mode === "interrupt" && runs.size > 0;
    this.stepNote(task, interrupt ? "interrupt" : "message", trimmed, { id: message.id });
    if (interrupt) {
      task.queued.unshift(message);
      this.say(task, "system", "You interrupted the current step");
    } else {
      task.queued.push(message);
    }
    routeMessages(task, this.screenGroups.get(taskId)?.recipients() ?? Object.keys(task.hunt?.screenTurns ?? {}));
    this.commitNow(task);
    if (interrupt) for (const active of runs) void active.cancel();
    return message.id;
  }

  /** Take back a message before any agent got it. */
  removeQueued(taskId: Id, messageId: Id): void {
    const task = this.task(taskId);
    if (!task || !task.queued.some((message) => message.id === messageId && !Object.values(message.recipients ?? {}).some(Boolean))) return;
    task.queued = task.queued.filter((message) => message.id !== messageId);
    task.stepNotes = task.stepNotes?.filter((note) => note.id !== messageId);
    task.notes = task.notes?.filter((note) => note.id !== messageId);
    this.commitNow(task);
  }

  setStageProfile(taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id): void {
    const task = this.task(taskId);
    const title = task && assignFutureProfile(task, this.s.profiles, stageId, list, index, profileId);
    if (title === undefined) return;
    this.log(task!, "you", `You changed who works on “${title}”`);
    this.commit(task!);
  }

  addReviewer(taskId: Id, stageId: Id, profileId: Id): void {
    const task = this.task(taskId);
    const title = task && appendFutureReviewer(task, this.s.profiles, stageId, profileId);
    if (title === undefined) return;
    this.log(task!, "you", `You added a reviewer to “${title}”`);
    this.commit(task!);
  }

  /**
   * Answer an agent's question. On disk before the agent gets it. A question asked before a restart
   * is answered the same way: its conversation hears the answer when it picks up. When the question
   * is gone (a pause dropped it before the answer arrived, or a restart did on a step with no
   * conversation to pick up), the answer still reaches the step.
   */
  answer(itemId: Id, answer: string, context: SaidContext = {}, how: AskAnswer = "answered"): void {
    this.takeover.notDrivingItem(itemId);
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    if (item && item.kind !== "question") throw new Error("Use Answer only for a question. The request is still in your inbox.");
    const task = this.task(item?.taskId ?? context.taskId ?? "");
    const scope = task ? executionFor(task) : undefined;
    const about = item?.title ?? context.about;
    if (!task || !this.firstTime(task, context.clientId)) return;
    if (!item && (!about || ["done", "cancelled"].includes(task.state))) return;
    this.takeItem(itemId);
    const answerKind = context.decided ? "decided" : how;
    this.tracking.answered(task, item ?? itemId, answerKind);
    settleAsk(task, itemId, answerKind === "decided" ? "decided" : "answered", Date.now(), answer);
    this.stepNote(task, "answer", answer, { ...(about ? { about } : {}) });
    this.say(task, "you", answer);
    this.log(task, "you", `You answered: ${answer}`);
    const asked = scope!.work.conversation?.asked;
    if (item && asked?.itemId === itemId) asked.answer = answer;
    const waiter = this.waiting.get(itemId);
    if (item || waiter) this.unblock(task);
    else task.queued.push({ id: this.id(task.id), text: `About your question “${about}”: ${answer}`, at: Date.now() });
    this.commitNow(task);
    this.waiting.delete(itemId);
    waiter?.resolve(answer);
    // Asked before a restart: no agent holds a slot for it, so the step waits for one.
    if (item && !waiter) this.schedule();
  }

  decideForMe(itemId: Id): void {
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    if (!item) return;
    this.answer(itemId, item.options?.[0] ?? "Use your best judgment.", {}, "decided");
  }

  allow(itemId: Id, _scope: "once" | "always" = "once"): void {
    this.takeover.notDrivingItem(itemId);
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    if (!item) return;
    if (item.kind !== "permission") throw new Error("Use Allow only for a permission request. The request is still in your inbox.");
    this.takeItem(itemId);
    const task = this.task(item.taskId);
    if (task) {
      this.tracking.answered(task, item, "allowed");
      settleAsk(task, itemId, "allowed", Date.now());
      this.log(task, "you", `You allowed: ${item.title}`);
      this.unblock(task);
    }
    this.waiting.get(itemId)?.resolve("allow");
    this.waiting.delete(itemId);
    this.commit();
  }

  /** Say no to a permission. The note with it is on disk before the agent hears the "No". */
  deny(itemId: Id, note?: string, context: SaidContext = {}): void {
    this.takeover.notDrivingItem(itemId);
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    if (item && item.kind !== "permission") throw new Error("Use Deny only for a permission request. The request is still in your inbox.");
    const task = this.task(item?.taskId ?? context.taskId ?? "");
    const said = note?.trim();
    const about = item?.title ?? context.about;
    if (!task || !this.firstTime(task, context.clientId)) return;
    // A plain "No" to a request a restart already dropped changes nothing.
    if (!item && (!said || ["done", "cancelled"].includes(task.state))) return;
    this.takeItem(itemId);
    if (item) this.tracking.answered(task, item, "denied");
    settleAsk(task, itemId, "denied", Date.now(), said);
    this.log(task, "you", said ? `You said no: ${said}` : `You said no to: ${about}`);
    if (said) {
      const id = this.id(task.id);
      this.remember(task, said, id);
      this.stepNote(task, "denied", said, { id, ...(about ? { about } : {}) });
      task.queued.push({ id, text: said, at: Date.now() });
    }
    if (item) this.unblock(task);
    this.commitNow(task);
    this.waiting.get(itemId)?.resolve("deny");
    this.waiting.delete(itemId);
  }

  approve(itemId: Id): void | Promise<void> {
    this.takeover.notDrivingItem(itemId);
    const kind = this.s.inbox.find((entry) => entry.id === itemId)?.kind;
    if (kind === "stuck") {
      return this.retry(itemId);
    }
    if (kind === "shipping") {
      this.shipping.checkShipping(itemId);
      return;
    }
    if (kind === "guide") {
      this.guide.acceptGuideLine(itemId);
      return;
    }
    if (kind === "learnings") {
      this.learnings.accept(itemId);
      return;
    }
    if (kind === "screen") {
      this.allowScreen(this.s.inbox.find((entry) => entry.id === itemId)!.taskId);
      return;
    }
    this.checkpoints.approve(itemId);
  }

  requestChanges(itemId: Id, note: string): void {
    this.takeover.notDrivingItem(itemId);
    this.checkpoints.requestChanges(itemId, note);
  }

  // ── Delegated to the modules that own them ─────────────────────────────

  takeOver(taskId: Id, how: "open" | "copy" = "open"): Promise<Launched> {
    return this.takeover.takeOver(taskId, how);
  }

  reopenTerminal(taskId: Id, how: "open" | "copy" = "open"): Promise<Launched> {
    return this.takeover.reopenTerminal(taskId, how);
  }

  handBackPreview(taskId: Id): Promise<HandBackPreview> {
    return this.takeover.handBackPreview(taskId);
  }

  handBack(taskId: Id, note = "", anyway = false): Promise<void> {
    return this.takeover.handBack(taskId, note, anyway);
  }

  checkShipping(itemId: Id): void {
    return this.shipping.checkShipping(itemId);
  }

  shipAgain(itemId: Id): void {
    return this.shipping.shipAgain(itemId);
  }

  markDone(itemId: Id): void {
    return this.shipping.markDone(itemId);
  }

  addLessons(itemId: Id, keep: number[]): void {
    this.learnings.accept(itemId, keep);
  }

  decline(itemId: Id): void {
    if (this.s.inbox.find((entry) => entry.id === itemId)?.kind === "learnings") return this.learnings.decline(itemId);
    return this.guide.declineGuide(itemId);
  }
}
