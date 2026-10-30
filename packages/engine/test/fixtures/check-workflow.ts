import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { completeAll, displayTask, type DeepMutable, type State } from "@petrina/core";
import { executionFor, ParallelAdmissionGroup, scopesFor } from "@petrina/orchestrator";
import { Store } from "@petrina/storage/store";
import type { Engine } from "../engine.js";
import { saveImmutable } from "../../src/immutable-file.js";
import { SourceRefreshRequired } from "../../src/kernel.js";
import { readReviewInput } from "../../src/review-context.js";
import { freezeReviewHistory } from "../../src/review-history.js";
import { directDrivers } from "./direct-drivers.js";
import { installPreparedProduct } from "./prepared-product.js";
import { installSharedWorkflowFastPaths } from "./shared-preparation.js";
import { coordinator, createProductRepository, itemOf, taskOf, traceTaskWait, until, tempDir } from "../support.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { checkAgents, type CheckScript } from "./check-agents.js";
import { checkCommand } from "./check-command.js";
import { installCheckBuildCompletion } from "./check-build-completion.js";
import { checksPrepared } from "./checks-prepared.js";

export type CheckWorkflowStart = "workflow" | "built" | "exhausted-repairs";

export function readRef(commonDir: string, ref: string): string {
  const refPath = join(commonDir, ref);
  if (existsSync(refPath)) return readFileSync(refPath, "utf8").trim();
  const packed = join(commonDir, "packed-refs");
  if (existsSync(packed)) {
    for (const line of readFileSync(packed, "utf8").split("\n")) {
      if (line.endsWith(` ${ref}`)) return line.slice(0, line.indexOf(" ")).trim();
    }
  }
  return "";
}

export function readWorktreeCommit(dir: string): { sha: string; tree: string; message: string } {
  const dotGit = join(dir, ".git");
  const gitDir = statSync(dotGit).isFile()
    ? resolve(dir, readFileSync(dotGit, "utf8").replace(/^gitdir:\s*/, "").trim())
    : dotGit;
  const commonDir = existsSync(join(gitDir, "commondir"))
    ? resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim())
    : gitDir;
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  const sha = head.startsWith("ref: ") ? readRef(commonDir, head.slice(5).trim()) : head;
  const raw = inflateSync(readFileSync(join(commonDir, "objects", sha.slice(0, 2), sha.slice(2)))).toString("utf8");
  const body = raw.slice(raw.indexOf("\0") + 1);
  const tree = /^tree ([0-9a-f]{40,64})$/m.exec(body)?.[1] ?? "";
  const message = body.slice(body.indexOf("\n\n") + 2);
  return { sha, tree, message };
}

