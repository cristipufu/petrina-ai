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

import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { CALL_WORDS, productHistory, productName, queueOf, queueNeighbour, queuePlacement, suggestProductName, validateProductSettings, type DeliveryMode, type HandBackPreview, type Id, type Launched, type ProductSettings, type Task, afterChangesAsked, type AskAnswer, type Commands, type NewTaskInput, type SaidContext, type UsageRequest, type UsageViewFor, fixFor, isGuide, SETUP_STEPS, type Clone, type SetupStep } from "@petrina/core";
import * as git from "./git.js";
import { parseCommand } from "./checks.js";
import { CODEX_USAGE_EVERY_MS } from "./codex-usage.js";
import { Kernel, TONES, type EngineOptions } from "./kernel.js";
import { browserCommand, expandPath, findClones } from "./setup.js";
import { ToolChecks } from "./tool-checks.js";
import { Turns } from "./turn.js";
import { GuideKeeper } from "./guide-keeper.js";
import { Context } from "./context.js";
import { ProductChecks } from "./product-checks.js";
import { CARRIED_OVER, destination, Shipping } from "./shipping.js";
import { Connections } from "./connection.js";
import { Updates } from "./update.js";
import { Learnings } from "./learnings.js";
import { Reviews } from "./review.js";
import { Design } from "./design.js";
import { Planning } from "./planning.js";
import { Work } from "./work.js";
import { TakeOver } from "./take-over.js";
import { Driver } from "./driver.js";

export type { EngineOptions } from "./kernel.js";
export type { NewTaskInput, SaidContext } from "@petrina/core";
export { recordDisputes } from "./review.js";

/** The engine: every command the window can send (Commands) is a method here. */
export class Engine extends Kernel implements Commands {
  private readonly tools: ToolChecks;
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

  constructor(dataDir: string, options: EngineOptions = {}) {
    super(dataDir, options);
    this.tools = new ToolChecks(this);
    this.turns = new Turns(this, this.tools);
    this.guide = new GuideKeeper(this, this.turns);
    this.context = new Context(this, this.guide);
    this.checks = new ProductChecks(this, this.turns, this.context);
    this.connections = new Connections(this);
    this.updates = new Updates(this, this.connections);
    this.shipping = new Shipping(this, this.turns, this.updates, this.checks, this.connections, this.tools);
    this.learnings = new Learnings(this);
    this.reviews = new Reviews(this, this.turns, this.context, this.checks, this.learnings, this.updates);
    this.design = new Design(this, this.turns, this.context);
    this.planning = new Planning(this, this.turns);
    this.work = new Work(this, this.turns, this.context, this.guide, this.updates, this.learnings);
    this.takeover = new TakeOver(this);
    this.driver = new Driver(this, this.planning, this.work, this.design, this.reviews, this.checks, this.guide, this.updates, this.learnings, this.shipping, this.connections);
    // Deliveries a Petrina from before this version left halfway: never acted on by themselves.
    this.shipping.carryOverShipping();
    this.driver.recover();
    this.timers.push(
      setInterval(() => {
        void this.shipping.pollPullRequests();
        this.shipping.settleCancelledTasks();
      }, 60_000),
      // Codex's usage, every ten minutes while any agent runs (Claude Code reports its own on every turn).
      setInterval(() => {
        if (this.runs.size || [...this.helperRuns.values()].some((runs) => runs.size)) this.readUsage();
      }, CODEX_USAGE_EVERY_MS),
    );
    this.shipping.settleCancelledTasks();
    this.schedule();
    this.readUsage();
  }

  schedule(): void {
    this.driver.schedule();
  }

  startDriver(taskId: Id, resume = false): void {
    this.driver.startDriver(taskId, resume);
  }

  /** Stop every agent the way pausing does, save, and close. Their tasks continue on the next start. */
  shutdown(): void {
    if (this.stopped) return;
    // Stopped first: stopping agents still changes state, and nothing may save after the store closes.
    this.stopped = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    for (const timer of this.timers) clearInterval(timer);
    clearTimeout(this.limitTimer);
    this.codexUsage?.stop();
    for (const controller of this.drivers.values()) controller.abort();
    for (const run of this.runs.values()) run.close();
    this.store.save(this.getState());
    // Turns still running stay unfinished in the log: the next start marks them lost.
    this.tracking.close();
    this.store.close();
  }

