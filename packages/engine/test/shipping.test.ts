import { afterAll, describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import type { DeliveryMode, State, Task } from "@petrina/core";
import { readCalls, readGitHub } from "./fake-gh.js";
import type { Scenario } from "./fake-agent.js";
import { EngineProcess, Fakes, git, makeProduct, removeDir, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** A product delivering in `mode`, a task on its way to the shipper, and an engine running it. */
async function shipping(mode: DeliveryMode, shipper: NonNullable<Scenario["shipper"]>) {
  const root = tempDir("petrina-shipping-");
  roots.push(root);
  const product = makeProduct(root);
  const home = join(root, "home");
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "short", builder: "plain", shipper });
  // GitHub's copy is the bare repository the shipper pushes to.
  fakes.github((state) => (state.origin = join(root, "origin.git")));
  const engine = await EngineProcess.harness(home, fakes.dir);
  const productId = (await engine.act("addProduct", product)) as string;
  await engine.act("setProductDelivery", productId, mode, false);
  const taskId = (await engine.act("addTask", { productId, title: "Add a greeting" })) as string;
  const github = () => readGitHub(join(fakes.dir, "github.json"));
  const calls = () => readCalls(join(fakes.dir, "github.json"));
  const find = (state: State) => state.tasks.find((task) => task.id === taskId)!;
  return { root, product, home, fakes, engine, taskId, github, calls, find, origin: join(root, "origin.git") };
}

const delivered = (task: Task | undefined) => task?.state === "done" || task?.state === "pr-open";
const shippingItem = (state: State, taskId: string) => state.inbox.find((item) => item.taskId === taskId && item.kind === "shipping");

