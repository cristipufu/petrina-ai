import { executionFor } from "../src/repository-context.js";
import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import * as files from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { serve } from "../src/server.js";
import { Turns } from "../src/turn.js";
import { ToolChecks } from "../src/tool-checks.js";
import { Sources } from "../src/sources.js";
import { Connections } from "../src/connection.js";
import { BuildResult } from "../src/roles.js";
import { Cleanup } from "../src/cleanup.js";
import { Fakes, git, makeWorld, removeDir, SLOW, waitFor } from "./support.js";

// Reports choose captures from each agent's browser folder, in this world's own browser folder.
const world = await makeWorld("report-images", { browser: true });
const root = world.dir;
afterAll(() => { removeDir(root); removeDir(world.browsers!); });

it("removes finished and orphaned picture storage without depending on worktree cleanup or loading archive bodies", async () => {
  const world = await makeWorld("report-picture-lifetime");
  let engine = world.start();
  try {
    engine.setPoolPaused(true);
    const productId = await engine.addProduct(world.clone);
    const activeId = engine.addTask({ productId, title: "An unfinished check" });
    const finishedId = engine.addTask({ productId, title: "A finished check" });
    const imageId = "12345678-1234-1234-1234-123456789abc";
    for (const id of [activeId, finishedId]) {
      engine.task(id)!.session.push({ id: `picture-${id}`, at: Date.now(), from: "agent", text: "Page checked", images: [{ id: imageId, caption: "The checked page" }] });
    }
    const finished = engine.task(finishedId)!;
    finished.state = "done";
    finished.column = "done";
    // An open pull request keeps its working copy. It must not keep picture bytes.
    executionFor(finished).work.pr = { number: 1, url: "https://github.com/acme/demo/pull/1", state: "open", openedAt: Date.now() };
    engine.commitNow();
    for (const id of [activeId, finishedId, "deleted-task"]) {
      mkdirSync(join(world.data, "captures", id), { recursive: true });
      writeFileSync(join(world.data, "captures", id, `${imageId}.png`), "picture");
    }
    expect(await engine.reportImage(finishedId, imageId)).toBeUndefined();
    const archived = spyOn(engine.store.history, "get");
    try {
      await new Cleanup(engine).sweep();
      expect(archived).not.toHaveBeenCalled();
    } finally { archived.mockRestore(); }
    expect(existsSync(join(world.data, "captures", finishedId))).toBe(false);
    expect(existsSync(join(world.data, "captures", "deleted-task"))).toBe(false);
    expect((await engine.reportImage(activeId, imageId))?.size).toBeGreaterThan(0);
    await engine.shutdown();
    engine = world.start();
    await engine.waitUntilReady();
    expect((await engine.reportImage(activeId, imageId))?.size).toBeGreaterThan(0);
    engine.cancel(activeId);
    expect(await engine.reportImage(activeId, imageId)).toBeUndefined();
    await waitFor(() => !existsSync(join(world.data, "captures", activeId)), "cancelled pictures to be removed");
    expect(engine.taskDetails(activeId)?.session[0]?.images?.[0]?.caption).toBe("The checked page");
    // Bytes left by an older version are removed by startup, including cancelled history.
    mkdirSync(join(world.data, "captures", activeId), { recursive: true });
    writeFileSync(join(world.data, "captures", activeId, `${imageId}.png`), "leftover");
    await engine.shutdown();
    engine = world.start();
    await engine.waitUntilReady();
    await waitFor(() => !existsSync(join(world.data, "captures", activeId)), "old terminal pictures to be swept after restart");
  } finally { await engine.shutdown(); removeDir(world.dir); }
});