  /** The numbers one view needs, worked out from the work log. The log itself never leaves the engine. */
  usage<R extends UsageRequest>(request: R): UsageViewFor<R> {
    return this.tracking.usage(request);
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
    // Its entry stays, marked removed, so its history keeps its name and its id is never reused.
    this.tracking.product(product, { removedAt: Date.now() });
    const ids = new Set(this.s.tasks.filter((task) => task.productId === productId).map((task) => task.id));
    this.s.inbox = this.s.inbox.filter((item) => !ids.has(item.taskId));
    this.s.tasks = this.s.tasks.filter((task) => !ids.has(task.id));
    this.s.products = this.s.products.filter((entry) => entry.id !== productId);
    this.commit();
  }

  // ── First run and the tools check ──────────────────────────────────────

  /** Check every tool again, each on its own, so a slow one never holds up the others. */
  checkTools(): Promise<void> {
    return this.tools.checkAll();
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
    // Sent again after its reply was lost: the task is already there.
    const known = input.clientId ? this.s.tasks.find((task) => task.clientId === input.clientId) : undefined;
    if (known) return known.id;
    const product = this.s.products.find((entry) => entry.id === input.productId);
    if (!product) throw new Error("Unknown product");
    const title = input.title.trim();
    if (!title) throw new Error("A task needs a title");
    let id = this.id("task");
    while (this.tracking.taskIdTaken(id)) id = this.id("task");
    const queue = queueOf(this.s.tasks as Task[]);
    this.s.tasks.push({
      id,
      productId: product.id,
      title,
      description: input.description?.trim() ?? "",
      area: title.toLowerCase(),
      kind: input.kind ?? "feature",
      priority: input.position === "top" ? -1 : queue.length,
      held: false,
      state: "queued",
      column: "queue",
      holdsSlot: false,
      approvePlan: input.approvePlan ?? false,
      delivery: input.delivery ?? product.delivery ?? "pull-request",
      approveDelivery: input.approveDelivery ?? product.approveDelivery ?? true,
      stageIndex: -1,
      rounds: {},
      sub: 0,
      fixing: false,
      statusLine: "In the queue",
      createdAt: Date.now(),
      timeline: [{ id: this.id(id), at: Date.now(), text: "You added it to the queue", tone: "you" }],
      session: [],
      queued: [],
      objections: [],
      findings: [],
      prAge: 0,
      ...(input.clientId ? { clientId: input.clientId } : {}),
    });
    this.renumberQueue();
    this.commit();
    this.schedule();
    return id;
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
    const task = this.task(taskId);
    if (!task) throw new Error("Unknown task");
    const ids = [...new Set(after)];
    for (const id of ids) {
      if (id === taskId) throw new Error("A task cannot wait for itself");
      if (!this.task(id)) throw new Error(`Unknown task: ${id}`);
    }
    // No loops: none of the tasks it waits for may (indirectly) wait for it.
    const reaches = (from: Id, seen = new Set<Id>()): boolean => {
      if (from === taskId) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (this.task(from)?.after ?? []).some((next) => reaches(next, seen));
    };
    if (ids.some((id) => reaches(id))) throw new Error("That would make tasks wait for each other");
    task.after = ids;
    const names = ids.map((id) => `“${this.task(id)!.title}”`).join(" and ");
    this.log(task, "you", ids.length ? `It starts after ${names} land${ids.length === 1 ? "s" : ""}` : "It no longer waits for other tasks");
    this.commit();
    this.schedule();
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
    this.s.pool.paused = paused;
    this.commit();
    this.schedule();
  }

  /** The terminal take-overs open in. Empty: the usual one on this machine. */
  setTerminal(terminalId: Id): void {
    if (!terminalId) delete this.s.terminal;
    else if (this.found.some((terminal) => terminal.id === terminalId)) this.s.terminal = terminalId;
    else throw new Error("That terminal is not on this machine");
    this.commit();
  }

  pause(taskId: Id): void {
    const task = this.task(taskId);
    this.takeover.notDriving(task);
    if (!task || !["running", "needs-you", "waiting"].includes(task.state)) return;
    this.stopDriver(taskId);
    task.state = "paused";
    task.holdsSlot = false;
    delete task.agent;
    delete task.helpers;
    // Resuming starts the step fresh, with everything said in it so far.
    delete task.conversation;
    task.statusLine = "Paused by you";
    this.dropBlockingItems(taskId);
    this.log(task, "you", "You paused it");
    this.commit();
    this.schedule();
  }

  resume(taskId: Id): void {
    const task = this.task(taskId);
    if (!task || task.state !== "paused") return;
    const gate = this.s.inbox.some((item) => item.taskId === taskId && !item.blocking);
    task.state = gate ? "needs-you" : "waiting";
    task.statusLine = gate ? "Waiting for you" : "Waiting for a free slot";
    this.log(task, "you", "You resumed it");
    this.commit();
    this.schedule();
  }

