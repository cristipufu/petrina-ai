import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { State, Task } from "@petrina/core";
import { Engine } from "../src/engine.js";
import { EARLIER_ATTEMPT, formatWhereYouWere, WHERE_YOU_WERE } from "../src/prompts.js";
import { claudeSandbox } from "../src/sandbox.js";
import { Store } from "../src/store.js";
import type { Scenario } from "./fake-agent.js";
import { EngineProcess, Fakes, git, makeProduct, makeWorld, remoteRef, removeDir, SLOW, tempDir, waitFor } from "./support.js";

const roots: string[] = [];
const engines = new Set<EngineProcess>();
afterAll(async () => {
  await Promise.allSettled([...engines].filter((engine) => engine.proc.exitCode === null).map((engine) => engine.quit()));
  roots.forEach(removeDir);
}, 30_000 * SLOW);

async function harness(home: string, dir: string, remote?: string): Promise<EngineProcess> {
  const engine = await EngineProcess.harness(home, dir, remote);
  engines.add(engine);
  return engine;
}

type Reopen = "resume" | "load" | undefined;
type Stop = "quit" | "kill";

const QUESTION = "Should the greeting be formal?";
const named = (reopen: Reopen) => (reopen ? `reopening by ${reopen}` : "with no reopen support");
const after = (stop: Stop) => (stop === "quit" ? "an ordinary quit" : "a forced kill");
/** The engine heard the builder at work: its conversation is noted as briefed, and its first step is on the timeline. */
const heardWorking = (task: Task | undefined) => !!task?.conversation?.briefed && task.timeline.some((entry) => entry.text === "Drafting the greeting");

/** A product delivering locally with no checks, a task on it, and an engine on fake agents. */
async function start(scenario: Scenario, description = "", holdBuilder = false) {
  const root = tempDir("petrina-pickup-");
  roots.push(root);
  const product = makeProduct(root);
  const home = join(root, "home");
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const hold = holdBuilder ? join(root, "hold-builder") : undefined;
  if (hold) {
    writeFileSync(hold, "");
    writeFileSync(join(fakes.dir, "agents.json"), JSON.stringify({ hold: { title: "Add a greeting", file: hold } }));
  }
  const engine = await harness(home, fakes.dir);
  // These tests assert exact tools and saved conversation identities. A still-checking Codex may
  // otherwise be replaced by the first ready peer before the scenario even starts.
  await engine.until(
    (state) => ["claude-code", "codex"].every((id) => state.setup?.checks.some((check) => check.id === id && check.status === "ready" && !check.checking)),
    "Claude Code and Codex to be ready for the restart scenario",
  );
  const productId = (await engine.act("addProduct", product)) as string;
  await engine.act("setProductDelivery", productId, "local", false);
  const taskId = (await engine.act("addTask", { productId, title: "Add a greeting", description })) as string;
  const find = (state: State) => state.tasks.find((task) => task.id === taskId)!;
  const restart = async (engine: EngineProcess, stop: Stop) => {
    if (stop === "quit") await engine.quit();
    else await engine.kill();
    return harness(home, fakes.dir);
  };
  const finished = async (engine: EngineProcess) => find(await engine.until((state) => find(state).state === "done", "the task to finish", 60_000));
  // The fake marks the moment it starts working; the engine reads what it said a moment later.
  const working = async (engine: EngineProcess) => {
    await waitFor(() => fakes.marked("builder-working"), "the builder to start working");
    await engine.until((state) => heardWorking(find(state)), "the engine to hear the builder at work");
  };
  return { product, home, fakes, engine, taskId, find, restart, finished, working, hold };
}

