import { afterAll, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyView, mainLine, type Task } from "@petrina/core";
import { Engine } from "../../engine.js";
import type { NativeStep, Scenario } from "../../fake-agent.js";
import { Fakes, makeProduct, removeDir, tempDir, waitFor } from "../../fixtures.js";

// A native harness reporting its own reconnect, end to end: the participant's status on the task, its card,
// Right now and its live flow step, with no prompt, retry loop or capacity record of Petrina's own.

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

const CODEX_RECONNECTING = "Reconnecting to Codex. Trying automatically.";

/** codex-acp's own retry notice for a dropped stream, as Petrina receives it. */
const codexLostStream: NativeStep = { update: { sessionUpdate: "session_info_update", _meta: { codex: { error: { message: "Reconnecting... 1/5 (stream disconnected before completion: error sending request)", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } }, additionalDetails: null, turnId: "turn-1", willRetry: true } } } } as never };
/** Codex retrying something other than a connection: "retrying", with no network claim. */
const codexServerRetry: NativeStep = { update: { sessionUpdate: "session_info_update", _meta: { codex: { error: { message: "Reconnecting... 2/5 (internal server error)", codexErrorInfo: "internalServerError", additionalDetails: null, turnId: "turn-1", willRetry: true } } } } as never };
const said = (text: string): NativeStep => ({ update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
const todo = (text: string): NativeStep => ({ update: { sessionUpdate: "plan", entries: [{ content: text, status: "in_progress", priority: "medium" }] } });
const call = (id: string, kind: "read" | "edit", file: string, status: "in_progress" | "completed" = "in_progress"): NativeStep => ({ update: { sessionUpdate: "tool_call", toolCallId: id, title: kind === "read" ? "Read" : "Edit", kind, status, locations: [{ path: file }] } });
const finished = (id: string): NativeStep => ({ update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" } });

async function start(scenario: Scenario) {
  const root = tempDir("petrina-native-retry-");
  roots.push(root);
  const fakes = new Fakes(join(root, "fake"));
  fakes.scenario(scenario);
  const engine = new Engine(join(root, "data"), { agentCommand: () => [process.execPath, join(import.meta.dir, "../../fake-agent.ts"), fakes.dir], toolPath: () => process.execPath });
  const productId = await engine.addProduct(await makeProduct(root));
  engine.setProductDelivery(productId, "local", false);
  const taskId = engine.addTask({ productId, title: "Add a greeting", description: "[no-check]" });
  const find = () => engine.getState().tasks.find((task) => task.id === taskId) as Task;
  const live = () => engine.s.tasks.find((task) => task.id === taskId)!;
  const answer = () => {
    for (const item of engine.getState().inbox) {
      if (item.taskId !== taskId) continue;
      if (item.kind === "plan" || item.kind === "design") engine.approve(item.id);
      else if (item.kind === "question") engine.answer(item.id, item.options?.[0] ?? "Yes");
    }
  };
  let last = "";
  const until = <T>(check: (task: Task) => T | undefined | false, what: string) => waitFor(() => {
    answer();
    const task = find();
    last = `${task.state}: ${task.statusLine}`;
    if (task.state === "failed") throw new Error(`The task failed: ${task.error}`);
    return check(task);
  }, what).catch((error: Error) => { throw new Error(`${error.message} (last: ${last})`); });
  const release = (name: string) => writeFileSync(join(fakes.dir, name), "");
  /** What the window gets: the light task projection, without conversation bodies. */
  const shown = () => engine.windowState().tasks.find((task) => task.id === taskId)!;
  const nowStep = (task: Task) => journeyView(task, { roles: engine.getState().roles, profiles: engine.getState().profiles, tasks: engine.getState().tasks, inbox: engine.getState().inbox }).nodes.find((node) => node.state === "now");
  return { engine, fakes, taskId, find, live, until, release, shown, nowStep, answer };
}

describe.concurrent("a native harness reconnecting by itself", () => {
  for (const parallel of [false, true]) it(`does not request corrected JSON after a terminal connection failure in ${parallel ? "parallel review" : "a Builder turn"}`, async () => {
    const role = parallel ? "code reviewer" : "builder";
    const meta = { jetbrains: { air: { version: 1, sessionFailure: { id: "terminal-network", revision: 1, category: "connection", severity: "error", title: "stream disconnected before completion: retries exhausted", actions: ["retry", "new_session"] } } } };
    const run = await start({ planner: parallel ? "parallel" : "short", builder: "plain", reopen: "resume", nativeRetry: [{ role, model: "gpt-6.1-sol", steps: [said("I saved the work before reconnecting."), { mark: "terminal-ready" }, { wait: "end-terminal" }], meta }] });
    try {
      await run.until(task => run.fakes.marked("terminal-ready") && task, "the connection failure's controlled boundary");
      run.release("end-terminal");
      const failed = await waitFor(() => { run.answer(); const task = run.find(); return task.state === "failed" && task; }, "the typed failed turn");
      expect(failed.error).toContain("retries exhausted");
      const input = failed.journey!.flatMap(step => step.agentInputs ?? []).find(entry => entry.roleId === (parallel ? "code-reviewer" : "builder") && run.engine.profile(entry.profileId)?.toolId === "codex")!;
      expect(run.fakes.received(role).filter(entry => entry.session === input.sessionId)).toHaveLength(1);
      expect(run.fakes.prompts(role).some(text => text.includes("Your last answer"))).toBe(false);
      expect(failed.modelCapacity).toBeUndefined();
      expect(run.engine.getState().pool.limited ?? []).toEqual([]);
      expect(failed.session.some(line => line.text.includes("I saved the work before reconnecting"))).toBe(true);
      if (!parallel) {
        run.fakes.scenario({ planner: "short", builder: "plain", reopen: "resume" });
        const stuck = run.engine.getState().inbox.find(item => item.taskId === run.taskId && item.kind === "stuck")!;
        await run.engine.retry(stuck.id);
        await run.until(task => task.state === "done" && task, "ordinary retry after the connection recovered");
        // The existing explicit Retry starts fresh after a terminal failure; native retries
        // inside a still-running turn are the ones that retain their live conversation.
        expect(run.fakes.received(role)).toHaveLength(2);
        expect(new Set(run.fakes.received(role).map(entry => entry.session)).size).toBe(2);
      }
    } finally { await run.engine.shutdown(); }
  });
  it("shows Codex reconnecting over stale activity and the saved to-do item, then returns to the work, with nothing sent", async () => {
    const run = await start({
      planner: "short", builder: "plain",
      nativeRetry: [{ role: "builder", model: "gpt-6.1-sol", steps: [
        todo("Drafting the greeting"),
        call("read-1", "read", "greeting.txt"),
        { mark: "working" }, { wait: "go-retry" },
        // Codex repeats its notice while it keeps trying, and its reason changes once and back.
        codexLostStream, codexLostStream, codexServerRetry, codexLostStream,
        { mark: "reconnecting" }, { wait: "go-stale" },
        // An update to the earlier call is not the model working again.
        finished("read-1"),
        { mark: "stale" }, { wait: "go-resume" },
        said("Back on the greeting."),
        call("edit-1", "edit", "greeting.txt"),
        { wait: "go-finish" },
      ] }],
    });
    // Count what the retry changes: one light update per change, never a forced full save or a timeline line per notice.
    const counts = { commit: 0, commitNow: 0 };
    for (const name of ["commit", "commitNow"] as const) {
      const original = run.engine[name].bind(run.engine);
      run.engine[name] = ((target?: never) => { if (new Error().stack?.includes("showRetrying")) counts[name] += 1; original(target); }) as never;
    }
    try {
      await run.until((task) => task.todo === "Drafting the greeting" && task.statusLine === "Reading greeting.txt" && task, "the builder at work");
      const cursor = (await run.engine.events.wait({ taskIds: [run.taskId], timeoutMs: 0 })).cursor as string;
      run.release("go-retry");
      const reconnecting = await run.until((task) => task.retrying === CODEX_RECONNECTING && task, "Codex reconnecting");
      expect(reconnecting.state).toBe("running");
      expect(reconnecting.statusLine).toBe(CODEX_RECONNECTING);
      expect(mainLine(reconnecting)).toBe(CODEX_RECONNECTING);
      expect(run.nowStep(reconnecting)?.live).toBe(CODEX_RECONNECTING);
      // The window's light task view carries it to the card, Right now and the live flow step.
      expect(run.shown().retrying).toBe(CODEX_RECONNECTING);
      expect(mainLine(run.shown())).toBe(CODEX_RECONNECTING);
      expect(run.nowStep(run.shown())?.live).toBe(CODEX_RECONNECTING);
      await waitFor(() => run.find().timeline.filter((entry) => entry.text.includes(CODEX_RECONNECTING)).length === 1 || undefined, "one timeline line");

      run.release("go-stale");
      await run.until((task) => task.toolActivity?.runningTool === undefined && task.toolActivity?.lastActivity !== undefined && task, "the earlier call's update");
      expect(run.find().retrying).toBe(CODEX_RECONNECTING);
      expect(run.find().statusLine).toBe(CODEX_RECONNECTING);
      // Three changes (lost, retrying, lost again), each one light update. One timeline line for the retry's start.
      expect(counts).toEqual({ commit: 3, commitNow: 0 });
      expect(run.find().timeline.filter((entry) => entry.tone === "warn" && /Codex/.test(entry.text) && /Reconnecting|temporary problem/.test(entry.text))).toHaveLength(1);

      run.release("go-resume");
      const resumed = await run.until((task) => task.retrying === undefined && task.statusLine === "Editing greeting.txt" && task, "the builder back at work");
      expect(mainLine(resumed)).toBe("Drafting the greeting");
      expect(run.nowStep(resumed)?.live).toBe("Editing greeting.txt");
      expect(counts).toEqual({ commit: 4, commitNow: 0 });
      // The tool's own reconnect, old-call updates and fresh text are activity within this workflow step.
      expect((await run.engine.events.wait({ taskIds: [run.taskId], cursor, timeoutMs: 0 })).events).toEqual([]);

      run.release("go-finish");
      const task = await run.until((task) => task.state === "done" && task, "the task to finish");
      // No recovery prompt, no retry loop and no capacity wait of Petrina's own.
      expect(run.fakes.received("builder")).toHaveLength(1);
      expect(task.modelCapacity).toBeUndefined();
      expect(task.timeline.some((entry) => entry.text.includes("at capacity"))).toBe(false);
      expect(task.timeline.filter((entry) => entry.text.includes(CODEX_RECONNECTING))).toHaveLength(1);
      expect(task.retrying).toBeUndefined();
    } finally { await run.engine.shutdown(); }
  });

  it("clears the status when the turn fails during the retry, and leaves the failure to its usual handling", async () => {
    const run = await start({
      planner: "short", builder: "plain",
      nativeRetry: [{ role: "builder", model: "gpt-6.1-sol", steps: [
        todo("Drafting the greeting"), codexLostStream, { mark: "reconnecting" }, { wait: "go-fail" },
        { fail: { code: -32603, message: "Internal error", data: { message: "stream disconnected before completion: Transport error: timeout" } } },
      ] }],
    });
    try {
      await run.until((task) => task.retrying === CODEX_RECONNECTING && task, "Codex reconnecting");
      run.release("go-fail");
      const after = await waitFor(() => {
        run.answer();
        const task = run.find();
        return task.retrying === undefined && task.statusLine !== CODEX_RECONNECTING && task;
      }, "the retry status to end with the turn");
      expect(mainLine(after)).not.toBe(CODEX_RECONNECTING);
      expect(after.modelCapacity).toBeUndefined();
      expect(run.engine.getState().pool.limited ?? []).toEqual([]);
      // Petrina sent no recovery prompt into the failed conversation.
      expect(run.fakes.received("builder").filter((entry) => entry.session === run.fakes.received("builder")[0]!.session)).toHaveLength(1);
    } finally { await run.engine.shutdown(); }
  });

  it("puts a request for the coordinator first, then the reconnecting reviewer, and keeps it through the other's progress", async () => {
    const run = await start({
      planner: "parallel", builder: "plain", reopen: "resume",
      nativeRetry: [
        { role: "code reviewer", model: "gpt-6.1-sol", steps: [todo("Checking the greeting"), codexLostStream, { mark: "codex-reconnecting" }, { wait: "codex-resume" }, said("Back to the review."), { wait: "codex-finish" }] },
        { role: "code reviewer", model: "opus", steps: [call("opus-1", "read", "greeting.txt"), { mark: "opus-working" }, { wait: "opus-ask" }, { permission: "Run the greeting check" }, { wait: "opus-more" }, call("opus-2", "read", "README.md"), { mark: "opus-progress" }, { wait: "opus-done" }] },
      ],
      // After its progress, the other reviewer's model fills up: it stops working while Codex still retries.
      capacity: [{ model: "opus", role: "code reviewer", shape: "claude" }],
    });
    const seat = (task: Task, toolId: string) => {
      const agent = [task.agent, ...(task.helpers ?? [])].find((entry) => entry?.reviewKey !== undefined && run.engine.profile(entry.profileId)?.toolId === toolId);
      return agent?.reviewKey ? task.hunt?.work?.[agent.reviewKey] : undefined;
    };
    try {
      const both = await run.until((task) => !!seat(task, "codex")?.retrying && seat(task, "claude-code")?.activity === "Reading greeting.txt" && task, "one reviewer reconnecting while the other works");
      expect(seat(both, "codex")?.retrying).toBe(CODEX_RECONNECTING);
      expect(seat(both, "claude-code")?.retrying).toBeUndefined();
      expect(both.retrying).toBe(`${CODEX_RECONNECTING} The others continue.`);
      expect(mainLine(both)).toBe(`${CODEX_RECONNECTING} The others continue.`);
      expect(both.statusLine).toBe(`${CODEX_RECONNECTING} The others continue.`);
      expect(run.engine.profile(both.agent!.profileId)?.toolId).toBe("codex");

      // A request for the coordinator comes first.
      run.release("opus-ask");
      const asking = await run.until((task) => task.state === "needs-you" && task, "the other reviewer to ask");
      expect(mainLine(asking)).toBe("Waiting for your permission");
      expect(asking.retrying).toBeUndefined();
      expect(seat(asking, "codex")?.retrying).toBe(CODEX_RECONNECTING);
      const item = run.engine.getState().inbox.find((entry) => entry.taskId === run.taskId && entry.kind === "permission")!;
      run.engine.allow(item.id, "once");
      await run.until((task) => task.state === "running" && task.retrying === `${CODEX_RECONNECTING} The others continue.` && task, "the reconnect shown again");

      // The other reviewer's progress does not end this one's interruption.
      run.release("opus-more");
      const progressed = await run.until((task) => seat(task, "claude-code")?.activity === "Reading README.md" && task, "the other reviewer's progress");
      expect(seat(progressed, "codex")?.retrying).toBe(CODEX_RECONNECTING);
      expect(progressed.retrying).toBe(`${CODEX_RECONNECTING} The others continue.`);

      // Once the other reviewer stops on a full model, nobody else continues.
      run.release("opus-done");
      await run.until((task) => task.retrying === CODEX_RECONNECTING && task.statusLine === CODEX_RECONNECTING && task, "only the reconnecting reviewer working");

      // Useful work resumes before any tool call: the stale words do not stay on as the latest action.
      run.release("codex-resume");
      const back = await run.until((task) => seat(task, "codex") && !seat(task, "codex")?.retrying && task.retrying === undefined && task, "the Codex reviewer back at work");
      expect(back.statusLine).not.toContain("Reconnecting");
      expect(run.nowStep(back)?.live).not.toContain("Reconnecting");
      run.release("codex-finish");

      // The full model's short retry continues the other reviewer's own conversation.
      await waitFor(() => !run.engine.drivers.has(run.taskId) && !run.engine.settling.has(run.taskId) && (run.live().modelCapacity?.length ?? 0) > 0 || undefined, "the capacity wait");
      for (const entry of run.live().modelCapacity ?? []) entry.until = Date.now() - 1;
      run.engine.schedule();
      const task = await run.until((task) => task.state === "done" && task, "the task to finish");
      expect(task.retrying).toBeUndefined();
      const reviewers = run.fakes.received("code reviewer");
      expect(reviewers).toHaveLength(3);
      const again = reviewers.find((entry) => entry.text.startsWith("The selected model was at capacity."))!;
      expect(reviewers.filter((entry) => entry.session === again.session)).toHaveLength(2);
      expect(run.engine.getState().pool.limited ?? []).toEqual([]);
    } finally { await run.engine.shutdown(); }
  });
});