  cancel(taskId: Id): void {
    const task = this.task(taskId);
    if (!task) return;
    this.takeover.notDriving(task);
    this.stopDriver(taskId);
    this.tracking.cancelled(task);
    task.state = "cancelled";
    task.column = "done";
    task.holdsSlot = false;
    delete task.agent;
    delete task.helpers;
    delete task.conversation;
    task.finishedAt = Date.now();
    // A delivery from before the update keeps its note: what went out is for the coordinator to check.
    task.statusLine = task.shipping?.carriedOver ? `Cancelled. ${CARRIED_OVER}: check GitHub for what went out` : "Cancelled";
    this.dropBlockingItems(taskId);
    this.s.inbox = this.s.inbox.filter((item) => item.taskId !== taskId);
    this.log(task, "you", "You cancelled it");
    this.commit();
    // Stopped mid-delivery with no step running (it failed, say): what went out is looked up now.
    void this.shipping.settleCancelled(taskId);
    this.schedule();
  }

  /**
   * Start a failed task again from the stage it failed in. Stuck on a tool: check the tool again
   * first, and while it is still not installed or not logged in, the item stays with its fix.
   */
  async retry(itemId: Id): Promise<void> {
    this.takeover.notDrivingItem(itemId);
    const stuck = this.s.inbox.find((entry) => entry.id === itemId);
    if (stuck?.toolId && (await this.tools.stillNotReady(stuck.toolId, this.task(stuck.taskId)))) return;
    const item = this.s.inbox.find((entry) => entry.id === itemId);
    const task = item && this.task(item.taskId);
    if (!item || !task) return;
    this.s.inbox = this.s.inbox.filter((entry) => entry.id !== itemId);
    delete task.error;
    this.tracking.retried(task);
    task.state = "waiting";
    task.statusLine = "Waiting for a free slot";
    this.log(task, "you", "You asked to try again");
    this.commit();
    this.schedule();
  }

  sendMessage(taskId: Id, text: string, mode: "queue" | "interrupt" = "queue", clientId?: Id): void {
    const task = this.task(taskId);
    const trimmed = text.trim();
    if (!task || !trimmed || !this.firstTime(task, clientId)) return;
    const message = { id: this.id(taskId), text: trimmed, at: Date.now() };
    this.remember(task, trimmed, message.id);
    const run = this.runs.get(taskId);
    const interrupt = mode === "interrupt" && run !== undefined;
    this.stepNote(task, interrupt ? "interrupt" : "message", trimmed, { id: message.id });
    if (interrupt) {
      task.queued.unshift(message);
      this.say(task, "system", "You interrupted the current step");
    } else {
      task.queued.push(message);
    }
    this.commitNow();
    if (interrupt) void run.cancel();
  }

  /** Take back a message before any agent got it. */
  removeQueued(taskId: Id, messageId: Id): void {
    const task = this.task(taskId);
    if (!task || !task.queued.some((message) => message.id === messageId)) return;
    task.queued = task.queued.filter((message) => message.id !== messageId);
    task.stepNotes = task.stepNotes?.filter((note) => note.id !== messageId);
    task.notes = task.notes?.filter((note) => note.id !== messageId);
    this.commitNow();
  }

  setStageProfile(taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id): void {
    const task = this.task(taskId);
    const at = task?.plan?.stages.findIndex((stage) => stage.id === stageId) ?? -1;
    const stage = task?.plan?.stages[at];
    if (!task || !stage || at <= task.stageIndex || !this.profile(profileId)) return;
    const profiles = stage[list];
    if (!profiles || index < 0 || index >= profiles.length) return;
    profiles[index] = profileId;
    this.log(task, "you", `You changed who works on “${stage.title}”`);
    this.commit();
  }