describe.concurrent("an agent waiting on a question when Petrina restarts", () => {
  const cases: [Reopen, Stop][] = [
    ["resume", "quit"],
    ["resume", "kill"],
    ["load", "kill"],
    [undefined, "quit"],
  ];
  for (const [reopen, stop] of cases) {
    it(`${named(reopen)}, after ${after(stop)}: the question waits once, the answer arrives once`, async () => {
      const run = await start({ builder: "plain", ...(reopen ? { reopen } : {}) }, "[no-check]");
      let engine = run.engine;
      const asked = await engine.until((state) => state.inbox.some((item) => item.taskId === run.taskId && item.kind === "question"), "the architect's question");
      const question = asked.inbox.find((item) => item.taskId === run.taskId)!;
      expect(run.find(asked).conversation?.asked).toEqual({ itemId: question.id, question: QUESTION });

      // Twice in a row: the question stays in the inbox once, and nothing holds a slot for it.
      for (const how of [stop, "quit"] as const) {
        engine = await run.restart(engine, how);
        const state = await engine.state();
        const task = run.find(state);
        expect(state.inbox).toEqual([question]);
        expect(task.state).toBe("needs-you");
        expect(task.statusLine).toBe("Waiting for your answer");
        expect(task.holdsSlot).toBe(false);
      }
      await Bun.sleep(300);
      expect(run.fakes.prompts("architect")).toHaveLength(1);

      if (reopen === "load") await engine.act("decideForMe", question.id);
      else await engine.act("answer", question.id, "Formal", { taskId: run.taskId, about: question.title, clientId: "answer-1" });
      const done = await run.finished(engine);

      const architect = run.fakes.received("architect");
      // The answer reached the architect once, and it did not ask again.
      expect(architect.filter((entry) => entry.text.includes("The coordinator answered"))).toHaveLength(1);
      expect(done.timeline.filter((entry) => entry.text === `Asked you: ${QUESTION}`)).toHaveLength(1);
      expect(done.timeline.filter((entry) => entry.text.startsWith("You answered"))).toHaveLength(1);
      if (reopen) {
        // The same conversation, with no opening instructions the second time.
        const session = architect[0]!.session;
        expect(architect.every((entry) => entry.session === session)).toBe(true);
        expect(run.fakes.openings("architect")).toHaveLength(1);
        // Reopened like a new one: Claude Code's sandbox settings, and the coordinator's logins.
        expect(run.fakes.opens().filter((open) => open.session === session)).toEqual([
          { session, how: "new", tool: "claude-code", background: true, logins: true, quiet: true, sandbox: claudeSandbox() },
          { session, how: reopen, tool: "claude-code", background: true, logins: true, quiet: true, sandbox: claudeSandbox() },
        ]);
        const line = architect[1]!.text;
        expect(line).toStartWith("Petrina restarted while you were on “Design, round 1” as the Architect. You had just started this step. Your last action may not have finished, so check the working copy, then continue where you left off.");
        expect(line).toContain(`The coordinator answered your question “${QUESTION}”: Formal`);
        expect(line).not.toContain("You are the Architect");
        expect(done.timeline.find((entry) => entry.text === "Picked up where it left off")).toMatchObject({ roleId: "architect", profileId: "opus-xhigh" });
        expect(done.session.some((entry) => entry.from === "system" && entry.text.startsWith("Architect picked up where it left off · Architect on Claude Code · Opus 5.5"))).toBe(true);
        expect(done.timeline.some((entry) => entry.text.startsWith("Started this step again"))).toBe(false);
      } else {
        // A fresh conversation, with the answer next to its question and where it was.
        const openings = run.fakes.openings("architect");
        expect(openings).toHaveLength(2);
        expect(openings[1]).toContain(`The agent asked: ${QUESTION} | The coordinator answered: Formal`);
        expect(openings[1]).toContain(`## ${WHERE_YOU_WERE}`);
        expect(openings[1]).toContain("Petrina restarted while you were on “Design, round 1” as the Architect, and your conversation could not be reopened (Claude Code cannot reopen conversations)");
        expect(done.timeline.filter((entry) => entry.text.startsWith("Started this step again")).map((entry) => entry.text)).toEqual(["Started this step again: Claude Code cannot reopen conversations"]);
        expect(done.timeline.some((entry) => entry.text === "Picked up where it left off")).toBe(false);
      }
      expect(done.conversation).toBeUndefined();
      await engine.quit();
    });
  }
});

