import { installPreparedProduct, privateCloneProduct } from "./prepared-product.js";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { expect, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { FileFaults } from "@petrina/test-support/file-faults";
import type { FileOperations } from "@petrina/platform/file-operations";
import { join } from "node:path";
import { followUpKey, type DeepMutable, type Finding, type MatchAnswer } from "@petrina/core";
import type { Engine } from "../engine.js";
import { engineCaseFixtures, type EngineCaseOwner } from "./engine-cases.js";
import { fakeAgentSessions } from "./fake-agent-sessions.js";
import { dispatch } from "../../src/server.js";
import { Fakes, makeProduct } from "../fixtures.js";
import { privateAgentToolProbe } from "../scripted-probes.js";

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
  owner: EngineCaseOwner;
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

export async function finish(owner: EngineCaseOwner, engine: Engine, task: ReturnType<Engine["task"]> & object): Promise<void> {
  return owner.run(engine, async () => {
  task.state = "done";
  task.column = "done";
  task.finishedAt = Date.now();
  await engine["followUps"].noteDone(task);
  });
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
  return world.owner.run(world.engine, async () => {
  const { engine } = world;
  const automaticId = engine.addTask({ productId: world.shop, kind: "bug", title: "bug-reserved: Existing bug", backlog: true });
  const manualId = engine.addTask({ productId: world.shop, kind: "bug", title: "Different manual request", backlog: true });
  engine.task(manualId)!.state = "running";
  const tracking = reason === "unavailable" ? { reason, retry: true } : { reason };
  const source = taskOf(engine, world.shop, "Saved report", [older("old", "bug-reserved: Another sighting", { cardsShown: [automaticId], tracking })]);
  const release = engine.holdFollowUp(source.id);
  world.owner.onStop(release);
  source.state = "done";
  source.column = "done";
  source.finishedAt = Date.now();
  const key = followUpKey(source.id, "old");
  engine.s.followUpPending = reason === "unavailable" ? [{ keys: [key], retry: true }] : [];
  plant(engine, source.id, source.findings[0]!.text);
  engine.save();
  const copy = spyOn(world.files, "copyFile");
  world.owner.onStop(() => copy.mockRestore());
  copy.mockRejectedValue(new Error("Copy refused"));
  try { await engine["followUps"].catchUp(); }
  catch (error) { release(); throw error; }
  finally { copy.mockRestore(); }
  expect(engine.task(automaticId)!.followUp!.reports.map(report => report.findingId)).toEqual(["old"]);
  expect(engine.task(automaticId)!.session.flatMap(line => line.images ?? [])).toEqual([]);
  return { source, automaticId, manualId, key, release };
  });
}

export async function combinedAssignments(world: World, partial = false) {
  return world.owner.run(world.engine, async () => {
  const { engine } = world;
  const sources = [
    taskOf(engine, world.shop, "First source", [older("first", "bug-first: An older footer bug")]),
    taskOf(engine, world.shop, "Second source", [older("second", "bug-second: An older header bug")]),
  ];
  const releases = sources.map(source => { const release = engine.holdFollowUp(source.id); world.owner.onStop(release); return release; });
  for (const source of sources) plant(engine, source.id, source.findings[0]!.text);
  if (partial) {
    sources[0]!.journey![0]!.agentResults![0]!.images!.push({ id: "second", caption: "Another view" });
    writeFileSync(join(world.data, "captures", sources[0]!.id, "second.png"), "png");
  }
  const original = world.files.copyFile;
  const copy = spyOn(world.files, "copyFile");
  world.owner.onStop(() => copy.mockRestore());
  copy.mockImplementation(async (...args) => {
    if (String(args[0]).endsWith("pic.png")) throw new Error("Copy refused");
    return original(...args);
  });
  try {
    for (const source of sources) await finish(world.owner, engine, source);
  } catch (error) { releases.forEach(release => release()); throw error; }
  finally { copy.mockRestore(); }
  const originals = [cardFor(engine, "first")[0]!.id, cardFor(engine, "second")[0]!.id];
  const combinedId = await dispatch(engine, { name: "combineBacklog", args: [originals, "Keep both bug reports", "combined-reports"] }) as string;
  expect(engine.task(combinedId)!.followUp!.reports).toHaveLength(2);
  for (const id of originals) expect(engine.task(id)!.combinedInto).toBe(combinedId);
  return { sources, originals, combinedId, release: () => releases.forEach(release => release()) };
  });
}

export function createFollowUpFixtures() {
  const cases = engineCaseFixtures();
  async function open(owner: EngineCaseOwner, answer: World["answer"] = groupByBug, withNotes = false, repository = false): Promise<World> {
    const root = owner.root;
    const fakes = new Fakes(join(root, "agents"));
    const prompts: string[] = [];
    const data = join(root, "data");
    const faults = new FileFaults(), files = faults.files;
    const options = {
      files,
      agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir] as const,
      startAgentSession: fakeAgentSessions(fakes),
      toolProbe: privateAgentToolProbe(),
      matchFollowUps: async (prompt: string) => {
        prompts.push(prompt);
        return answer(prompt);
      },
    };
    const engine = owner.open(data, options);
    return setupWithCleanup(() => owner.run(engine, async () => {
      owner.check();
      engine.setPoolPaused(true);
      await engine.waitUntilReady(); owner.check();
      await engine["followUps"].catchUp(); owner.check();
      await Promise.all([...engine.backgroundWork]); owner.check();
      const repositoryProduct = async (dir: string, name: string, second = false) => {
        owner.check();
        const repo = await makeProduct(dir); owner.check();
        return installPreparedProduct(engine, { ...privateCloneProduct(repo), id: second ? "clone-2" : "clone", name, tone: second ? "green" : "blue" });
      };
      const shop = repository ? await repositoryProduct(root, "Shop") : recordedFollowUpProduct(engine, "shop", "Shop");
      owner.check();
      const notes = withNotes ? repository ? await repositoryProduct(join(root, "other"), "Notes", true) : recordedFollowUpProduct(engine, "notes", "Notes") : "";
      owner.check();
      const world: World = { owner, engine, data, root, shop, notes, prompts, answer, faults, files };
      return world;
    }), () => owner.stop(engine));
  }

  async function reopen(world: World, match = true): Promise<void> {
    const fakes = new Fakes(join(world.root, "agents"));
    world.engine = await world.owner.restart(world.engine, world.data, {
      files: world.files,
      agentCommand: () => [process.execPath, join(import.meta.dir, "../fake-agent.ts"), fakes.dir],
      startAgentSession: fakeAgentSessions(fakes),
      toolProbe: privateAgentToolProbe(),
      ...(match ? { matchFollowUps: async (prompt: string) => { world.prompts.push(prompt); return world.answer(prompt); } } : {}),
    });
    await setupWithCleanup(() => world.owner.run(world.engine, async () => {
      world.owner.check();
      world.engine.setPoolPaused(true);
      await world.engine.waitUntilReady(); world.owner.check();
      await world.engine["followUps"].catchUp(); world.owner.check();
      await Promise.all([...world.engine.backgroundWork]); world.owner.check();
    }), () => world.owner.stop(world.engine));
  }
  return { open, reopen, use: <T>(body: (owner: EngineCaseOwner) => Promise<T>) => cases.use("petrina-follow-up-", body), close: cases.close };
}
