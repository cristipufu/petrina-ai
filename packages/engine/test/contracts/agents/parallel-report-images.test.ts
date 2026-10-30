import { afterAll, expect, it, spyOn } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import * as files from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { Fakes, SLOW, waitFor } from "../../support.js";

import { nativeWorldFixtures } from "../../fixtures/native-worlds.js";
import { installPreparedProduct, acmeDemoProduct } from "../../fixtures/prepared-product.js";
import { installSharedWorkflowFastPaths } from "../../fixtures/shared-preparation.js";
import { privateAgentToolProbe } from "../../scripted-probes.js";

const worlds = nativeWorldFixtures();
afterAll(worlds.close);

it("delivers a message arriving during picture saving to every unfinished reviewer and keeps only their final pictures", async () => {
  let saving: ReturnType<typeof spyOn<typeof files, "writeFile">> | undefined;
  await worlds.world("report-picture-messages", async fixture => {
  const world = fixture.world;
  const fakes = new Fakes(join(world.dir, "fake"));
  fakes.scenario({ planner: "parallel", builder: "plain", pictures: "valid", controlled: true });
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toFile(join(fakes.dir, "picture.png"));
  return fixture.engine(async engine => {
  try {
    installSharedWorkflowFastPaths(engine);
    await engine.waitUntilReady(); engine.stopRequested.signal.throwIfAborted();
    const productId = installPreparedProduct(engine, acmeDemoProduct(world.clone));
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
    saving = spyOn(files, "writeFile");
    saving.mockImplementation(async (path, data, options) => {
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
  }
  }, { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir], toolProbe: privateAgentToolProbe() });
  }, { browser: true }, { stopPeers() { saving?.mockRestore(); } });
}, 60_000 * SLOW);