describe.concurrent("a builder working when Petrina restarts", () => {
  const cases: [Reopen, Stop][] = [
    ["resume", "quit"],
    ["resume", "kill"],
    ["load", "kill"],
    [undefined, "kill"],
  ];
  for (const [reopen, stop] of cases) {
    it(`${named(reopen)}, after ${after(stop)}: a message still in line arrives once, and nothing is heard twice`, async () => {
      const run = await start({ planner: "short", builder: "work", ...(reopen ? { reopen } : {}) });
      let engine = run.engine;
      await run.working(run.engine);
      // Heard before the restart: an interruption.
      await engine.act("sendMessage", run.taskId, "Use a friendly tone", "interrupt", "message-1");
      await waitFor(() => run.fakes.marked("builder-heard"), "the builder to hear the interruption");
      // Still in line when Petrina stops.
      await engine.act("sendMessage", run.taskId, "Keep it short", "queue", "message-2");

      // Noted the moment the conversation opened: the step, the role, the tool and model, the conversation and the commit.
      const before = run.find(await engine.state());
      const session = run.fakes.received("builder")[0]!.session;
      const note = { step: `${run.taskId}:s0 round 1 position 0`, roleId: "builder", profileId: "sol-xhigh", toolId: "codex", model: "gpt-6.1-sol", sessionId: session, head: git(before.worktree!, "rev-parse", "HEAD") };
      expect(before.conversation).toMatchObject(note);
      if (stop === "kill") {
        await engine.kill();
        const store = new Store(join(run.home, "petrina.db"));
        expect(store.load()!.tasks.find((task) => task.id === run.taskId)!.conversation).toMatchObject(note);
        store.close();
        engine = await harness(run.home, run.fakes.dir);
      } else {
        engine = await run.restart(engine, stop);
      }
      const done = await run.finished(engine);

      const builder = run.fakes.received("builder");
      // Heard exactly once in all, not just in one prompt: a fresh opening must not carry it in two sections.
      expect(builder.reduce((count, entry) => count + entry.text.split("Keep it short").length - 1, 0)).toBe(1);
      for (const id of new Set(builder.map((entry) => entry.session))) {
        expect(builder.filter((entry) => entry.session === id && entry.text.includes("Use a friendly tone"))).toHaveLength(1);
      }
      if (reopen) {
        expect(builder.every((entry) => entry.session === session)).toBe(true);
        const line = builder.find((entry) => entry.text.startsWith("Petrina restarted"))!.text;
        expect(line).toStartWith("Petrina restarted while you were on “Build” as the Builder. The last thing you were doing: Drafting the greeting.");
        expect(line).toContain("Messages from the coordinator you have not seen yet, in order:\n- Keep it short");
        expect(line).not.toContain("Use a friendly tone");
        // What load replayed is not shown again.
        expect(done.timeline.filter((entry) => entry.text === "Drafting the greeting")).toHaveLength(1);
        expect(done.session.filter((entry) => entry.from === "activity" && entry.text === "Editing notes.txt")).toHaveLength(1);
        expect(done.session.filter((entry) => entry.text === "Use a friendly tone")).toHaveLength(1);
        expect(done.session.filter((entry) => entry.text === "Keep it short")).toHaveLength(1);
        // The same rules as a fresh one: model, effort, then the safety mode; in the background with the
        // coordinator's logins, and nothing new for Codex, which keeps its own sandbox.
        const rules = ["model=gpt-6.1-sol", "reasoning_effort=xhigh", "mode=agent"];
        expect(run.fakes.settings(session)).toEqual([...rules, ...rules]);
        expect(run.fakes.opens().filter((open) => open.session === session)).toEqual([
          { session, how: "new", tool: "codex", background: true, logins: true, quiet: true },
          { session, how: reopen, tool: "codex", background: true, logins: true, quiet: true },
        ]);
      } else {
        const fresh = run.fakes.openings("builder")[1]!;
        expect(fresh).toContain(`## ${WHERE_YOU_WERE}`);
        expect(fresh).toContain("What you did last in this step, oldest first:\n- Editing notes.txt\n- Drafting the greeting");
        expect(fresh).toContain("Files added, changed or removed in the working copy since this step started:\n- added: notes.txt");
        expect(fresh).toContain(EARLIER_ATTEMPT);
        expect(done.timeline.some((entry) => entry.text === "Started this step again: Codex cannot reopen conversations")).toBe(true);
        // The new conversation's note replaced the old one, and the build built on the draft.
        expect(git(run.product, "show", "main:notes.txt")).toBe("A first draft");
      }
      expect(git(run.product, "show", "main:greeting.txt")).toBe("Hello (with left-pad)");
      await engine.quit();
    });
  }

  it("keeps the same conversation through several restarts in a row", async () => {
    const run = await start({ planner: "short", builder: "work", reopen: "resume", restarts: 2 });
    let engine = run.engine;
    await run.working(run.engine);
    engine = await run.restart(engine, "kill");
    await waitFor(() => run.fakes.marked("builder-restart-1"), "the builder to pick up");
    engine = await run.restart(engine, "quit");
    const done = await run.finished(engine);
    const builder = run.fakes.received("builder");
    expect(new Set(builder.map((entry) => entry.session)).size).toBe(1);
    expect(builder.filter((entry) => entry.text.startsWith("Petrina restarted"))).toHaveLength(2);
    expect(done.timeline.filter((entry) => entry.text === "Picked up where it left off")).toHaveLength(2);
    expect(run.fakes.openings("builder")).toHaveLength(1);
    await engine.quit();
  });

  it("starts fresh after a pause and resume, as before", async () => {
    const run = await start({ planner: "short", builder: "work", reopen: "resume" });
    await run.working(run.engine);
    await run.engine.act("sendMessage", run.taskId, "Keep it short", "queue", "message-1");
    await run.engine.act("pause", run.taskId);
    expect(run.find(await run.engine.state()).conversation).toBeUndefined();
    await run.engine.act("resume", run.taskId);
    const done = await run.finished(run.engine);
    const openings = run.fakes.openings("builder");
    expect(openings).toHaveLength(2);
    expect(openings[1]).toContain(EARLIER_ATTEMPT);
    expect(openings[1]).not.toContain(WHERE_YOU_WERE);
    expect(run.fakes.opens().some((open) => open.how !== "new")).toBe(false);
    expect(done.timeline.some((entry) => entry.text === "Picked up where it left off" || entry.text.startsWith("Started this step again"))).toBe(false);
    await run.engine.quit();
  });

  it("starts the step again when the saved conversation was on another model", async () => {
    const run = await start({ planner: "short", builder: "work", reopen: "resume" });
    await run.working(run.engine);
    await run.engine.kill();
    const store = new Store(join(run.home, "petrina.db"));
    const saved = store.load()!;
    store.save({ ...saved, tasks: saved.tasks.map((task) => (task.conversation ? { ...task, conversation: { ...task.conversation, model: "an-older-model" } } : task)) });
    store.close();

    const engine = await harness(run.home, run.fakes.dir);
    const done = await run.finished(engine);
    expect(run.fakes.opens().some((open) => open.how !== "new")).toBe(false);
    expect(run.fakes.openings("builder")[1]).toContain(`## ${WHERE_YOU_WERE}`);
    expect(done.timeline.some((entry) => entry.text === "Started this step again: it now runs on a different tool or model")).toBe(true);
    await engine.quit();
  });

  it("starts the step again when Petrina stopped before the agent got its instructions", async () => {
    const run = await start({ planner: "short", builder: "work", reopen: "resume" });
    await run.working(run.engine);
    await run.engine.kill();
    const store = new Store(join(run.home, "petrina.db"));
    const saved = store.load()!;
    expect(saved.tasks.find((task) => task.id === run.taskId)?.conversation?.briefed).toBe(true);
    // As if Petrina had stopped between noting the conversation and the agent hearing its instructions.
    store.save({ ...saved, tasks: saved.tasks.map((task) => (task.conversation ? { ...task, conversation: { ...task.conversation, briefed: false } } : task)) });
    store.close();

    const engine = await harness(run.home, run.fakes.dir);
    const done = await run.finished(engine);
    expect(run.fakes.opens().some((open) => open.how !== "new")).toBe(false);
    expect(run.fakes.openings("builder")[1]).toContain(`## ${WHERE_YOU_WERE}`);
    expect(done.timeline.some((entry) => entry.text === "Started this step again: it had not received its instructions yet")).toBe(true);
    await engine.quit();
  });

  it("starts the step again as before for a task an older Petrina saved, with no conversation note", async () => {
    const run = await start({ planner: "short", builder: "work", reopen: "resume" });
    await run.working(run.engine);
    await run.engine.act("sendMessage", run.taskId, "Keep it short", "queue", "message-1");
    await run.engine.kill();
    const store = new Store(join(run.home, "petrina.db"));
    const saved = store.load()!;
    store.save({ ...saved, tasks: saved.tasks.map(({ conversation: _, ...task }) => task as Task) });
    store.close();

    const engine = await harness(run.home, run.fakes.dir);
    const done = await run.finished(engine);
    const openings = run.fakes.openings("builder");
    expect(openings).toHaveLength(2);
    expect(openings[1]).toContain(EARLIER_ATTEMPT);
    expect(openings[1]).not.toContain(WHERE_YOU_WERE);
    expect(done.timeline.filter((entry) => entry.text === "Builder started")).toHaveLength(2);
    expect(done.timeline.some((entry) => entry.text === "Picked up where it left off" || entry.text.startsWith("Started this step again"))).toBe(false);
    await engine.quit();
  });
});

