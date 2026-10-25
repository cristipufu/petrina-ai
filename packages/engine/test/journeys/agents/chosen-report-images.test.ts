import { executionFor } from "@petrina/orchestrator";
import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import * as files from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { serve } from "../../../src/server.js";
import { Turns } from "../../../src/turn.js";
import { ToolChecks } from "../../../src/tool-checks.js";
import { Sources } from "../../../src/sources.js";
import { Connections } from "../../../src/connection.js";
import { BuildResult } from "../../../src/roles.js";
import { Fakes, git, makeWorld, removeDir, SLOW, waitFor } from "../../support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

it("builder and read-only reports preserve only chosen images through correction, cleanup, the next stage and restart", async () => {
  const world = await makeWorld("report-images", { browser: true });
  const root = world.dir;
  roots.push(root, world.browsers!);
  const product = world.clone;
  const home = world.data;
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "short", builder: "plain", pictures: "repair" });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toFile(join(fakes.dir, "picture.png"));
  const options = { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir] };
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
