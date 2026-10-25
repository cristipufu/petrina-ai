import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { onScreen, slotUses } from "@petrina/core";
import { Engine } from "../../engine.js";
import { Fakes, FAKE_AGENT, git, makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

/** Only stand-in agents ask for a screen; their turns end on a controlled file signal. */
async function fixture() {
  const root = tempDir("petrina-runtime-wait-screen-"); roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario({ planner: "short", builder: "plain", screen: "hold", screenLate: true, reopen: "resume" });
  const clone = await makeProduct(root);
  await git(clone, "config", "branch.autoSetupMerge", "false");
  const home = join(root, "data");
  const options = { agentCommand: () => [process.execPath, FAKE_AGENT, fakes.dir], remote: join(root, "origin.git") };
  let engine = new Engine(home, options);
  engine.setPoolPaused(true);
  const productId = await engine.addProduct(clone);
  engine.setProductDelivery(productId, "local", true);
  engine.setProductChecks(productId, [{ name: "Version", command: "git --version" }]);
  const prerequisite = engine.addTask({ productId, title: "Fix screen validation", backlog: true });
  const ids = ["First screen check", "Second screen check"].map(title => engine.addTask({ productId, title, description: "[no-check]" }));
  engine.setPoolPaused(false);
  await waitFor(() => fakes.received("builder").length === 2, "both Builders to start");
  const task = (id: string) => engine.taskDetails(id)!;
  const session = (id: string) => task(id).conversation!.sessionId;
  const sessions = ids.map(session);
  const f = {
    get engine() { return engine; }, fakes, ids, sessions, prerequisite, task,
    ask: (index: number) => writeFileSync(join(fakes.dir, `screen-ask-${sessions[index]}`), "go"),
    release: (index: number) => writeFileSync(join(fakes.dir, `screen-release-${sessions[index]}`), "go"),
    using: (index: number) => existsSync(join(fakes.dir, `on-screen-${sessions[index]}`)),
    asking: (index: number) => task(ids[index]!).state === "waiting" && !!task(ids[index]!).screen && !task(ids[index]!).screen!.granted,
    hold: () => engine.setRuntimeWait(ids[0]!, [prerequisite], "Wait for the screen validation fix", "hold"),
    clear: () => engine.setRuntimeWait(ids[0]!, [], "The coordinator resolved the prerequisite", "clear"),
    restart: async () => { await engine.shutdown(); engine = new Engine(home, options); await engine.waitUntilReady(); },
    close: async () => { await engine.shutdown(); },
  };
  return f;
}

describe.concurrent("screen requests during a prerequisite wait", () => {
  it.each([false, true])("keeps screen turns local to the task, preserving a held request across restart (held: %s)", async held => {
    const f = await fixture();
    try {
      f.ask(0); await waitFor(() => f.asking(0), "the first screen request");
      f.ask(1); await waitFor(() => f.asking(1), "the second screen request");
      const saved = structuredClone(f.task(f.ids[0]!).screen!);
      if (held) {
        f.hold();
        // A request's individual approval is retained even while the hold prevents admission.
        f.engine.allowScreen(f.ids[0]!);
      }
      f.engine.setScreenUse("on");
      const first = held ? 1 : 0;
      await waitFor(() => f.using(first), "the first eligible Builder to use the screen");
      expect(f.using(held ? 0 : 1)).toBe(false);
      expect(onScreen(f.engine.getState().tasks)?.id).toBe(f.ids[first]);
      if (!held) return;
      expect(f.task(f.ids[0]!).screen).toEqual({ ...saved, allowed: true });
      expect(f.task(f.ids[0]!).statusLine).toContain("Fix screen validation");
      f.release(1);
      await waitFor(() => f.engine.getState().inbox.some(item => item.taskId === f.ids[1] && item.kind === "delivery"), "the second task to finish its screen turn");
      await f.restart();
      expect(f.task(f.ids[0]!).screen).toEqual({ ...saved, allowed: true });
      expect(f.using(0)).toBe(false);
      expect(slotUses(f.engine.getState())).toEqual([]);
      f.clear();
      await waitFor(() => f.using(0), "the saved screen request to resume after release");
      const session = f.sessions[0]!;
      expect(f.fakes.opens().filter(open => open.session === session).map(open => open.how)).toEqual(["new", "resume"]);
      expect(f.fakes.received("builder").filter(prompt => prompt.session === session)).toHaveLength(2);
    } finally { await f.close(); }
  });

  it("lets an admitted screen agent finish before giving the next task its turn", async () => {
    const f = await fixture();
    try {
      f.engine.setScreenUse("on"); f.ask(0);
      await waitFor(() => f.using(0), "the first Builder to use the screen");
      f.hold(); f.ask(1);
      await waitFor(() => f.asking(1), "the second Builder to ask");
      expect(onScreen(f.engine.getState().tasks)?.id).toBe(f.ids[0]);
      expect(f.using(1)).toBe(false);
      expect(f.task(f.ids[0]!).holdsSlot).toBe(true);
      f.release(0);
      await waitFor(() => f.using(1), "the second Builder to take the released screen");
      expect(f.task(f.ids[0]!).screen).toBeUndefined();
      expect(f.task(f.ids[0]!).state).toBe("waiting");
      expect(f.task(f.ids[0]!).holdsSlot).toBe(false);
      expect(f.fakes.received("code reviewer").filter(prompt => prompt.text.includes("First screen check"))).toHaveLength(0);
      expect(f.task(f.ids[0]!).journey?.flatMap(step => step.agentResults ?? []).filter(result => result.roleId === "builder")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("saves a new screen request from an admitted Builder without starting its screen turn while held", async () => {
    const f = await fixture();
    try {
      f.engine.setScreenUse("on"); f.hold(); f.ask(0);
      await waitFor(() => f.asking(0), "the held Builder to save its screen request");
      expect(f.using(0)).toBe(false);
      expect(f.task(f.ids[0]!).holdsSlot).toBe(false);
      expect(f.task(f.ids[0]!).conversation?.sessionId).toBe(f.sessions[0]);
      f.ask(1);
      await waitFor(() => f.using(1), "the other task to use the free screen");
      expect(onScreen(f.engine.getState().tasks)?.id).toBe(f.ids[1]);
      expect(f.fakes.received("builder").filter(prompt => prompt.session === f.sessions[0])).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("returns a saved grant to the queue after restart without discarding its conversation", async () => {
    const f = await fixture();
    try {
      f.engine.setScreenUse("on"); f.ask(0);
      await waitFor(() => f.using(0), "the first Builder to use the screen");
      f.hold(); f.ask(1);
      await waitFor(() => f.asking(1), "the second Builder to ask");
      const saved = structuredClone(f.task(f.ids[0]!).screen!);
      await f.restart();
      await waitFor(() => f.using(1), "the second Builder to take the screen while the first is held");
      expect(f.task(f.ids[0]!).screen).toEqual({ ...saved, granted: false, heard: false });
      expect(f.task(f.ids[0]!).conversation?.sessionId).toBe(f.sessions[0]);
      expect(f.fakes.received("builder").filter(prompt => prompt.session === f.sessions[0])).toHaveLength(2);
      f.release(1);
      await waitFor(() => !onScreen(f.engine.getState().tasks), "the second Builder to return the screen");
      f.clear();
      await waitFor(() => f.fakes.received("builder").filter(prompt => prompt.session === f.sessions[0]).length === 3, "the saved first screen conversation to resume");
      expect(f.task(f.ids[0]!).screen?.granted).toBe(true);
      expect(f.fakes.opens().filter(open => open.session === f.sessions[0]).map(open => open.how)).toEqual(["new", "resume"]);
    } finally { await f.close(); }
  });

  it("keeps a terminal owner's saved screen until hand-back reaches the held boundary", async () => {
    const f = await fixture();
    try {
      f.engine.setScreenUse("on"); f.ask(0);
      await waitFor(() => f.using(0), "the first Builder to use the screen");
      f.hold();
      await f.engine.shutdown();
      const current = f.engine.task(f.ids[0]!)!;
      const saved = structuredClone(current.screen!);
      // Represent the existing terminal ownership contract without opening a real terminal.
      current.driving = { since: Date.now(), roleId: "builder", profileId: "sol-xhigh", toolId: "codex", head: current.repository!.conversation!.head! };
      f.engine.syncScreen();
      expect(current.screen).toEqual(saved);
      delete current.driving;
      f.engine.syncScreen();
      expect(current.screen).toEqual({ ...saved, granted: false, heard: false });
    } finally { await f.close(); }
  });
});