describe.concurrent("shipping is never repeated blindly", () => {
  for (const mode of ["pull-request", "release", "local"] as const) {
    for (const stop of ["quit", "kill"] as const) {
      it(`${mode}: finds a delivery that went out before ${stop === "quit" ? "an ordinary quit" : "a forced kill"}, and records it`, async () => {
        const run = await shipping(mode, "deliver-then-hang");
        await waitFor(() => run.fakes.marked("delivered"), "the shipper to deliver");
        // Saved before the shipper got any work.
        const recorded = run.find(await run.engine.state()).shipping;
        expect(recorded).toMatchObject({ attempts: 1 });
        expect(recorded?.head).toMatch(/^[0-9a-f]{40}$/);
        expect(recorded?.mainSha).toMatch(/^[0-9a-f]{40}$/);
        if (stop === "quit") await run.engine.quit();
        else await run.engine.kill();

        const engine = await EngineProcess.harness(run.home, run.fakes.dir);
        const task = run.find(await engine.until((state) => delivered(run.find(state)), "the delivery to be recorded"));
        expect(run.fakes.openings("shipper")).toHaveLength(1);
        expect(task.timeline.some((entry) => entry.text.startsWith("Found after a restart that it had already gone out"))).toBe(true);
        expect(task.shipping).toBeUndefined();
        if (mode === "pull-request") {
          expect(task.state).toBe("pr-open");
          expect(task.pr?.number).toBe(1);
          expect(run.github().prs).toHaveLength(1);
        } else if (mode === "release") {
          // Published but not yet recorded when Petrina stopped: exactly one release.
          expect(task.release?.tag).toBe("v1.0.1");
          expect(task.release?.url).toContain("/releases/tag/v1.0.1");
          expect(run.github().releases).toHaveLength(1);
        } else {
          expect(task.landed?.branch).toBe("main");
          expect(git(run.product, "rev-parse", "main")).toStartWith(task.landed!.sha);
        }
        if (mode !== "local") {
          // Petrina asked GitHub about the product's own repository, from outside the working copy:
          // an agent that rewrites the working copy's remote cannot change the answers.
          const lookups = run.calls().filter((call) => call.args[1] !== "create");
          expect(lookups.length).toBeGreaterThan(0);
          for (const call of lookups) {
            expect(call.args[0] === "api" ? call.args[1]!.split("/").slice(1, 3).join("/") : call.args[call.args.indexOf("--repo") + 1]).toBe("local/clone");
            expect(realpathSync(call.cwd).startsWith(realpathSync(run.home))).toBe(false);
          }
        }
        await engine.quit();
      });
    }
  }

  it("asks the coordinator when nothing went out, and 'Ship it again' ships once", async () => {
    const run = await shipping("pull-request", "hang");
    await waitFor(() => run.fakes.marked("shipper-started"), "the shipper to start");
    await run.engine.kill();

    const engine = await EngineProcess.harness(run.home, run.fakes.dir);
    const state = await engine.until((current) => shippingItem(current, run.taskId) !== undefined, "the interrupted-shipping item");
    const item = shippingItem(state, run.taskId)!;
    expect(item.body).toContain("No pull request was opened for this task's branch.");
    expect(run.find(state).state).toBe("needs-you");
    expect(run.fakes.openings("shipper")).toHaveLength(1);

    await engine.act("shipAgain", item.id);
    const done = run.find(await engine.until((current) => delivered(run.find(current)), "the second attempt to ship"));
    expect(done.state).toBe("pr-open");
    const shippers = run.fakes.openings("shipper");
    expect(shippers).toHaveLength(2);
    expect(shippers[1]).toContain("An earlier attempt to ship this was interrupted");
    expect(shippers[1]).toContain("No pull request was opened");
    expect(run.github().prs).toHaveLength(1);
    await engine.quit();
  });

  it("asks when a version change was pushed with no release, and finishes that attempt: one release, one version change", async () => {
    const run = await shipping("release", "push-then-hang");
    await waitFor(() => run.fakes.marked("pushed"), "the version change to be pushed");
    await run.engine.kill();

    const engine = await EngineProcess.harness(run.home, run.fakes.dir);
    const state = await engine.until((current) => shippingItem(current, run.taskId) !== undefined, "the interrupted-shipping item");
    const item = shippingItem(state, run.taskId)!;
    expect(item.body).toContain("was pushed to main on GitHub, but no release containing it was published");
    expect(run.github().releases).toHaveLength(0);

    await engine.act("shipAgain", item.id);
    const done = run.find(await engine.until((current) => delivered(run.find(current)), "the release"));
    expect(done.release?.tag).toBe("v1.0.1");
    expect(run.github().releases.map((release) => release.tagName)).toEqual(["v1.0.1"]);
    expect(git(run.origin, "log", "--oneline", "main").split("\n").filter((line) => line.includes("Bump version"))).toHaveLength(1);
    expect(run.fakes.openings("shipper")[1]).toContain("was pushed to main");
    await engine.quit();
  });

  it("asks when GitHub cannot be reached, and 'Check again' records the delivery", async () => {
    const run = await shipping("pull-request", "deliver-then-hang");
    await waitFor(() => run.fakes.marked("delivered"), "the shipper to deliver");
    await run.engine.kill();
    run.fakes.github((state) => (state.offline = true));

    const engine = await EngineProcess.harness(run.home, run.fakes.dir);
    const state = await engine.until((current) => shippingItem(current, run.taskId) !== undefined, "the interrupted-shipping item");
    const item = shippingItem(state, run.taskId)!;
    expect(item.body).toContain("could not reach GitHub");

    run.fakes.github((current) => (current.offline = false));
    await engine.act("checkShipping", item.id);
    const done = run.find(await engine.until((current) => delivered(run.find(current)), "the delivery to be recorded"));
    expect(done.pr?.number).toBe(1);
    expect(done.timeline.some((entry) => entry.text.startsWith("Found after a restart that it had already gone out"))).toBe(true);
    expect(run.fakes.openings("shipper")).toHaveLength(1);
    await engine.quit();
  });

  it("'Mark as done' finishes the task without shipping", async () => {
    const run = await shipping("local", "hang");
    await waitFor(() => run.fakes.marked("shipper-started"), "the shipper to start");
    await run.engine.quit();

    const engine = await EngineProcess.harness(run.home, run.fakes.dir);
    const state = await engine.until((current) => shippingItem(current, run.taskId) !== undefined, "the interrupted-shipping item");
    expect(shippingItem(state, run.taskId)!.body).toContain("The work is not on main yet.");
    await engine.act("markDone", shippingItem(state, run.taskId)!.id);
    const done = run.find(await engine.until((current) => run.find(current).state === "done", "the task to be done"));
    expect(done.statusLine).toBe("Marked as done by you");
    expect(done.landed).toBeUndefined();
    expect(run.fakes.openings("shipper")).toHaveLength(1);
    await engine.quit();
  });

  it("'Try again' on a stuck shipping step checks first, so a release is not published twice", async () => {
    const run = await shipping("release", "bad-tag");
    const stuck = await run.engine.until((state) => state.inbox.some((item) => item.taskId === run.taskId && item.kind === "stuck"), "the shipping step to get stuck");
    expect(run.github().releases).toHaveLength(1);
    await run.engine.act("retry", stuck.inbox.find((item) => item.taskId === run.taskId && item.kind === "stuck")!.id);
    const done = run.find(await run.engine.until((state) => delivered(run.find(state)), "the release to be recorded"));
    expect(done.release?.tag).toBe("v1.0.1");
    expect(done.timeline.some((entry) => entry.text.startsWith("Found that it had already gone out"))).toBe(true);
    expect(run.fakes.openings("shipper")).toHaveLength(1);
    expect(run.github().releases).toHaveLength(1);
    await run.engine.quit();
  });

  it("pausing while Petrina gets ready to ship keeps the shipper from starting, and resuming ships once", async () => {
    const run = await shipping("release", "finish");
    // The latest-release lookup before shipping takes a while: pause the task during it.
    run.fakes.github((state) => (state.slowLatest = 1500));
    await waitFor(() => run.calls().some((call) => call.args[0] === "release" && call.args[1] === "view" && call.args[2] === "--json"), "Petrina to get ready to ship");
    await run.engine.act("pause", run.taskId);
    await Bun.sleep(2500);
    const paused = run.find(await run.engine.state());
    expect(paused.state).toBe("paused");
    expect(paused.shipping).toBeUndefined();
    expect(run.fakes.openings("shipper")).toHaveLength(0);
    expect(run.github().releases).toHaveLength(0);

    run.fakes.github((state) => delete state.slowLatest);
    await run.engine.act("resume", run.taskId);
    const done = run.find(await run.engine.until((state) => delivered(run.find(state)), "the release"));
    expect(done.release?.tag).toBe("v1.0.1");
    expect(run.fakes.openings("shipper")).toHaveLength(1);
    expect(run.github().releases).toHaveLength(1);
    await run.engine.quit();
  });

  it("resuming a shipper paused after it published, even after Petrina is reopened, checks first", async () => {
    const run = await shipping("release", "deliver-then-hang");
    await waitFor(() => run.fakes.marked("delivered"), "the shipper to publish");
    await run.engine.act("pause", run.taskId);
    expect(run.find(await run.engine.state()).state).toBe("paused");
    await run.engine.quit();

    const engine = await EngineProcess.harness(run.home, run.fakes.dir);
    expect(run.find(await engine.state()).state).toBe("paused");
    await engine.act("resume", run.taskId);
    const done = run.find(await engine.until((state) => delivered(run.find(state)), "the release to be recorded"));
    expect(done.release?.tag).toBe("v1.0.1");
    expect(run.fakes.openings("shipper")).toHaveLength(1);
    expect(run.github().releases).toHaveLength(1);
    await engine.quit();
  });
});