function installWorkflowFastPaths(engine: Engine, _repo: string, taskId: string, agents: ReturnType<typeof checkAgents>, available: () => void, checkOptions: { acceptedBuilds?: boolean; acceptedReviews?: boolean }) {
  installSharedWorkflowFastPaths(engine, {
    skipDriverPrepare: true,
    skipUpToDate: true,
    fastCheckCapture: true,
    fastCleanup: true,
  });
  engine["cleanup"].sweep = async () => {};
  engine["turns"].copyHeads.delete = () => false;
  engine["guide"].proposeGuideLine = async () => {};
  engine["updates"].patch = async (scope) => {
    const wt = scope.work.worktree!;
    const read = (file: string) => { try { return readFileSync(join(wt, file), "utf8"); } catch { return ""; } };
    return createHash("sha1").update(`${read("greeting.txt")}\0${read("welcome.txt")}\0${read("later-fix.txt")}`).digest("hex");
  };
  engine["checks"].acceptanceVersion = (scope) => engine["updates"].patch(scope);

  const origSaveChanges = engine["work"]["buildCompletion"]["effects"].saveChanges.bind(engine["work"]["buildCompletion"]["effects"]);
  engine["work"]["buildCompletion"]["effects"].saveChanges = async (scope) => {
    if (scope.work.savedVersion?.commit && scope.work.savedVersion.commit !== scope.work.baseSha && scope.work.worktree) {
      const wt = scope.work.worktree;
      const current = readWorktreeCommit(wt);
      if (current.sha === scope.work.savedVersion.commit && !existsSync(join(wt, "welcome.txt")) && !existsSync(join(wt, "later-fix.txt"))
        && existsSync(join(wt, "greeting.txt")) && readFileSync(join(wt, "greeting.txt"), "utf8") === "Hello\n") {
        return;
      }
    }
    return origSaveChanges(scope);
  };

  engine["reviews"]["prepareChecks"] = async (scope, signal) => {
    engine["updates"].clearObservedHead(scope);
    if (await engine["updates"].upToDate(scope, signal) === "conflict") return false;
    delete scope.task.handChanges;
    const sha = engine["updates"].consumeObservedHead(scope) ?? readWorktreeCommit(scope.work.worktree!).sha;
    scope.work.tamper = { at: Date.now(), sha, problems: [] };
    engine.log(scope, "done", "Tamper check passed: no tests removed or skipped");
    return true;
  };

  const reviews = engine["reviews"];
  reviews["together"] = async (currentTask, members, parentSignal, status) => {
    const scope = executionFor(currentTask);
    const sha = currentTask.hunt?.input?.heads[scope.work.productId] ?? readWorktreeCommit(scope.work.worktree!).sha;
    await engine["turns"].refresh(scope);
    if (engine.taskSourceRefreshDue(currentTask)) throw new SourceRefreshRequired();
    const group = new ParallelAdmissionGroup({
      state: () => engine.s, activeState: () => engine.activeState(), now: () => Date.now(), draining: () => engine.draining,
      admissionsClosed: t => engine.taskAdmissionsClosed(t), admissionWait: t => engine.taskAdmissionWait(t), sourceRefreshDue: t => engine.taskSourceRefreshDue(t),
      selectScreen: t => engine.selectScreen(t), syncScreen: () => engine.syncScreen(), showReviewWork: t => engine.showReviewWork(t), finishStep: t => engine.finishStep(t), waitForUsage: (t, words) => engine.waitForUsage(t, words),
      rememberReviewer: (t, key, profileId) => reviews["rememberReviewer"](t, key, profileId), changed: () => engine.commit(), checkpoint: () => engine.commitNow(), schedule: () => engine.schedule(),
    }, engine.agentAdmission);
    await group.run({ scope, members, signal: parentSignal, status, workspaces: {
      reference: () => scope.work.worktree!,
      prepare: async (_member, copy, _continuing, reuse) => ({
        activate: () => { if (!reuse && sha) engine["turns"].copyHeads.set(copy, sha); },
        finish: () => { engine["turns"].copyHeads.delete(copy); },
      }),
      stopHelpers: () => engine.stopHelpers(currentTask.id),
      closeTaskRun: () => { const run = engine.runs.get(currentTask.id); if (run) void engine.stopAgent(currentTask.id, run).catch(() => undefined); },
      releasedStops: () => engine["turns"].releasedStops(currentTask.id),
      finish: async () => {},
    } });
  };

  if (checkOptions.acceptedBuilds) installCheckBuildCompletion(engine, taskId, agents, available);
  const origInput = reviews["workflow"]["effects"].input.bind(reviews["workflow"]["effects"]);
  const fastInput = async (scope: ReturnType<typeof executionFor>, signal: AbortSignal) => {
    if (scope.work.portReview) return origInput(scope, signal);
    const current = readWorktreeCommit(scope.work.worktree!);
    scope.work.savedVersion = { commit: current.sha, tree: current.tree };
    const base = scope.work.baseSha ?? scope.work.base!;
    const snapshot = await engine["context"].captureReview(scope);
    const folder = join(engine.dataDir, "contexts", scope.task.id, "reviews");
    snapshot.material = { title: "Prepared review material", body: `complete comparison git diff ${base}...HEAD` };
    snapshot.artifacts = [];
    await freezeReviewHistory(folder, snapshot);
    signal.throwIfAborted();
    const saved = await saveImmutable(folder, "json", JSON.stringify(snapshot), "The saved review material changed. Try the review again.");
    const ref = { ...saved, heads: { [scope.work.productId]: current.sha }, trees: { [scope.work.productId]: current.tree } };
    reviews["inputs"].set(scope.task, { digest: ref.digest, input: snapshot });
    return ref;
  };
  reviews["workflow"]["effects"].input = fastInput;
  reviews["input"] = async (currentTask: Parameters<typeof executionFor>[0], signal: AbortSignal) => {
    const cached = reviews["inputs"].get(currentTask);
    if (cached && cached.digest === currentTask.hunt?.input?.digest) return cached.input;
    if (!currentTask.hunt?.input) {
      if (Object.keys(currentTask.hunt?.reported ?? {}).length) {
        throw new Error("The review's saved inputs are missing. Start this review again before continuing.");
      }
      const scope = executionFor(currentTask);
      const input = await fastInput(scope, signal);
      signal.throwIfAborted();
      currentTask.hunt!.input = input;
      engine.commitNow();
      return reviews["inputs"].get(currentTask)!.input;
    }
    const input = await readReviewInput(currentTask.hunt!.input!);
    reviews["inputs"].set(currentTask, { digest: currentTask.hunt!.input!.digest, input });
    return input;
  };
  reviews["rounds"]["host"].ownChanges = async (task) => Object.fromEntries(scopesFor(task).map(s => [s.work.productId, readWorktreeCommit(s.work.worktree!).tree]));
  reviews["rounds"]["host"].anchor = async ({ work }) => {
    const current = readWorktreeCommit(work.worktree!);
    return { head: current.sha, tree: current.tree };
  };
  const checkpointEffects = engine["driver"]["checkpoint"]["effects"];
  checkpointEffects.head = async (scope) => readWorktreeCommit(scope.work.worktree!).sha;
  checkpointEffects.patch = (scope) => engine["updates"].patch(scope);
  checkpointEffects.committedCode = async (task) => {
    const versions = Object.fromEntries(scopesFor(task).map(s => [s.work.productId, readWorktreeCommit(s.work.worktree!).tree]));
    const changes = Object.fromEntries(await Promise.all(scopesFor(task).map(async s => [s.work.productId, (await engine["updates"].patch(s)) ?? versions[s.work.productId]!])));
    return { versions, changes };
  };
  checkpointEffects.versions = async (task) => Object.fromEntries(scopesFor(task).map(s => [s.work.productId, readWorktreeCommit(s.work.worktree!).tree]));
  checkpointEffects.acceptanceVersion = (scope) => engine["updates"].patch(scope);
  checkpointEffects.writeGuide = async () => {};
  checkpointEffects.writeLearnings = async () => {};
  checkpointEffects.offerLearnings = async () => {};
}

