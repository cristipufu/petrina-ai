import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { expect, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { FileFaults } from "@petrina/test-support/file-faults";
import type { FileOperations } from "@petrina/platform/file-operations";
import { join } from "node:path";
import { followUpKey, type DeepMutable, type Finding, type MatchAnswer } from "@petrina/core";
import { Engine } from "../engine.js";
import { dispatch } from "../../src/server.js";
import { Fakes, makeProduct, removeDir, tempDir } from "../fixtures.js";

/** Original private repositories have no remote, so addProduct selects local delivery. */
export function recordedFollowUpProduct(engine: Engine, id: string, name: string): string {
  engine.s.products.push({ id, name, repo: `local/${id}`, tone: "blue", delivery: "local" });
  return id;
}

export const STEPS = "Open the page and choose About.";

export const EVIDENCE = "The same retired page opened on the previous version.";

export const STAGE = { id: "review", kind: "review-chain" as const, title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 };

export function older(id: string, text: string, extra: Partial<Finding> = {}): DeepMutable<Finding> {
  return {
    id,
    text,
    severity: "pre-existing",
    status: "open",
    raisedBy: "opus-high",
    roleId: "code-reviewer",
    confirmedBy: [],
    steps: STEPS,
    evidence: EVIDENCE,
    ...extra,
  } as DeepMutable<Finding>;
}

export function keysOf(prompt: string): string[] {
  return [...prompt.matchAll(/^- Report \[([^\]]+)\]/gm)].map((match) => match[1]!);
}

export function groupByBug(prompt: string): MatchAnswer {
  const reports = [...prompt.matchAll(/^- Report \[([^\]]+)\]\n  Problem: (.*)$/gm)];
  const cards = [...prompt.matchAll(/^- Card \[([^\]]+)\]: (.*)$/gm)];
  const bugOf = (text: string) => /^bug-([a-z0-9]+)/.exec(text)?.[1];
  const grouped = new Map<string, string[]>();
  for (const match of reports) {
    const bug = bugOf(match[2] ?? "");
    if (!bug) continue;
    grouped.set(bug, [...(grouped.get(bug) ?? []), match[1]!]);
  }
  return {
    groups: [...grouped].map(([bug, keys]) => {
      const card = cards.find((entry) => bugOf(entry[2] ?? "") === bug);
      return card ? { keys, cardId: card[1]! } : { keys };
    }),
  };
}

export interface World {
  engine: Engine;
  data: string;
  root: string;
  shop: string;
  notes: string;
  prompts: string[];
  faults: FileFaults;
  files: FileOperations;
  answer: (prompt: string) => MatchAnswer | Promise<MatchAnswer>;
}

export function taskOf(engine: Engine, productId: string, title: string, findings: DeepMutable<Finding>[]) {
  const id = engine.addTask({ productId, title, description: "Look at an older bug", backlog: true });
  const task = engine.task(id)!;
  task.findings = findings;
  task.rounds = { review: 1 };
  return task;
}

export async function finish(engine: Engine, task: ReturnType<Engine["task"]> & object): Promise<void> {
  task.state = "done";
  task.column = "done";
  task.finishedAt = Date.now();
  await engine["followUps"].noteDone(task);
}

export function cards(engine: Engine) {
  return engine.s.tasks.filter((task) => task.followUp);
}

export function cardFor(engine: Engine, bug: string) {
  return cards(engine).filter((task) => task.title.startsWith(`bug-${bug}`));
}

export function plant(engine: Engine, taskId: string, text: string): void {
  const dir = join(engine.dataDir, "captures", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "pic.png"), "png");
  const task = engine.task(taskId)!;
  task.journey = [{
    id: `${taskId}-review`,
    kind: "agent",
    round: 1,
    sub: 0,
    startedAt: 1,
    agentResults: [{ roleId: "code-reviewer", profileId: "opus-high", at: 1, value: { findings: [{ text }] }, images: [{ id: "pic", caption: "The retired page" }] }],
  }];
}

export function settledSource(engine: Engine, productId: string, extra: Partial<Finding> = {}) {
  const source = taskOf(engine, productId, "A finished report", [older("old", "bug-manual: The confirmed older defect", { tracking: { reason: "no-choice" }, ...extra })]);
  source.state = "done";
  source.column = "done";
  source.finishedAt = Date.now();
  return source;
}