it("builder and read-only reports preserve only chosen images through correction, cleanup, the next stage and restart", async () => {
  const product = world.clone;
  const home = world.data;
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "short", builder: "plain", pictures: "repair" });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toFile(join(fakes.dir, "picture.png"));
  const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] };
  let engine = world.start(options);
  let scheduling: { mockRestore(): void } | undefined;
  try {
    const productId = await engine.addProduct(product);
    engine.setProductDelivery(productId, "local", true);
    const id = engine.addTask({ productId, title: "Check a page" });
    const task = await waitFor(() => {
      const task = engine.getState().tasks.find((entry) => entry.id === id)!;
      if (task.state === "failed") throw new Error(task.error);
      return task.column === "ready" && task;
    }, "reports to reach delivery", 60_000);
    const reports = task.session.filter((line) => line.images?.length);
    expect(reports.map((line) => line.roleId)).toEqual(["builder", "code-reviewer"]);
    for (const roleId of ["builder", "code-reviewer"]) expect(task.steps?.some((step) => step.roleId === roleId)).toBe(true);
    expect(reports.every((line) => line.profileId && line.images?.[0]?.caption)).toBe(true);
    expect(readdirSync(join(home, "captures", id))).toHaveLength(2);
    expect(readdirSync(join(home, "browser-temp"))).toEqual([]);
    expect(await git(task.worktree!, "status", "--porcelain")).toBe("");
    expect(await git(task.worktree!, "ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(/png|browser|capture/);
    expect(fakes.prompts().filter((text) => text.includes("Your result block could not be used"))).toHaveLength(2);
    const stateText = JSON.stringify(engine.getState());
    expect(stateText).not.toContain("base64");
    // Picture references stay opaque. The exact accepted agent result separately
    // records its source filename for coordination; that is metadata, not image bytes.
    expect(JSON.stringify(reports.flatMap((line) => line.images ?? []))).not.toContain("chosen.png");
    const results = task.journey?.flatMap((step) => step.agentResults ?? []) ?? [];
    for (const report of reports) {
      const recorded = results.filter((entry) => entry.roleId === report.roleId && entry.profileId === report.profileId);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]!.value).toEqual(expect.objectContaining({ images: [{ path: "chosen.png", caption: report.images![0]!.caption }] }));
      expect(recorded[0]!.images).toEqual(report.images);
    }
    const image = reports[0]!.images![0]!;
    await engine.shutdown();
    engine = world.start(options);
    await engine.waitUntilReady();
    expect(engine.getState().tasks.find((entry) => entry.id === id)!.session.filter((line) => line.images?.length)).toEqual(reports);
    expect(engine.taskDetails(id)?.journey?.flatMap((step) => step.agentResults ?? [])).toEqual(results);
    expect((await engine.reportImage(id, image.id))?.size).toBeGreaterThan(0);
    expect(await engine.reportImage("another-task", image.id)).toBeUndefined();
    expect(await engine.reportImage(id, "../../outside")).toBeUndefined();
    const server = serve(engine, { port: 0, token: "test-key" });
    try {
      const url = `http://127.0.0.1:${server.port}/api/images/${id}/${image.id}`;
      expect((await fetch(url)).status).toBe(401);
      const response = await fetch(url, { headers: { authorization: "Bearer test-key", origin: "tauri://localhost" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
      expect((await sharp(await response.bytes()).metadata()).width).toBe(8);
      const coordinated = await fetch(`http://127.0.0.1:${server.port}/api/coordinate`, {
        method: "POST", headers: { authorization: "Bearer test-key", "content-type": "application/json" },
        body: JSON.stringify({ name: "task.inspect", args: { taskId: id } }),
      });
      expect(await coordinated.json()).toEqual(expect.objectContaining({ outcome: "completed", task: expect.objectContaining({ id }) }));
    } finally { server.stop(true); }
    const interrupted = join(home, "browser-temp", "interrupted");
    await Bun.write(join(interrupted, "old.png"), "leftover");
    await engine.shutdown();
    engine = world.start(options);
    await engine.waitUntilReady();
    expect(existsSync(interrupted)).toBe(false);
    expect((await engine.reportImage(id, image.id))?.size).toBeGreaterThan(0);
    // Other agents can add activity while a report is being checked, after the history fills up.
    // Drive this turn directly without admitting automatic drivers. Draining
    // intentionally blocks manual turn admissions too.
    scheduling = spyOn(engine, "schedule").mockImplementation(() => {});
    engine.s.pool.paused = false;
    fakes.scenario({ planner: "short", builder: "plain", pictures: "valid" });
    const long = engine.s.tasks.find((entry) => entry.id === id)!;
    long.session = Array.from({ length: 800 }, (_, index) => ({ ...reports[0]!, id: `picture-report-${index}`, images: [{ ...image }] }));
    long.stageIndex = 0;
    delete executionFor(long).work.conversation;
    let pendingId: string | undefined;
    let checks = 0;
    let superseded: string | undefined;
    const history = join(home, "captures", id);
    const writeFile = files.writeFile;
    const saving = spyOn(files, "writeFile").mockImplementation(async (path, data, options) => {
      await writeFile(path, data, options);
      if (!superseded && typeof path === "string" && path.startsWith(history)) {
        superseded = path;
        engine.sendMessage(id, "Show the guest page too", "queue");
      }
    });
    const heardBefore = fakes.received("builder").length;
    try {
      await new Turns(engine, new ToolChecks(engine), new Sources(engine, new Connections(engine))).turn(executionFor(long), "builder", "sol-high", () => [], BuildResult, new AbortController().signal, {
        check: async () => {
          pendingId = long.session.at(-1)!.id;
          engine.say(long, "activity", "Another reviewer is checking", "code-reviewer", "opus-high");
          if (checks++ === 0) engine.sendMessage(id, "Check the smaller layout too", "queue");
          await Promise.resolve();
        },
      });
    } finally { saving.mockRestore(); }
    const heard = fakes.received("builder").slice(heardBefore);
    for (const message of ["Check the smaller layout too", "Show the guest page too"]) expect(heard.filter((entry) => entry.text.includes(message))).toHaveLength(1);
    expect(long.queued).toEqual([]);
    expect(superseded).toBeDefined();
    expect(existsSync(superseded!)).toBe(false);
    expect(readdirSync(history)).toHaveLength(3);
    const accepted = long.session.find((line) => line.id === pendingId);
    expect(long.stepClock).toBeDefined();
    expect(long.stepClock!.since).toBeUndefined();
    expect(accepted).toEqual(expect.objectContaining({ from: "agent", roleId: "builder", profileId: "sol-high", images: [expect.objectContaining({ caption: "builder checked the page" })] }));
    expect((await engine.reportImage(id, accepted!.images![0]!.id))?.size).toBeGreaterThan(0);
    expect(long.session.filter((line) => line.images?.length)).toHaveLength(801);
    long.state = "paused";
    long.holdsSlot = false;
    engine.s.pool.paused = true;
    delete long.agent;
    await engine.shutdown();
    engine = world.start(options);
    await engine.waitUntilReady();
    expect(engine.task(id)!.session.find((line) => line.id === pendingId)).toEqual(accepted);
  } finally { scheduling?.mockRestore(); await engine.shutdown(); }
  expect(readdirSync(world.browsers!)).toEqual([]);
}, 90_000 * SLOW);

it("delivers a message arriving during picture saving to every unfinished reviewer and keeps only their final pictures", async () => {
  const world = await makeWorld("report-picture-messages", { browser: true });
  const fakes = new Fakes(join(world.dir, "fake"));
  fakes.scenario({ planner: "parallel", builder: "plain", pictures: "valid", controlled: true });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toFile(join(fakes.dir, "picture.png"));
  const engine = world.start({ agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] });
  let saving: { mockRestore(): void } | undefined;
  try {
    const productId = await engine.addProduct(world.clone);
    const id = engine.addTask({ productId, title: "Check the guest page" });
    const release = (session: string) => writeFileSync(join(fakes.dir, `release-${session}`), "go");
    const task = () => engine.getState().tasks.find((task) => task.id === id)!;
    await waitFor(() => {
      for (const item of engine.getState().inbox) {
        if (item.kind === "plan") engine.approve(item.id);
        else if (item.kind === "permission") engine.allow(item.id, "once");
      }
      for (const entry of fakes.received()) if (entry.role !== "code reviewer") release(entry.session);
      return fakes.received("code reviewer").length === 2;
    }, "both reviewers to start");
    engine.setPoolPaused(true);
    const reviewers = fakes.received("code reviewer").map((entry) => entry.session);
    const history = join(world.data, "captures", id);
    const writeFile = files.writeFile;
    let sent = false;
    saving = spyOn(files, "writeFile").mockImplementation(async (path, data, options) => {
      await writeFile(path, data, options);
      if (!sent && typeof path === "string" && path.startsWith(history)) {
        sent = true;
        engine.sendMessage(id, "Check the smaller guest view too", "queue");
      }
    });
    for (const session of reviewers) release(session);
    await waitFor(() => task().state === "waiting" && !task().holdsSlot, "the reviewers to finish their updated reports");
    expect(sent).toBe(true);
    const heard = fakes.received("code reviewer").filter((entry) => entry.text.includes("Check the smaller guest view too"));
    expect(heard).toHaveLength(reviewers.length);
    expect(new Set(heard.map((entry) => entry.session))).toEqual(new Set(reviewers));
    expect(task().queued).toEqual([]);
    const reports = task().session.filter((line) => line.images?.length);
    expect(reports.map((line) => line.roleId)).toEqual(["builder", "code-reviewer", "code-reviewer"]);
    const results = task().journey?.flatMap((step) => step.agentResults ?? []).filter((result) => result.roleId === "code-reviewer") ?? [];
    expect(results).toHaveLength(reviewers.length);
    for (const report of reports.filter((line) => line.roleId === "code-reviewer"))
      expect(results.find((result) => result.profileId === report.profileId)?.images).toEqual(report.images);
    expect(readdirSync(history)).toHaveLength(3);
    await engine.shutdown();
    expect(readdirSync(world.browsers!)).toEqual([]);
  } finally {
    saving?.mockRestore();
    await engine.shutdown();
    removeDir(world.dir);
    removeDir(world.browsers!);
  }
}, 60_000 * SLOW);