/** Real Git, checks, SQLite, restarts and driver composition; provider replies use the shared session interface. */
async function prepareWorkflow(entry: CheckWorkflowStart, root: string, lifetime: ReturnType<typeof directDrivers>, available: () => void, approveDelivery = true, scenario: CheckScript = { planner: "short" }, extra?: { checkArgs?: string[]; acceptedBuilds?: boolean; acceptedReviews?: boolean } | string) {
  // Check-command options, or a trace label when a wait needs one.
  const checkOptions = typeof extra === "string" || extra == null ? {} : extra;
  const trace = typeof extra === "string" ? extra : undefined;
  const agents = checkAgents();
  agents.scenario(scenario);
  const { log, command, runs, execute } = checkCommand(root);
  const options = { startAgentSession: agents.start,
    runCheckCommand: execute,
    agentCommand: () => [process.execPath, join(import.meta.dir, "..", "unconfigured-service.ts"), "check workflow"],
    toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" },
      antigravity: { status: "logged-out" }, gh: { status: "unknown" }, git: { status: "ready" }, node: { status: "ready" } }),
  };
  const repository = await createProductRepository(root, { origin: "none" }), repo = repository.path;
  available();
  let engine = lifetime.open(join(root, "data"), options);
  const productId = installPreparedProduct(engine, { id: "clone", name: "Clone", repo: "local/clone", tone: "blue", path: repo,
    remote: join(root, "origin.git"), defaultBranch: "main", delivery: "local", approveDelivery: true });
  engine.setProductDelivery(productId, "local", approveDelivery);
  const setCheck = (...args: string[]) => engine.setProductChecks(productId, [{ name: "Welcome", command: command(...args) }]);
  setCheck(...(checkOptions.checkArgs ?? []));
  const taskId = entry !== "workflow" ? await checksPrepared(engine, root, productId, repository, scenario, available, entry)
    : engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
  installWorkflowFastPaths(engine, repo, taskId, agents, available, checkOptions);
  let started = entry === "workflow", deliveryWaits = 0;
  const start = () => {
    available();
    if (started) return;
    started = true;
    engine.setPoolPaused(false); engine.schedule();
  };
  return {
    agents, repo, taskId, productId, root, log, command, setCheck,
    get engine() { return engine; },
    runs, start,
    run: <T>(start: () => Promise<T>) => { available(); return lifetime.run(engine, start); },
    delivery: () => {
      start();
      const generation = engine;
      return lifetime.run(generation, () => traceTaskWait(trace ? `${trace}: delivery ${++deliveryWaits}` : undefined, () => generation.getState(), taskId,
        () => until(generation, (state) => !!itemOf(state, taskId, "delivery"), coordinator(["plan"])).then((state) => taskOf(state, taskId))));
    },
    restart: (edit?: (state: DeepMutable<State>) => void) => lifetime.prepare(async () => {
      available();
      await lifetime.stop(engine);
      available();
      if (edit) {
        const store = new Store(join(root, "data", "petrina.db"));
        let failure: { error: unknown } | undefined;
        try {
          const loaded = store.load()!;
          const state = { ...loaded, tasks: loaded.tasks.map(displayTask) };
          edit(state as DeepMutable<State>);
          store.save(state);
        } catch (error) { failure = { error }; }
        try { store.close(); } catch (error) {
          if (failure) throw new AggregateError([failure.error, error], "Saved fixture edit and Store close failed");
          throw error;
        }
        if (failure) throw failure.error;
      }
      available();
      engine = lifetime.open(join(root, "data"), options);
      installWorkflowFastPaths(engine, repo, taskId, agents, available, checkOptions);
    }),
  };
}