describe.concurrent("coordinator notes during a builder turn", () => {
  it("hands a short queue of notes over in one follow-up while preserving every note in order", async () => {
    const run = await start({ planner: "short", builder: "plain" }, "[no-check]", true);
    try {
      await waitFor(() => existsSync(`${run.hold}.reached`), "the builder to reach the hold");
      const messages = ["Keep it short", "Use a friendly tone", "Sign it from the team"];
      for (let i = 0; i < messages.length; i++) await run.engine.act("sendMessage", run.taskId, messages[i], "queue", `batch-${i}`);
      rmSync(run.hold!);
      const done = await run.finished(run.engine);
      const prompts = run.fakes.prompts("builder");
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain("Keep it short");
      expect(prompts[1]).toContain("Use a friendly tone");
      expect(prompts[1]).toContain("Sign it from the team");
      expect(prompts[1]!.indexOf("Keep it short")).toBeLessThan(prompts[1]!.indexOf("Use a friendly tone"));
      expect(prompts[1]!.indexOf("Use a friendly tone")).toBeLessThan(prompts[1]!.indexOf("Sign it from the team"));
      expect(done.timeline.filter((entry) => entry.text.startsWith("You said:")).map((entry) => entry.text)).toEqual(messages.map((message) => `You said: ${message}`));
    } finally {
      if (run.hold) rmSync(run.hold, { force: true });
      await run.engine.quit();
    }
  });
});

