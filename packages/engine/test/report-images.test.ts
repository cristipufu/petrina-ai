import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import * as files from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { serve } from "../src/server.js";
import { Turns } from "../src/turn.js";
import { ToolChecks } from "../src/tool-checks.js";
import { Sources } from "../src/sources.js";
import { Connections } from "../src/connection.js";
import { BuildResult } from "../src/roles.js";
import { Fakes, git, makeWorld, removeDir, SLOW, waitFor } from "./support.js";

const world = makeWorld("report-images");
const root = world.dir;
afterAll(() => removeDir(root));

it("builder and read-only reports preserve only chosen images through correction, cleanup, the next stage and restart", async () => {
  const product = world.clone;
  const home = world.data;
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "short", builder: "plain", pictures: "repair" });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toFile(join(fakes.dir, "picture.png"));
  const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir] };
  let engine = world.start(options);
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
    expect(git(task.worktree!, "status", "--porcelain")).toBe("");
    expect(git(task.worktree!, "ls-tree", "-r", "--name-only", "HEAD")).not.toMatch(/png|browser|capture/);
    expect(fakes.prompts().filter((text) => text.includes("Your result block could not be used"))).toHaveLength(2);
    const stateText = JSON.stringify(engine.getState());
    expect(stateText).not.toContain("base64");
    expect(stateText).not.toContain("chosen.png");
    const image = reports[0]!.images![0]!;
    await engine.shutdown();
    engine = world.start(options);
    await engine.waitUntilReady();
    expect(engine.getState().tasks.find((entry) => entry.id === id)!.session.filter((line) => line.images?.length)).toEqual(reports);
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
    } finally { server.stop(true); }
    const interrupted = join(home, "browser-temp", "interrupted");
    await Bun.write(join(interrupted, "old.png"), "leftover");
    await engine.shutdown();
    engine = world.start(options);
    await engine.waitUntilReady();
    expect(existsSync(interrupted)).toBe(false);
    expect((await engine.reportImage(id, image.id))?.size).toBeGreaterThan(0);
    // Other agents can add activity while a report is being checked, after the history fills up.
    engine.draining = true; // The test drives this turn directly; no new driver should start.
    engine.s.pool.paused = false;
    fakes.scenario({ planner: "short", builder: "plain", pictures: "valid" });
    const long = engine.s.tasks.find((entry) => entry.id === id)!;
    long.session = Array.from({ length: 800 }, (_, index) => ({ ...reports[0]!, id: `picture-report-${index}`, images: [{ ...image }] }));
    long.stageIndex = 0;
    delete long.conversation;
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
      await new Turns(engine, new ToolChecks(engine), new Sources(engine, new Connections(engine))).turn(long, "builder", "sol-high", () => [], BuildResult, new AbortController().signal, {
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
    expect(engine.task(id)!.session.find((line) => line.id === pendingId)).toEqual(accepted);
  } finally { await engine.shutdown(); }
}, 90_000 * SLOW);

it("delivers a message arriving during picture saving to every unfinished reviewer and keeps only their final pictures", async () => {
  const world = makeWorld("report-picture-messages");
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
    expect(readdirSync(history)).toHaveLength(3);
  } finally {
    saving?.mockRestore();
    await engine.shutdown();
    removeDir(world.dir);
  }
}, 60_000 * SLOW);
