import { ENGINE_TEST_ROOT } from "../../fixtures/runtime-paths.js";
import { afterAll, describe, expect, it } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { onScreen, screenOn, slotUses, type State, type Task } from "@petrina/core";
import { localFixtureSource, screenFixturePlan } from "../../fixtures/prepared-runtime.js";
import { Engine, type EngineOptions } from "../../engine.js";
import { screenRules, WHERE_YOU_WERE_SCREEN } from "../../../src/prompts.js";
import type { Scenario } from "../../fake-agent.js";
import { finish, Fakes, git, makeProduct, removeDir, taskOf, tempDir, waitFor } from "../../support.js";

import { nativeWorldFixtures } from "../../fixtures/native-worlds.js";
const nativeWorlds = nativeWorldFixtures();
afterAll(nativeWorlds.close);

const fake = join(ENGINE_TEST_ROOT, "fake-agent.ts");
/** What the fake builder needs the screen for. */
const REASON = "Check that the quick note window opens from the menu bar";
const NEEDS = `Needs the screen for: ${REASON}`;

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/**
 * Tasks on a product that stops at the delivery check, with the pool paused so a test can set the
 * screen up before anything starts. Plans are short: a builder, then one reviewer.
 */
async function fixture(scenario: Scenario, count = 1, options: EngineOptions = {}) {
  const root = tempDir("petrina-screen-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "short", builder: "plain", ...scenario });
  const repo = await makeProduct(root);
  // Parallel worktree creation need not write upstream tracking settings to the shared config.
  await git(repo, "config", "branch.autoSetupMerge", "false");
  const data = join(root, "data");
  const engineOptions: EngineOptions = { agentCommand: () => [process.execPath, fake, fakes.dir], ...options };
  let engine = new Engine(data, engineOptions);
  try {
  engine.setPoolPaused(true);
  const productId = await engine.addProduct(repo);
  engine.setProductDelivery(productId, "pull-request", true);
  const ids = Array.from({ length: count }, (_, index) => engine.addTask({ productId, title: `Quick note window ${index + 1}`, backlog: true }));
  for (const id of ids) {
    const task = engine.task(id)!;
    await localFixtureSource(engine, task);
    task.startedAt = Date.now(); task.state = "waiting"; task.stageIndex = 0;
    task.plan = { rationale: "The requested screen behavior starts at its Builder", plannerProfileId: "sol-high", stages: screenFixturePlan(scenario.planner === "parallel" ? ["opus-high", "sol-high"] : ["opus-high"]) };
  }
  const f = {
    get engine() {
      return engine;
    },
    fakes,
    ids,
    state: () => engine.getState(),
    task: (id: string): Task => engine.getState().tasks.find((task) => task.id === id)!,
    until: (check: (state: State) => boolean, what: string, ms = 30_000) => waitFor(() => check(engine.getState()) && engine.getState(), what, ms),
    /** The task waits for the screen: for an OK, or its turn. */
    asking: (id: string) => {
      const task = f.task(id);
      return task.state === "waiting" && task.screen !== undefined && !task.screen.granted;
    },
    /** It reached the delivery check: its build and review are done. */
    built: (state: State, id: string) => state.inbox.some((item) => item.taskId === id && item.kind === "delivery"),
    screenItems: (id?: string) => engine.getState().inbox.filter((item) => item.kind === "screen" && (!id || item.taskId === id)),
    /** The conversations that got the screen, in the fake agent's words. */
    onScreen: () =>
      readdirSync(fakes.dir)
        .filter((name) => name.startsWith("on-screen-"))
        .map((name) => name.slice("on-screen-".length)),
    release: (session: string) => writeFileSync(join(fakes.dir, `screen-release-${session}`), "go"),
    /** A screenLate builder asks for the screen now. */
    ask: (session: string) => writeFileSync(join(fakes.dir, `screen-ask-${session}`), "go"),
    restart: async () => {
      await engine.shutdown();
      engine = new Engine(data, engineOptions);
      await engine.waitUntilReady();
    },
    close: async () => {
      await engine.shutdown();
    },
  };
  return f;
  } catch (error) { await engine.shutdown(); throw error; }
}

describe("an agent that needs the screen", () => {
  it("waits without a slot while the switch is off, then continues on the same conversation when it is turned on", async () => {
    const f = await fixture({ screen: "ask", reopen: "resume" });
    const [id] = f.ids as [string];
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => f.asking(id), "the builder to ask for the screen");
      const task = f.task(id);
      expect(task.holdsSlot).toBe(false);
      expect(task.agent).toBeUndefined();
      expect(slotUses(f.state())).toEqual([]);
      expect(task.statusLine).toBe(NEEDS);
      expect(task.column).toBe("building");
      expect(task.screen).toMatchObject({ reason: REASON, roleId: "builder", profileId: "sol-xhigh" });
      // Its conversation is closed but kept.
      const session = f.fakes.received("builder")[0]!.session;
      expect(task.conversation).toMatchObject({ roleId: "builder", sessionId: session, briefed: true });
      // One quiet inbox item, not blocking anyone.
      expect(f.state().inbox.filter((item) => item.taskId === id)).toEqual([expect.objectContaining({ kind: "screen", blocking: false, title: NEEDS, roleId: "builder" })]);

      // A message sent while it waits stays in line for it.
      f.engine.sendMessage(id, "Use the dark theme too");
      await Bun.sleep(400);
      expect(f.asking(id)).toBe(true);
      expect(f.fakes.received("builder")).toHaveLength(1);
      const loggedBefore = f.engine.tracking.log.turns({ taskId: id }).filter((turn) => turn.roleId === "builder");
      expect(loggedBefore).toEqual([expect.objectContaining({ reason: "first", end: "finished", sessionId: session })]);

      f.engine.setScreenUse("on");
      const done = await f.until((state) => f.built(state, id), "the build to continue and reach the delivery check");
      const builder = f.fakes.received("builder");
      expect(builder.every((entry) => entry.session === session)).toBe(true);
      expect(f.fakes.openings("builder")).toHaveLength(1);
      expect(f.fakes.opens().filter((open) => open.session === session).map((open) => open.how)).toEqual(["new", "resume"]);
      const line = builder[1]!.text;
      expect(line).toStartWith(screenRules(REASON));
      expect(line).toStartWith(`You may now use the screen for: ${REASON}. You may run the app on screen, take real screenshots and click through it. You are the only agent on the screen. When you are done with it, close every window and app you opened and stop everything you started.`);
      expect(line).toContain("Messages from the coordinator, in order\n1. Use the dark theme too");
      expect(line).not.toContain("Petrina restarted");
      // Nothing heard twice.
      expect(builder.filter((entry) => entry.text.includes("Use the dark theme too"))).toHaveLength(1);
      expect(f.onScreen()).toEqual([session]);
      const logged = f.engine.tracking.log.turns({ taskId: id }).filter((turn) => turn.roleId === "builder");
      expect(logged.map((turn) => [turn.reason, turn.end, turn.sessionId])).toEqual([["first", "finished", session], ["continue", "finished", session]]);
      expect(logged[1]!.startedAt).toBeGreaterThanOrEqual(logged[0]!.endedAt!);
      expect(new Set(logged.map(turn => turn.agentRunId)).size).toBe(1);
      expect(f.engine.usage({ view: "node", taskId: id, nodeId: logged[0]!.journeyId! }).runs).toHaveLength(1);
      const timeline = f.task(id).timeline.map((entry) => entry.text);
      expect(timeline).toContain(`Asked for the screen: ${REASON}`);
      expect(timeline).toContain("Picked up where it left off, now using the screen");
      expect(timeline.some((entry) => entry.startsWith("Started this step again"))).toBe(false);
      // The screen went back when the build handed back its result, and the quiet item went with the wait.
      expect(f.task(id).screen).toBeUndefined();
      expect(done.inbox.some((item) => item.kind === "screen")).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("still waits after Petrina restarts, and Allow now reopens the saved conversation", async () => {
    const f = await fixture({ screen: "ask", reopen: "resume" });
    const [id] = f.ids as [string];
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => f.asking(id), "the builder to ask for the screen");
      const [item] = f.screenItems(id);
      const session = f.task(id).conversation!.sessionId;

      await f.restart();
      const task = f.task(id);
      expect(task.state).toBe("waiting");
      expect(task.statusLine).toBe(NEEDS);
      expect(task.screen).toMatchObject({ reason: REASON });
      expect(task.conversation?.sessionId).toBe(session);
      expect(f.screenItems()).toEqual([item!]);
      expect(f.fakes.received("builder")).toHaveLength(1);

      // Allowed while the pool is paused: it waits for the pool like any other task, and never says it needs the screen.
      f.engine.setPoolPaused(true);
      const lines: string[] = [];
      const unsubscribe = f.engine.subscribe(() => lines.push(f.task(id).statusLine));
      f.engine.allowScreen(id);
      unsubscribe();
      expect(lines).toEqual(["Waiting for the pool to resume"]);
      expect(f.screenItems()).toEqual([]);
      await Bun.sleep(400);
      expect(f.asking(id)).toBe(true);
      expect(f.fakes.received("builder")).toHaveLength(1);

      f.engine.setPoolPaused(false);
      await f.until((state) => f.built(state, id), "the build to continue");
      expect(f.fakes.received("builder").every((entry) => entry.session === session)).toBe(true);
      expect(f.fakes.opens().filter((open) => open.session === session).map((open) => open.how)).toEqual(["new", "resume"]);
      expect(f.fakes.received("builder")[1]!.text).toStartWith(screenRules(REASON));
      const turns = f.engine.tracking.log.turns({ taskId: id }).filter(turn => turn.roleId === "builder");
      expect(turns).toHaveLength(2);
      expect(new Set(turns.map(turn => turn.agentRunId)).size).toBe(1);
      const timeline = f.task(id).timeline.map((entry) => entry.text);
      expect(timeline).toContain("You allowed the screen for this request");
      expect(timeline).toContain("Picked up where it left off, now using the screen");
      expect(screenOn(f.state().pool, Date.now())).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("keeps its screen request when a message arrives as it asks, and hears the message with the screen", async () => {
    const f = await fixture({ screen: "ask", reopen: "resume", screenLate: true });
    const [id] = f.ids as [string];
    try {
      f.engine.setPoolPaused(false);
      const session = await waitFor(() => f.fakes.received("builder")[0]?.session, "the builder to start");
      f.engine.sendMessage(id, "Use the dark theme too");
      f.ask(session);
      await waitFor(() => f.asking(id), "the builder to ask for the screen");
      // The request is not lost to the message: the task waits for the screen, the message stays in line.
      expect(f.task(id).statusLine).toBe(NEEDS);
      expect(f.screenItems(id)).toHaveLength(1);
      expect(f.task(id).queued.map((message) => message.text)).toEqual(["Use the dark theme too"]);
      expect(f.fakes.received("builder")).toHaveLength(1);

      f.engine.allowScreen(id);
      await f.until((state) => f.built(state, id), "the build to continue on the screen");
      const builder = f.fakes.received("builder");
      expect(builder.map((entry) => entry.session)).toEqual([session, session]);
      expect(builder[1]!.text).toStartWith(screenRules(REASON));
      expect(builder[1]!.text).toContain("Messages from the coordinator, in order\n1. Use the dark theme too");
      expect(f.onScreen()).toEqual([session]);
    } finally {
      await f.close();
    }
  });

  it("hears a message that arrived as it asked together with the screen, when it gets the screen at once", async () => {
    const f = await fixture({ screen: "ask", reopen: "resume", screenLate: true });
    const [id] = f.ids as [string];
    try {
      f.engine.setScreenUse("on");
      f.engine.setPoolPaused(false);
      const session = await waitFor(() => f.fakes.received("builder")[0]?.session, "the builder to start");
      f.engine.sendMessage(id, "Use the dark theme too");
      f.ask(session);
      await f.until((state) => f.built(state, id), "the build to finish on the screen");
      const builder = f.fakes.received("builder");
      expect(builder).toHaveLength(2);
      expect(builder[1]!.text).toStartWith(screenRules(REASON));
      expect(builder[1]!.text).toContain("Messages from the coordinator, in order\n1. Use the dark theme too");
      expect(f.onScreen()).toEqual([session]);
      expect(f.task(id).queued).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("gets the screen at once in the same live conversation while it is allowed and free, keeping its slot", async () => {
    const f = await fixture({ screen: "ask", reopen: "resume" });
    const [id] = f.ids as [string];
    let waited = false;
    let items = 0;
    const unsubscribe = f.engine.subscribe(() => {
      waited ||= f.asking(id);
      items = Math.max(items, f.screenItems().length);
    });
    try {
      f.engine.setScreenUse("on");
      f.engine.setPoolPaused(false);
      await f.until((state) => f.built(state, id), "the build to finish");
      const builder = f.fakes.received("builder");
      expect(new Set(builder.map((entry) => entry.session)).size).toBe(1);
      expect(f.fakes.opens().filter((open) => open.session === builder[0]!.session).map((open) => open.how)).toEqual(["new"]);
      expect(builder[1]!.text).toStartWith(screenRules(REASON));
      expect(waited).toBe(false);
      expect(items).toBe(0);
      const timeline = f.task(id).timeline.map((entry) => entry.text);
      expect(timeline).toContain(`Using the screen for: ${REASON}`);
      expect(timeline).not.toContain("Picked up where it left off, now using the screen");
    } finally {
      unsubscribe();
      await f.close();
    }
  });

  it("goes to one agent at a time: the second waits its turn and follows when the first's step ends", async () => {
    const f = await fixture({ screen: "hold", reopen: "resume" }, 2);
    let most = 0;
    let stale = false;
    const unsubscribe = f.engine.subscribe(() => {
      most = Math.max(most, f.state().tasks.filter((task) => task.screen?.granted).length);
      // Once nobody is on the screen, nobody is waiting their turn on it.
      stale ||= !onScreen(f.state().tasks) && f.state().tasks.some((task) => task.statusLine === "Waiting its turn on the screen");
    });
    try {
      f.engine.setScreenUse("on");
      f.engine.setPoolPaused(false);
      const first = await waitFor(() => f.onScreen()[0], "an agent on the screen");
      const other = await waitFor(() => f.ids.find((id) => f.asking(id)), "the other agent to ask for the screen");
      const holder = onScreen(f.state().tasks)!;
      expect(holder.id).not.toBe(other);
      expect(holder.holdsSlot).toBe(true);
      const waiting = f.task(other);
      expect(waiting.statusLine).toBe("Waiting its turn on the screen");
      expect(waiting.holdsSlot).toBe(false);
      expect(f.screenItems()).toEqual([]);
      await Bun.sleep(400);
      expect(f.onScreen()).toEqual([first]);

      // The first hands back its result: the screen goes to the second, on its own conversation.
      f.release(first);
      const second = await waitFor(() => f.onScreen().find((session) => session !== first), "the second agent on the screen");
      expect(f.task(holder.id).screen).toBeUndefined();
      expect(f.fakes.opens().filter((open) => open.session === second).map((open) => open.how)).toEqual(["new", "resume"]);
      f.release(second);
      await f.until((state) => f.ids.every((id) => f.built(state, id)), "both builds to finish");
      expect(most).toBe(1);
      expect(stale).toBe(false);
    } finally {
      unsubscribe();
      await f.close();
    }
  });

  it("goes ahead for a task allowed the screen while the switch is off, and other tasks still wait", async () => {
    const f = await fixture({ screen: "ask", reopen: "resume" }, 2);
    const [allowed, other] = f.ids as [string, string];
    try {
      // Queued tasks can be allowed too.
      f.engine.setTaskScreen(allowed, true);
      expect(f.task(allowed).screenAllowed).toBe(true);
      f.engine.setPoolPaused(false);
      await f.until((state) => f.built(state, allowed) && f.asking(other), "the allowed task to build and the other to ask");
      expect(screenOn(f.state().pool, Date.now())).toBe(false);
      expect(f.task(allowed).timeline.map((entry) => entry.text)).toEqual(expect.arrayContaining(["You allowed the screen for this task", `Using the screen for: ${REASON}`]));
      expect(f.task(other).statusLine).toBe(NEEDS);
      expect(f.screenItems().map((item) => item.taskId)).toEqual([other]);

      f.engine.setTaskScreen(allowed, false);
      expect(f.task(allowed).screenAllowed).toBeUndefined();
      f.engine.setTaskScreen(other, true);
      await f.until((state) => f.built(state, other), "the other task, allowed now, to build");
      expect(f.screenItems()).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("lets the agent on the screen finish when the switch goes off, and gives the screen to nobody new", async () => {
    const f = await fixture({ screen: "hold", reopen: "resume" }, 2);
    try {
      f.engine.setScreenUse("on");
      f.engine.setPoolPaused(false);
      const first = await waitFor(() => f.onScreen()[0], "an agent on the screen");
      const other = await waitFor(() => f.ids.find((id) => f.asking(id)), "the other agent to wait its turn");
      const holder = onScreen(f.state().tasks)!.id;
      const heard = f.fakes.received("builder").filter((entry) => entry.session === first).length;

      f.engine.setScreenUse("off");
      // Not stopped, not messaged: it keeps the screen until its step ends.
      expect(f.task(holder).screen?.granted).toBe(true);
      expect(f.task(holder).state).toBe("running");
      // Only the switch allowed the other: it goes back to waiting for an OK.
      expect(f.task(other).statusLine).toBe(NEEDS);
      expect(f.screenItems().map((item) => item.taskId)).toEqual([other]);

      f.release(first);
      await f.until((state) => f.built(state, holder), "the agent on the screen to finish its step");
      expect(f.fakes.received("builder").filter((entry) => entry.session === first)).toHaveLength(heard);
      await Bun.sleep(400);
      expect(onScreen(f.state().tasks)).toBeUndefined();
      expect(f.asking(other)).toBe(true);
      expect(f.onScreen()).toEqual([first]);

      f.engine.allowScreen(other);
      const second = await waitFor(() => f.onScreen().find((session) => session !== first), "the other agent on the screen after Allow now");
      f.release(second);
      await f.until((state) => f.built(state, other), "the other build to finish");
    } finally {
      await f.close();
    }
  });

  it("keeps the screen through a restart and picks up as after any restart", async () => {
    const f = await fixture({ screen: "hold", reopen: "resume" });
    const [id] = f.ids as [string];
    try {
      f.engine.setScreenUse("on");
      f.engine.setPoolPaused(false);
      const session = await waitFor(() => f.onScreen()[0], "the agent on the screen");
      await f.restart();
      expect(f.task(id).screen).toMatchObject({ granted: true, heard: true });
      await f.until((state) => f.built(state, id), "the build to pick up and finish");
      const builder = f.fakes.received("builder");
      expect(builder.every((entry) => entry.session === session)).toBe(true);
      expect(builder.at(-1)!.text).toStartWith("Petrina restarted while you were on “Build” as the Builder.");
      expect(f.task(id).timeline.map((entry) => entry.text)).toContain("Picked up where it left off");
    } finally {
      await f.close();
    }
  });

  it("starts a fresh conversation, worded as waiting for the screen, when the tool cannot reopen it", async () => {
    const f = await fixture({ screen: "ask" });
    const [id] = f.ids as [string];
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => f.asking(id), "the builder to ask for the screen");
      f.engine.setScreenUse("on");
      await f.until((state) => f.built(state, id), "the build to finish");
      const openings = f.fakes.openings("builder");
      expect(openings).toHaveLength(2);
      const fresh = openings[1]!;
      expect(fresh).toContain(`## ${WHERE_YOU_WERE_SCREEN}`);
      expect(fresh).toContain("You asked for the screen while you were on “Build” as the Builder, and your conversation could not be reopened (Codex cannot reopen conversations), so this one is fresh.");
      expect(fresh).toContain("- added: notes.txt");
      expect(fresh).toContain(screenRules(REASON));
      expect(fresh).not.toContain("Petrina restarted");
      const turns = f.engine.tracking.log.turns({ taskId: id }).filter(turn => turn.roleId === "builder");
      expect(turns).toHaveLength(2);
      expect(new Set(turns.map(turn => turn.agentRunId)).size).toBe(2);
      expect(f.task(id).timeline.map((entry) => entry.text)).toContain("Started this step again: Codex cannot reopen conversations");
      // Only the agent that has the screen is told it may use it.
      expect(f.fakes.openings("code reviewer")[0]).not.toContain("You may now use the screen for");
    } finally {
      await f.close();
    }
  });

  it("drops the quiet inbox item when paused or cancelled, and starts the step fresh after resuming", async () => {
    const f = await fixture({ screen: "ask", reopen: "resume" });
    const [id] = f.ids as [string];
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => f.asking(id), "the builder to ask for the screen");
      f.engine.pause(id);
      expect(f.screenItems()).toEqual([]);
      expect(f.task(id).screen).toBeUndefined();
      expect(f.task(id).conversation).toBeUndefined();
      f.engine.resume(id);
      await waitFor(() => f.asking(id) && f.fakes.openings("builder").length === 2, "the builder to start fresh and ask again");
      expect(f.screenItems(id)).toHaveLength(1);
      const turns = f.engine.tracking.log.turns({ taskId: id }).filter(turn => turn.roleId === "builder");
      expect(turns).toHaveLength(2);
      expect(new Set(turns.map(turn => turn.agentRunId)).size).toBe(2);
      f.engine.cancel(id);
      expect(f.state().inbox).toEqual([]);
      expect(f.task(id).screen).toBeUndefined();
    } finally {
      await f.close();
    }
  });
});

describe("internal roles and reviewers asking for the screen", () => {
  it.each([false, true])("lets the Check finder ask and finish its own screen turn (already on: %s)", async (alreadyOn) => {
    const f = await fixture({ screenRoles: ["check finder"], reopen: "resume" });
    const [id] = f.ids as [string];
    try {
      if (alreadyOn) f.engine.setScreenUse("on");
      f.engine.setPoolPaused(false);
      if (!alreadyOn) {
        await waitFor(() => f.asking(id), "the Check finder to ask");
        expect(f.task(id).screen?.roleId).toBe("check-finder");
        expect(slotUses(f.state())).toEqual([]);
        f.engine.setProductChecks(f.task(id).productId, [{ name: "Your check", command: "git --version" }]);
        f.engine.allowScreen(id);
      }
      await f.until((state) => f.built(state, id), "the checks and review to finish");
      const received = f.fakes.received("check finder");
      expect(received).toHaveLength(2);
      expect(received[1]!.session).toBe(received[0]!.session);
      expect(received[1]!.text).toStartWith(screenRules(REASON));
      expect(f.fakes.opens().filter((entry) => entry.session === received[0]!.session).map((entry) => entry.how)).toEqual(alreadyOn ? ["new"] : ["new", "resume"]);
      expect(f.task(id).screen).toBeUndefined();
      expect(f.fakes.openings("code reviewer")[0]).not.toContain("You may now use the screen");
      if (!alreadyOn) {
        const product = f.state().products.find((entry) => entry.id === f.task(id).productId)!;
        expect(product.checksBy).toBe("coordinator");
        expect(product.checks?.map((check) => check.name)).toEqual(["Your check"]);
      }
    } finally { await f.close(); }
  });

  it("resumes both Check finders even after the first one saves checks for their shared product", async () => {
    const f = await fixture({ screenRoles: ["check finder"], screenRoleHold: true, reopen: "resume" }, 2);
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => f.ids.every((id) => f.asking(id)), "both Check finders to wait");
      const sessions = f.ids.map((id) => f.task(id).conversation!.sessionId);
      const released = new Set<string>();
      expect(slotUses(f.state())).toEqual([]);
      f.engine.setScreenUse("on");
      for (let index = 0; index < 2; index++) {
        const session = await waitFor(() => f.onScreen().find((entry) => !released.has(entry)), "the next Check finder to get the screen");
        expect(sessions).toContain(session);
        released.add(session);
        f.release(session);
      }
      await f.until((state) => f.ids.every((id) => f.built(state, id)), "both tasks to finish checking");
      for (const session of sessions) expect(f.fakes.received("check finder").filter((entry) => entry.session === session)).toHaveLength(2);
    } finally { await f.close(); }
  });

  it("lets the Guide keeper wait and reopen before the builder fixes the work", async () => {
    const f = await fixture({ screenRoles: ["guide keeper"], reopen: "load" });
    const [id] = f.ids as [string];
    try {
      f.engine.setPoolPaused(false);
      await f.until((state) => f.built(state, id), "the first delivery check");
      const item = f.state().inbox.find((entry) => entry.taskId === id && entry.kind === "delivery")!;
      f.engine.requestChanges(item.id, "Check the real window before delivery");
      await waitFor(() => f.asking(id), "the Guide keeper to ask");
      expect(f.task(id).screen?.roleId).toBe("guide-keeper");
      expect(slotUses(f.state())).toEqual([]);
      const session = f.task(id).conversation!.sessionId;
      f.engine.allowScreen(id);
      await f.until((state) => f.built(state, id), "the second delivery check");
      expect(f.fakes.received("guide keeper").map((entry) => entry.session)).toEqual([session, session]);
      expect(f.task(id).screen).toBeUndefined();
      expect(f.fakes.received("builder").at(-1)!.text).not.toContain("You may now use the screen");
    } finally { await f.close(); }
  });

  it("keeps both parallel reviewers' requests across a restart and reopens each conversation in turn", async () => {
    const f = await fixture({ planner: "parallel", screenRoles: ["code reviewer"], screenRoleHold: true, reopen: "resume" });
    const [id] = f.ids as [string];
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => f.asking(id) && Object.keys(f.task(id).hunt?.screenTurns ?? {}).length === 2, "both reviewers to wait");
      expect(slotUses(f.state())).toEqual([]);
      expect(f.screenItems(id)).toHaveLength(1);
      const sessions = f.fakes.received("code reviewer").map((entry) => entry.session);
      expect(new Set(sessions).size).toBe(2);
      const first = f.task(id).conversation!.sessionId;
      await f.restart();
      expect(f.asking(id)).toBe(true);
      expect(Object.keys(f.task(id).hunt!.screenTurns!)).toHaveLength(2);
      f.engine.sendMessage(id, "Check the Dock too");
      f.engine.allowScreen(id);
      await waitFor(() => f.onScreen().includes(first), "the first reviewer to get the screen");
      expect(slotUses(f.state())).toHaveLength(1);
      expect(f.fakes.received("code reviewer").filter((entry) => entry.text.includes("Check the Dock too"))).toHaveLength(1);
      const message = f.task(id).queued[0]!;
      expect(Object.values(message.recipients ?? {}).filter(Boolean)).toHaveLength(1);
      f.engine.removeQueued(id, message.id);
      expect(f.task(id).queued).toHaveLength(1);
      f.release(first);
      await waitFor(() => f.asking(id) && f.task(id).conversation?.sessionId !== first, "the next reviewer to wait for permission");
      expect(f.onScreen()).toEqual([first]);
      expect(slotUses(f.state())).toEqual([]);
      const second = f.task(id).conversation!.sessionId;
      expect(sessions).toContain(second);
      f.engine.setTaskScreen(id, true);
      await waitFor(() => f.onScreen().includes(second), "the second reviewer to get the screen");
      expect(slotUses(f.state())).toHaveLength(1);
      f.release(second);
      await f.until((state) => f.built(state, id), "both reviews to finish");
      for (const session of sessions) {
        expect(f.fakes.opens().filter((entry) => entry.session === session).map((entry) => entry.how)).toEqual(["new", "resume"]);
        expect(f.fakes.received("code reviewer").filter((entry) => entry.session === session)).toHaveLength(2);
        expect(f.fakes.received("code reviewer").filter((entry) => entry.session === session && entry.text.includes("Check the Dock too"))).toHaveLength(1);
      }
      expect(f.task(id).queued).toEqual([]);
      expect(f.task(id).screen).toBeUndefined();
      expect(f.task(id).hunt).toBeUndefined();
    } finally { await f.close(); }
  });

  it("gives a parallel reviewer the free screen live, and switching off holds the next reviewer", async () => {
    const f = await fixture({ planner: "parallel", screenRoles: ["code reviewer"], screenRoleHold: true, reopen: "resume" });
    const [id] = f.ids as [string];
    try {
      f.engine.setScreenUse("on");
      f.engine.setPoolPaused(false);
      await waitFor(() => f.onScreen().length === 1 && Object.keys(f.task(id).hunt?.screenTurns ?? {}).length === 2, "one reviewer on screen and the other waiting");
      const [first] = f.onScreen() as [string];
      expect(slotUses(f.state())).toHaveLength(1);
      expect(f.fakes.opens().filter((entry) => entry.session === first).map((entry) => entry.how)).toEqual(["new"]);
      f.engine.setScreenUse("off");
      expect(f.task(id).screen?.granted).toBe(true);
      f.release(first);
      await waitFor(() => f.asking(id), "the second reviewer to wait after switching off");
      expect(f.onScreen()).toEqual([first]);
      expect(f.screenItems(id)).toHaveLength(1);
      const second = f.task(id).conversation!.sessionId;
      f.engine.allowScreen(id);
      await waitFor(() => f.onScreen().includes(second), "the second reviewer to get its own turn");
      f.release(second);
      await f.until((state) => f.built(state, id), "the reviewers to finish");
    } finally { await f.close(); }
  });

  it("drains the reviewer on screen without starting the next one, then reopens the waiting reviewer after restarting", async () => {
    const f = await fixture({ planner: "parallel", screenRoles: ["code reviewer"], screenRoleHold: true, reopen: "resume" });
    const [id] = f.ids as [string];
    try {
      f.engine.setScreenUse("on");
      f.engine.setPoolPaused(false);
      await waitFor(() => f.onScreen().length === 1 && Object.keys(f.task(id).hunt?.screenTurns ?? {}).length === 2, "one reviewer on screen and the other waiting");
      const [first] = f.onScreen() as [string];
      const second = f.fakes.received("code reviewer").find((entry) => entry.session !== first)!.session;
      expect(f.engine.inFlight()).toBe(1);

      const drained = f.engine.drain(60_000);
      f.release(first);
      expect(await drained).toBe(0);
      await waitFor(() => f.asking(id), "the other reviewer to wait while Petrina stops");
      expect(f.onScreen()).toEqual([first]);
      expect(f.fakes.received("code reviewer").filter((entry) => entry.session === second)).toHaveLength(1);
      expect(slotUses(f.state())).toEqual([]);

      await f.restart();
      await waitFor(() => f.onScreen().includes(second), "the waiting reviewer to get the screen after restarting");
      f.release(second);
      await f.until((state) => f.built(state, id), "the review round to finish");
      expect(f.fakes.opens().filter((entry) => entry.session === second).map((entry) => entry.how)).toEqual(["new", "resume"]);
      expect(f.fakes.received("code reviewer").filter((entry) => entry.session === first)).toHaveLength(2);
    } finally { await f.close(); }
  });

  it("lets internal verifiers wait for the screen and give their verdicts on the same conversations", async () => {
    const f = await fixture({ planner: "parallel", reviewer: "important", verifier: "not-a-bug", screenRoles: ["verifier"], reopen: "resume" });
    const [id] = f.ids as [string];
    try {
      f.engine.setPoolPaused(false);
      // The bounded pair asks first; with a third usable tool, its third answer asks afterwards in a step of its own.
      const ready = f.state().tools.filter((tool) => tool.status === "ready").length || 2;
      const voters = Math.min(2, ready);
      await waitFor(() => f.asking(id) && Object.keys(f.task(id).hunt?.screenTurns ?? {}).length === voters, "the verifiers to ask");
      expect(f.task(id).screen?.roleId).toBe("verifier");
      expect(slotUses(f.state())).toEqual([]);
      const sessions = f.fakes.received("verifier").map((entry) => entry.session);
      f.engine.setScreenUse("on");
      await f.until((state) => f.built(state, id), "the verifiers to finish");
      const all = [...new Set(f.fakes.received("verifier").map((entry) => entry.session))];
      expect(all).toHaveLength(voters + (ready >= 3 ? 1 : 0));
      expect(f.onScreen().sort()).toEqual(all.sort());
      for (const session of sessions) expect(f.fakes.received("verifier").filter((entry) => entry.session === session)).toHaveLength(2);
      expect(f.task(id).findings.find((entry) => entry.verification)?.verification?.verdict).toBe("not-a-bug");
    } finally { await f.close(); }
  });
});

describe("screen requests and checked tools", () => {
  it.each([false, true])("keeps the login fix when the waiting agent's tool is logged out (parallel: %s)", async (parallel) => {
    const role = parallel ? "code reviewer" : "builder";
    const f = await fixture({ planner: parallel ? "parallel" : "short", screenRoles: [role], reopen: "resume" }, 1, { toolPath: () => process.execPath });
    const [id] = f.ids as [string];
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => f.asking(id) && (!parallel || Object.keys(f.task(id).hunt?.screenTurns ?? {}).length === 2), "the screen requests to wait");
      const session = f.task(id).conversation!.sessionId;
      const tool = f.task(id).conversation!.toolId;
      // The shared tools check changed while the agent waited for permission.
      f.engine.s.setup!.checks = [
        { id: "claude-code", status: tool === "claude-code" ? "logged-out" : "ready" },
        { id: "codex", status: tool === "codex" ? "logged-out" : "ready" },
        { id: "grok", status: "not-installed" },
      ];
      f.engine.setScreenUse("on");
      await f.until((state) => state.tasks.find((entry) => entry.id === id)?.state === "failed", "the tool's login fix");
      expect(f.fakes.received(role).filter((entry) => entry.session === session)).toHaveLength(1);
      expect(f.state().inbox.filter((item) => item.taskId === id)).toEqual([expect.objectContaining({ kind: "stuck", toolId: tool, toolProblem: "logged-out" })]);
      expect(onScreen(f.state().tasks)).toBeUndefined();
      expect(slotUses(f.state())).toEqual([]);
      expect(f.task(id).screen).toBeUndefined();
      expect(f.task(id).hunt?.screenTurns).toBeUndefined();
      expect(f.onScreen()).toEqual([]);
    } finally { await f.close(); }
  });
});

