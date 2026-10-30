import { finishTaskStep, type ConversationNote, type Id } from "@petrina/core";
import { ParallelAdmissionGroup, ScreenArbitration, executionFor, type ParallelMember, type ParallelWorkspaceEffects, type RuntimeTask } from "../../src/index.js";
import { admissionFixture } from "./agent-workflow.js";
import { deferred } from "./tool-checks.js";

/** Real screen, group and scheduler owners. Conversations, copy references and result I/O are explicit effects. */
export function screenWorkflowFixture(count = 2, roleId = "code-reviewer") {
  const f = admissionFixture(4, 4, count);
  const records: { taskId: Id; text: string }[] = [], completed: string[] = [], calls: { taskId: Id; member: string; copy: string; continuing: boolean }[] = [];
  const scripts = new Map<Id, ParallelMember[]>(), cleanups = new Map<Id, () => Promise<void>>();
  const mainEffects = new Map<Id, (signal: AbortSignal) => Promise<void>>();
  const gates = new Set<ReturnType<typeof deferred<void>>>();
  let sequence = 0;
  const screen = new ScreenArbitration({
    state: () => f.state, task: f.task, stopped: f.host.stopped,
    sessionOwned: task => f.ownership.drivers.has(task.id) || f.ownership.settling.has(task.id),
    waitLine: f.host.admissionWait, column: f.host.column,
    record: (target, _tone, text) => { records.push({ taskId: "task" in target ? target.task.id : target.id, text }); },
    inboxId: () => `screen-${++sequence}`, checkpoint: scope => f.host.checkpoint(scope?.task), schedule: f.host.schedule,
  }, f.clock, f.ownership.groups);
  f.host.syncScreen = () => screen.syncScreen();
  f.groupHost.selectScreen = task => screen.selectScreen(task);
  f.groupHost.syncScreen = f.host.syncScreen;
  f.groupHost.finishStep = task => { finishTaskStep(task, executionFor(task).work, f.clock.now()); screen.releaseScreen(task); };
  const group = new ParallelAdmissionGroup(f.groupHost, { ownership: f.ownership, catalog: f.catalog, readiness: f.readiness, errors: f.errors });
  for (const id of f.ids) {
    const task = f.task(id)!;
    task.state = "backlog"; task.held = true; task.stageIndex = 0;
    task.plan = { rationale: "Screen requests", plannerProfileId: "opus-high", stages: [{ id: "review", kind: "review-chain", roleId, title: "Review", profileIds: ["opus-high", "sol-high"], maxRounds: 1 }] };
    task.hunt = { stageId: "review", round: 1, reported: {}, findings: 0 };
    executionFor(task).work.worktree = `opaque:workspace:${id}`;
  }
  f.phases.review = async (task, _stage, signal) => {
    const workspaces: ParallelWorkspaceEffects = {
      reference: member => `opaque:copy:${task.id}:${member}`,
      prepare: async () => ({ activate() {}, finish() {} }), stopHelpers() {}, closeTaskRun() {}, releasedStops: async () => {},
      finish: async () => { await cleanups.get(task.id)?.(); },
    };
    await group.run({ scope: executionFor(task), signal, members: (scripts.get(task.id) ?? []).filter(member => !completed.includes(`${task.id}:${member.key}`)),
      workspaces, status: (running, waiting) => `${running} working; ${waiting} waiting` });
    f.host.gate(task, "delivery");
    return "stop";
  };
  f.phases.doStage = async (scope, _stage, signal) => {
    const effect = mainEffects.get(scope.task.id);
    if (!effect) throw new Error("Unexpected main screen turn");
    if (!scope.task.screen?.granted && !screen.askScreen(scope.task, "builder", "opus-high", `Inspect ${scope.task.id}`)) throw f.errors.screenWait();
    await effect(signal);
    screen.releaseScreen(scope.task);
    f.host.gate(scope.task, "delivery");
    return "stop";
  };
  const gate = () => { const value = deferred<void>(); gates.add(value); return value; };
  const wait = async (value: ReturnType<typeof deferred<void>>, signal: AbortSignal) => {
    if (signal.aborted) throw f.errors.aborted();
    let abort!: () => void;
    try {
      await Promise.race([value.promise, new Promise<never>((_done, failed) => { abort = () => failed(f.errors.aborted()); signal.addEventListener("abort", abort, { once: true }); })]);
      if (signal.aborted) throw f.errors.aborted();
    } finally { signal.removeEventListener("abort", abort); }
  };
  const member = (task: RuntimeTask, index: 0 | 1, effect: (request: { copy: string; continuing: boolean; signal: AbortSignal; ask(): boolean }) => Promise<void>): ParallelMember => {
    const key = `review-${index}`, profileId = index ? "sol-high" : "opus-high";
    return { key, reviewKey: `reviewer:${index}`, reviewerKey: String(index), roleId, profileId,
      work: async (copy, _room, _seat, _used, _agent, continuing, signal) => {
        calls.push({ taskId: task.id, member: key, copy, continuing });
        const note: ConversationNote = { step: "review:1", roleId, profileId, toolId: f.catalog.profile(profileId)!.toolId, model: "explicit-script", sessionId: `opaque:conversation:${task.id}:${key}`, startedAt: f.clock.now(), briefed: true };
        await effect({ copy, continuing, signal, ask: () => {
          const granted = screen.saveTurn(executionFor(task), roleId, profileId, key, copy, note, `Inspect ${key}`);
          if (!granted) throw f.errors.screenWait();
          return granted;
        } });
        completed.push(`${task.id}:${key}`);
      } };
  };
  return { ...f, screen, records, calls, completed, scripts, cleanups, gate, wait, member,
    waitFor: <T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string) => f.waitFor(() => {
      if (f.failures.length || f.driverErrors.length) throw new AggregateError([...f.failures, ...f.driverErrors.map(entry => entry.error)], "Screen workflow failed before expected progress");
      return check();
    }, what),
    current: f.task(f.ids[0]!)!, later: f.task(f.ids[1]!)!,
    start(task: RuntimeTask, members: ParallelMember[]) { scripts.set(task.id, members); task.state = "waiting"; task.held = false; f.workflow.setPoolPaused(false); },
    startMain(task: RuntimeTask, effect: (signal: AbortSignal) => Promise<void>) {
      task.plan!.stages = [{ id: "build", kind: "do", roleId: "builder", title: "Build", profileIds: ["opus-high"] }];
      delete task.hunt;
      mainEffects.set(task.id, effect); task.state = "waiting"; task.held = false; f.workflow.setPoolPaused(false);
    },
    async close() { screen.stop(); for (const held of gates) held.resolve(); await f.close(); },
  };
}