export type CheckWorkflow = Awaited<ReturnType<typeof prepareWorkflow>>;

/** Each root is registered before native setup; the file fallback also owns a timed-out callback. */
export function checkWorkflowFixtures() {
  const active = new Map<ReturnType<typeof directDrivers>, string>(), retained = new Set<string>();
  let closing = false;
  const closeOwner = (owner: ReturnType<typeof directDrivers>, root: string) => {
    const stopped = owner.close();
    void stopped.then(() => active.delete(owner), () => { active.delete(owner); retained.add(root); });
    return stopped;
  };
  async function use<T>(entry: CheckWorkflowStart, body: (fixture: CheckWorkflow) => Promise<T>, approveDelivery = true, scenario: CheckScript = { planner: "short" }, extra?: { checkArgs?: string[]; acceptedBuilds?: boolean; acceptedReviews?: boolean } | string): Promise<T> {
    if (closing) throw new Error("Check workflow fixtures are closing");
    const root = tempDir("petrina-check-failure-"), owner = directDrivers(root);
    active.set(owner, root);
    let closed = false;
    const close = () => { closed = true; return closeOwner(owner, root); };
    const available = () => { if (closed || closing) throw new Error("Check workflow fixture is closing"); };
    const value = await setupWithCleanup(() => owner.prepare(async () => {
      const fixture = await prepareWorkflow(entry, root, owner, available, approveDelivery, scenario, extra);
      available();
      return body(fixture);
    }), close);
    await close();
    return value;
  }
  async function close(): Promise<void> {
    closing = true;
    await completeAll([...active].map(([owner, root]) => closeOwner(owner, root)));
  }
  return { use, close, retained };
}