describe("screen requests when a tool runs out of usage", () => {
  it.each([false, true])("keeps the stand-in's conversation when the planned tool becomes free (parallel: %s)", async (parallel) => {
    const role = parallel ? "code reviewer" : "builder";
    const f = await fixture({ planner: parallel ? "parallel" : "short", screenRoles: [role], reopen: "resume", limited: [{ model: parallel ? "opus" : "gpt-6.1-sol", role }] }, 1, { toolPath: () => process.execPath });
    const [id] = f.ids as [string];
    try {
      f.engine.setPoolPaused(false);
      await waitFor(() => f.asking(id) && (!parallel || Object.keys(f.task(id).hunt?.screenTurns ?? {}).length === 2), "the stand-in to ask for the screen");
      const saved = parallel ? Object.values(f.task(id).hunt!.screenTurns!).map((entry) => entry.conversation.sessionId) : [f.task(id).conversation!.sessionId];
      // Its original planned tool is available again by the time the coordinator answers.
      delete f.engine.s.pool.limited;
      if (parallel) {
        const task = f.engine.s.tasks.find((entry) => entry.id === id)!;
        // A peer's background work still uses its own planned profile, not the screen holder's.
        for (const profileId of task.plan!.stages[task.stageIndex]!.profileIds) {
          expect(f.engine.choose(profileId, task, "code-reviewer")).toMatchObject({ profile: { id: profileId } });
        }
      }
      f.engine.setScreenUse("on");
      await f.until((state) => f.built(state, id), "the screen checks to finish on their own conversations");
      for (const session of saved) {
        const received = f.fakes.received(role).filter((entry) => entry.session === session);
        expect(received).toHaveLength(2);
        expect(received[1]!.text).toStartWith(screenRules(REASON));
      }
      expect(f.task(id).screen).toBeUndefined();
    } finally { await f.close(); }
  });

  it.each([false, true])("returns the screen when an agent runs out mid-check, and holds its stand-in while Off (parallel: %s)", async (parallel) => {
    const role = parallel ? "code reviewer" : "builder";
    const f = await fixture({ planner: parallel ? "parallel" : "short", screenRoles: [role], reopen: "resume", limited: [{ model: parallel ? "opus" : "gpt-6.1-sol", role, onScreen: true }] }, 1, { toolPath: () => process.execPath });
    const [id] = f.ids as [string];
    let switchedOff = false;
    const unsubscribe = f.engine.subscribe(() => {
      if (!switchedOff && f.task(id).screen?.granted && f.task(id).screen?.profileId === (parallel ? "opus-high" : "sol-xhigh")) {
        switchedOff = true;
        f.engine.setScreenUse("off");
      }
    });
    try {
      f.engine.setScreenUse("on");
      f.engine.setPoolPaused(false);
      await waitFor(() => f.asking(id) && f.state().pool.limited?.length && slotUses(f.state()).length === 0, "the screen agent to run out of usage and its peers to finish in the background");
      // A yielded member frees its seat before its process has fully stopped. Wait for the driver
      // and its peers to finish before counting prompts, rather than mistaking an in-flight prompt for a new start.
      await f.engine.settling.get(id);
      expect(switchedOff).toBe(true);
      expect(onScreen(f.state().tasks)).toBeUndefined();
      expect(slotUses(f.state())).toEqual([]);
      expect(f.screenItems(id)).toHaveLength(1);
      const before = f.fakes.received(role).length;
      await Bun.sleep(200);
      expect(f.fakes.received(role)).toHaveLength(before);
      f.engine.setScreenUse("on");
      await f.until((state) => f.built(state, id), "a stand-in to finish the screen check once allowed");
      const granted = f.fakes.received(role).filter((entry) => entry.text.includes(screenRules(REASON)));
      expect(new Set(granted.map((entry) => entry.session)).size).toBeGreaterThan(1);
      const retries = f.engine.tracking.log.moments({ taskId: id }).filter((entry) => entry.kind === "retry");
      expect(retries).toEqual([expect.objectContaining({ roleId: parallel ? "code-reviewer" : "builder" })]);
      if (parallel) {
        const review = f.task(id).journey!.find((step) => step.kind === "agent" && step.roleId === "code-reviewer")!;
        expect(review.team).toContain(retries[0]!.profileId!);
      }
      expect(f.task(id).screen).toBeUndefined();
    } finally { unsubscribe(); await f.close(); }
  });
});

describe("a Release Manager that asks for the screen", () => {
  it("gets its result handed back as unusable, and the release goes out without the screen", async () => {
    await nativeWorlds.world("screen-release-manager", async ({ world: w, engine: ownedEngine }) => {
    w.setScript((script) => (script.releaseManagerScreen = true));
    await ownedEngine(async engine => {
    let asked = false;
    const unsubscribe = engine.subscribe(() => {
      asked ||= engine.getState().tasks.some((task) => task.screen !== undefined);
    });
    try {
      engine.setScreenUse("on");
      const productId = await engine.addProduct(w.clone);
      engine.setProductDelivery(productId, "release", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting", description: "A greeting file. [quick]" });
      const task = taskOf(await finish(engine, taskId), taskId);
      expect(task.error).toBeUndefined();
      expect(task.release?.tag).toBe("v0.1.0");
      const prompts = w.script().releaseManagerPrompts!;
      expect(prompts[0]).not.toContain("needsScreen");
      expect(prompts[1]).toContain("Your result block could not be used: you cannot ask for the screen in this step");
      expect(asked).toBe(false);
    } finally {
      unsubscribe();
      await engine.shutdown();
    }
    });
    });
  });
});