export async function failedAssignment(world: World, reason: "unavailable" | "no-choice") {
  const { engine } = world;
  const automaticId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-reserved: Existing bug", backlog: true });
  const manualId = engine.addTask({ productId: world.shop, kind: "bug", title: "Different manual request", backlog: true });
  engine.task(manualId)!.state = "running";
  const tracking = reason === "unavailable" ? { reason, retry: true } : { reason };
  const source = taskOf(engine, world.shop, "Saved report", [older("old", "bug-reserved: Another sighting", { cardsShown: [automaticId], tracking })]);
  const release = engine.holdFollowUp(source.id);
  source.state = "done";
  source.column = "done";
  source.finishedAt = Date.now();
  const key = followUpKey(source.id, "old");
  engine.s.followUpPending = reason === "unavailable" ? [{ keys: [key], retry: true }] : [];
  plant(engine, source.id, source.findings[0]!.text);
  engine.save();
  const copy = spyOn(world.files, "copyFile").mockRejectedValue(new Error("Copy refused"));
  try { await engine["followUps"].catchUp(); }
  catch (error) { release(); throw error; }
  finally { copy.mockRestore(); }
  expect(engine.task(automaticId)!.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
  expect(engine.task(automaticId)!.session.flatMap(line => line.images ?? [])).toEqual([]);
  return { source, automaticId, manualId, key, release };
}

export async function combinedAssignments(world: World, partial = false) {
  const { engine } = world;
  const sources = [
    taskOf(engine, world.shop, "First source", [older("first", "bug-first: An older footer bug")]),
    taskOf(engine, world.shop, "Second source", [older("second", "bug-second: An older header bug")]),
  ];
  const releases = sources.map(source => engine.holdFollowUp(source.id));
  for (const source of sources) plant(engine, source.id, source.findings[0]!.text);
  if (partial) {
    sources[0]!.journey![0]!.agentResults![0]!.images!.push({ id: "second", caption: "Another view" });
    writeFileSync(join(world.data, "captures", sources[0]!.id, "second.png"), "png");
  }
  const original = world.files.copyFile;
  const copy = spyOn(world.files, "copyFile").mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("pic.png")) throw new Error("Copy refused");
    return original(...args);
  });
  try {
    for (const source of sources) await finish(engine, source);
  } catch (error) { releases.forEach(release => release()); throw error; }
  finally { copy.mockRestore(); }
  const originals = [cardFor(engine, "first")[0]!.id, cardFor(engine, "second")[0]!.id];
  const combinedId = await dispatch(engine, { name: "combineBacklog", args: [originals, "Keep both bug reports", "combined-reports"] }) as string;
  expect(engine.task(combinedId)!.followUp!.reports).toHaveLength(2);
  for (const id of originals) expect(engine.task(id)!.combinedInto).toBe(combinedId);
  return { sources, originals, combinedId, release: () => releases.forEach(release => release()) };
}

export function createFollowUpFixtures() {
  interface RootOwner { root: string; engines: Set<Engine>; errors: unknown[] }
  const roots = new Map<string, RootOwner>();
  const engines = new Map<Engine, { root: RootOwner; stopping?: Promise<void> }>();
  const createRoot = (prefix: string) => {
    const root = tempDir(prefix);
    roots.set(root, { root, engines: new Set(), errors: [] });
    return root;
  };
  const ownEngine = (root: string, engine: Engine) => {
    const owner = roots.get(root);
    if (!owner) throw new Error("The Engine's private root has no cleanup owner");
    owner.engines.add(engine); engines.set(engine, { root: owner });
    return engine;
  };
  const shutdown = (engine: Engine): Promise<void> => {
    const owner = engines.get(engine);
    if (!owner) return engine.shutdown();
    if (owner.stopping) return owner.stopping;
    const work = (async () => {
      try {
        await engine.shutdown();
        owner.root.engines.delete(engine); engines.delete(engine);
      } catch (error) { owner.root.errors.push(error); throw error; }
    })();
    owner.stopping = work;
    const clear = () => { owner.stopping = undefined; };
    void work.then(clear, clear);
    return work;
  };
  const close = async () => {
    await Promise.allSettled([...engines.keys()].map(engine => shutdown(engine)));
    const errors: unknown[] = [];
    for (const owner of roots.values()) {
      if (owner.errors.length || owner.engines.size) {
        errors.push(new AggregateError(owner.errors, `Follow-up cleanup is unconfirmed; retained ${owner.root}`));
        continue;
      }
      try { removeDir(owner.root); roots.delete(owner.root); }
      catch (error) { owner.errors.push(error); errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Follow-up fixture cleanup could not be confirmed");
  };
  async function open(answer: World["answer"] = groupByBug, withNotes = false, repository = false): Promise<World> {
    const root = createRoot("petrina-follow-up-");
    const fakes = new Fakes(join(root, "agents"));
    const prompts: string[] = [];
    const data = join(root, "data");
    const faults = new FileFaults(), files = faults.files;
    const options = {
      files,
      agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir] as const,
      matchFollowUps: async (prompt: string) => {
        prompts.push(prompt);
        return answer(prompt);
      },
    };
    const engine = ownEngine(root, new Engine(data, options));
    return setupWithCleanup(async () => {
      engine.setPoolPaused(true);
      await engine.waitUntilReady();
      await engine["followUps"].catchUp();
      await Promise.all([...engine.backgroundWork]);
      const shop = repository ? await engine.addProduct(await makeProduct(root), "Shop") : recordedFollowUpProduct(engine, "shop", "Shop");
      const notes = withNotes ? repository ? await engine.addProduct(await makeProduct(join(root, "other")), "Notes") : recordedFollowUpProduct(engine, "notes", "Notes") : "";
      const world: World = { engine, data, root, shop, notes, prompts, answer, faults, files };
      return world;
    }, () => shutdown(engine));
  }

  async function reopen(world: World, match = true): Promise<void> {
    await shutdown(world.engine);
    world.engine = ownEngine(world.root, new Engine(world.data, {
      files: world.files,
      agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), join(world.root, "agents")],
      ...(match ? { matchFollowUps: async (prompt: string) => { world.prompts.push(prompt); return world.answer(prompt); } } : {}),
    }));
    await setupWithCleanup(async () => {
      world.engine.setPoolPaused(true);
      await world.engine.waitUntilReady();
      await world.engine["followUps"].catchUp();
      await Promise.all([...world.engine.backgroundWork]);
    }, () => shutdown(world.engine));
  }
  return { open, reopen, createRoot, ownEngine, shutdown, close };
}