  addReviewer(taskId: Id, stageId: Id, profileId: Id): void {
    const task = this.task(taskId);
    const at = task?.plan?.stages.findIndex((stage) => stage.id === stageId) ?? -1;
    const stage = task?.plan?.stages[at];
    if (!task || !stage || stage.kind !== "review-chain" || at <= task.stageIndex || !this.profile(profileId)) return;
    stage.profileIds.push(profileId);
    this.log(task, "you", `You added a reviewer to “${stage.title}”`);
    this.commit();
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
    const task = this.task(item?.taskId ?? context.taskId ?? "");
    const about = item?.title ?? context.about;
    if (!task || !this.firstTime(task, context.clientId)) return;
    if (!item && (!about || ["done", "cancelled"].includes(task.state))) return;
    this.takeItem(itemId);
    this.tracking.answered(task, item ?? itemId, how);
    this.stepNote(task, "answer", answer, { ...(about ? { about } : {}) });
    this.say(task, "you", answer);
    this.log(task, "you", `You answered: ${answer}`);
    const asked = task.conversation?.asked;
    if (item && asked?.itemId === itemId) asked.answer = answer;
    if (item) this.unblock(task);
    else task.queued.push({ id: this.id(task.id), text: `About your question “${about}”: ${answer}`, at: Date.now() });
    this.commitNow();
    const waiter = this.waiting.get(itemId);
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
    const item = this.takeItem(itemId);
    if (!item) return;
    const task = this.task(item.taskId);
    if (task) {
      this.tracking.answered(task, item, "allowed");
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
    const task = this.task(item?.taskId ?? context.taskId ?? "");
    const said = note?.trim();
    const about = item?.title ?? context.about;
    if (!task || !this.firstTime(task, context.clientId)) return;
    // A plain "No" to a request a restart already dropped changes nothing.
    if (!item && (!said || ["done", "cancelled"].includes(task.state))) return;
    this.takeItem(itemId);
    if (item) this.tracking.answered(task, item, "denied");
    this.log(task, "you", said ? `You said no: ${said}` : `You said no to: ${about}`);
    if (said) {
      const id = this.id(task.id);
      this.remember(task, said, id);
      this.stepNote(task, "denied", said, { id, ...(about ? { about } : {}) });
      task.queued.push({ id, text: said, at: Date.now() });
    }
    if (item) this.unblock(task);
    this.commitNow();
    this.waiting.get(itemId)?.resolve("deny");
    this.waiting.delete(itemId);
  }

  approve(itemId: Id): void {
    this.takeover.notDrivingItem(itemId);
    const kind = this.s.inbox.find((entry) => entry.id === itemId)?.kind;
    if (kind === "stuck") {
      void this.retry(itemId);
      return;
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
    const item = this.takeItem(itemId);
    const task = item && this.task(item.taskId);
    if (!item || !task) return;
    if (["plan", "design", "delivery", "disagreement"].includes(item.kind)) this.tracking.answered(task, item, "approved");
    switch (item.kind) {
      case "plan":
        this.log(task, "you", "You approved the plan");
        task.stageIndex = 0;
        break;
      case "design":
        this.log(task, "you", "You approved the design");
        task.stageIndex += 1;
        break;
      case "delivery":
        this.log(task, "you", "You approved the delivery");
        // The coordinator's approval: for the work they were shown, this delivery and where it goes. Saved right away.
        if (task.checkedSha) task.approvedSha = task.checkedSha;
        if (task.checkedPatch) task.approvedPatch = task.checkedPatch;
        task.approvedFor = { by: "coordinator", mode: task.delivery, destination: destination(task, this.productOf(task)) };
        // After review rounds ran out, the check was raised on the delivery stage itself.
        if (task.plan?.stages[task.stageIndex]?.kind === "gate") task.stageIndex += 1;
        break;
      case "disagreement":
        this.log(task, "you", "You sided with the architect");
        for (const objection of task.objections) {
          if (objection.status !== "open") continue;
          objection.status = "rejected";
          objection.decidedBy = "coordinator";
        }
        task.stageIndex += 1;
        break;
      default:
        return;
    }
    task.sub = 0;
    this.toWaiting(task);
    this.commit();
    this.schedule();
  }

  requestChanges(itemId: Id, note: string): void {
    // Refused, not dropped: the window keeps the note to send again.
    if (!this.s.inbox.some((entry) => entry.id === itemId)) throw new Error("That check isn't waiting any more, so your note wasn't applied. Send it again on the task.");
    this.takeover.notDrivingItem(itemId);
    const item = this.takeItem(itemId);
    const task = item && this.task(item.taskId);
    if (!item || !task) return;
    this.tracking.answered(task, item, "changes");
    const call = item.kind === "disagreement";
    this.log(task, "you", call ? CALL_WORDS.made(note) : `You asked for changes: ${note}`);
    this.say(task, "you", note);
    const id = this.id(task.id);
    this.remember(task, note, id);
    // The call reaches the architect in a section of its own; any other note goes to the next agent.
    if (!call) task.queued.push({ id, text: note, at: Date.now() });
    // The change request starts the next step: it is the first thing that step keeps (a call is kept on the task).
    this.finishStep(task);
    if (!call) this.stepNote(task, "changes", note, { id });
    afterChangesAsked(task, item.kind, note, Date.now());
    if (item.kind === "delivery") {
      // The Guide keeper looks for what reviewers missed, only when they had passed it: if Important findings
      // were open (the rounds ran out), the reviewers had caught it, and nothing was missed.
      if (!task.findings.some((finding) => finding.status === "open" && finding.severity === "blocking")) task.miss = { note, at: Date.now() };
      this.shipping.clearDelivery(task);
    }
    this.toWaiting(task);
    this.commitNow();
    this.schedule();
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