describe.concurrent("a permission request open when Petrina restarts", () => {
  for (const reopen of ["resume", undefined] as const) {
    it(`${named(reopen)}: leaves the inbox with a note, and the agent asks again`, async () => {
      const run = await start({ planner: "short", ...(reopen ? { reopen } : {}) });
      const asked = await run.engine.until((state) => state.inbox.some((item) => item.taskId === run.taskId && item.kind === "permission"), "the permission request");
      const request = asked.inbox.find((item) => item.taskId === run.taskId)!;
      const engine = await run.restart(run.engine, "quit");

      const again = await engine.until((state) => state.inbox.some((item) => item.taskId === run.taskId && item.kind === "permission"), "the builder to ask again");
      expect(again.inbox.map((item) => item.id)).not.toContain(request.id);
      expect(again.inbox).toHaveLength(1);
      const task = run.find(again);
      expect(task.timeline.some((entry) => entry.text === `Petrina restarted before you answered “${request.title}”, so it left your inbox. The agent will ask again if it still needs to`)).toBe(true);
      expect(task.timeline.some((entry) => entry.text === (reopen ? "Picked up where it left off" : "Started this step again: Codex cannot reopen conversations"))).toBe(true);

      await engine.act("allow", again.inbox[0]!.id, "once");
      const done = await run.finished(engine);
      expect(done.timeline.filter((entry) => entry.text.startsWith("You allowed"))).toHaveLength(1);
      expect(git(run.product, "show", "main:greeting.txt")).toBe("Hello (with left-pad)");
      await engine.quit();
    });
  }
});

describe.concurrent("a read-only agent that committed before a restart", () => {
  for (const reopen of ["resume", undefined] as const) {
    it(`${named(reopen)}: the clean-up goes back to the commit from when the step first started`, async () => {
      const run = await start({ planner: "short", builder: "plain", reviewer: "commit", ...(reopen ? { reopen } : {}) });
      await waitFor(() => run.fakes.marked("reviewer-committed"), "the reviewer to commit");
      const before = run.find(await run.engine.state());
      const built = git(before.worktree!, "rev-parse", "HEAD~1");
      expect(before.conversation?.head).toBe(built);
      // Killed: nothing is cleaned up on the way out.
      const engine = await run.restart(run.engine, "kill");
      const done = await run.finished(engine);
      expect(done.timeline.some((entry) => entry.text === "Undid commits from Code reviewer, which is read-only")).toBe(true);
      expect(git(run.product, "log", "--format=%s", "main")).not.toContain("A stray commit");
      if (!reopen) expect(run.fakes.openings("code reviewer")[1]).toContain("- added: stray.txt");
      await engine.quit();
    });
  }
});

describe.concurrent("a Release Manager interrupted by a restart", () => {
  it("never reopens its conversation, even on a tool that can: it gets the release ready again from the start", async () => {
    // Only a release has a Release Manager: this product publishes releases.
    const w = makeWorld("pickup-release-manager");
    roots.push(w.dir);
    const home = join(w.dir, "home");
    const fakes = new Fakes(w.dir);
    fakes.scenario({ planner: "short", builder: "plain", releaseManager: "hang", reopen: "resume" });
    let engine = await harness(home, w.dir, w.remote);
    const productId = (await engine.act("addProduct", w.clone)) as string;
    await engine.act("setProductDelivery", productId, "release", false);
    const taskId = (await engine.act("addTask", { productId, title: "Add a greeting" })) as string;
    const find = (state: State) => state.tasks.find((task) => task.id === taskId)!;
    await waitFor(() => fakes.marked("release-manager-started"), "the Release Manager to start");
    expect(find(await engine.state()).conversation).toBeUndefined();
    await engine.kill();
    engine = await harness(home, w.dir, w.remote);
    const done = find(await engine.until((state) => find(state).state === "done", "the release", 60_000));
    expect(done.release?.tag).toBe("v0.1.0");
    expect(remoteRef(w.remote, "refs/tags/v0.1.0")).toBe(git(w.clone, "rev-parse", done.branch!));
    expect(fakes.openings("release manager")).toHaveLength(2);
    expect(fakes.opens().some((open) => open.how !== "new")).toBe(false);
    await engine.quit();
  });
});

describe.concurrent("where you were, for a fresh conversation", () => {
  it("lists up to 30 files and counts the rest", () => {
    const files = Array.from({ length: 34 }, (_, index) => ({ change: "changed", file: `src/file-${index + 1}.ts` }));
    const text = formatWhereYouWere({ stage: "Build", role: "Builder", done: ["Running the tests"], files }, "Codex cannot reopen conversations");
    expect(text).toContain("- changed: src/file-30.ts\n- and 4 more");
    expect(text).not.toContain("src/file-31.ts");
    expect(text).toContain("What you did last in this step, oldest first:\n- Running the tests");
  });
});

describe.concurrent("a tool that cannot reopen the conversation after all", () => {
  for (const trouble of ["no answer", "no answer at all", "conversation gone"] as const) {
    it(`starts the step again when there is ${trouble === "no answer" ? "no answer in time" : trouble === "no answer at all" ? "no answer even to the first handshake" : "no such conversation any more"}`, async () => {
      const root = tempDir("petrina-pickup-");
      roots.push(root);
      const product = makeProduct(root);
      const fakes = new Fakes(join(root, "fake"));
      fakes.scenario({ planner: "short", builder: "work", reopen: "resume" });
      // "no answer at all": the reopen process never answers its handshake, whenever it is killed.
      let silentAfter: number | undefined;
      const agentCommand = () => {
        const silent = silentAfter === 0;
        if (silentAfter !== undefined) silentAfter -= 1;
        return [process.execPath, join(import.meta.dir, "fake-agent.ts"), fakes.dir, ...(silent ? ["--silent"] : [])];
      };
      // The missing-conversation case must hear the agent's error before the deadline; the two
      // silent-agent cases deliberately exercise the short deadline itself.
      const options = { agentCommand, reopenTimeoutMs: trouble === "conversation gone" ? 12_000 * SLOW : 1500 };
      let engine = new Engine(join(root, "data"), options);
      const productId = await engine.addProduct(product);
      engine.setProductDelivery(productId, "local", false);
      const taskId = engine.addTask({ productId, title: "Add a greeting" });
      await waitFor(() => fakes.marked("builder-working"), "the builder to start working");
      await waitFor(() => heardWorking(engine.getState().tasks.find((entry) => entry.id === taskId)), "the engine to hear the builder at work");
      engine.shutdown();

      if (trouble === "no answer") fakes.scenario({ planner: "short", builder: "work", reopen: "stall" });
      // The new engine checks the saved Builder's login first, then tries reopening it.
      else if (trouble === "no answer at all") silentAfter = 1;
      else fakes.forgetConversations();
      engine = new Engine(join(root, "data"), options);
      const done = await waitFor(() => {
        const task = engine.getState().tasks.find((entry) => entry.id === taskId);
        return task?.state === "done" && task;
      }, "the task to finish", 60_000);
      engine.shutdown();
      expect(done.timeline.filter((entry) => entry.text.startsWith("Started this step again")).map((entry) => entry.text)).toEqual([
        trouble === "conversation gone" ? "Started this step again: Codex could not reopen the conversation" : "Started this step again: Codex did not reopen the conversation within 2 seconds",
      ]);
      const fresh = fakes.openings("builder")[1]!;
      expect(fresh).toContain("- added: notes.txt");
    });
  }
});
