import { afterAll, describe, expect, it } from "bun:test";
import { runProcess } from "@petrina/test-support/run-process";
import { startCommand } from "@petrina/test-support/commands";
import { settleCommandAfterStop } from "@petrina/test-support/command-settlement";
import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import type { WorkflowEvent } from "@petrina/core";
import { CLI, engineEnv, waitFor } from "../../support.js";
import { createWorkflowEventFixtures } from "../../fixtures/workflow-event-native.js";
const { served, close, use } = createWorkflowEventFixtures();
afterAll(close);
describe("waits over the local connection, MCP and the terminal", () => {
it("streams one batch per line in the terminal, renews quiet deadlines silently and stops cleanly on interruption", async () => {
  return use("petrina-events-", async caseOwner => {
    const { e, home, taskId , stopServer} = await served(caseOwner);
    const controller = new AbortController();
    caseOwner.onStop(() => controller.abort("SIGINT"));
    const lines: string[] = [];
    let partial = "", subscriptions = 0;
    const subscribe = e.events.log.subscribe.bind(e.events.log);
    e.events.log.subscribe = listener => { subscriptions++; return subscribe(listener); };
    const completion = caseOwner.prepare(() => runProcess([process.execPath, CLI, "watch", "events", "--task-ids", JSON.stringify([taskId]), "--timeout-ms", "300", "--follow", "--json"], {
      env: engineEnv(home), signal: controller.signal,
      start: (argv, options) => {
        const child = startCommand(argv, options);
        // The original contract interrupts this exact native handle, including on Windows.
        child.interrupt ??= signal => child.kill(signal);
        return child;
      },
      onOutput: (text, stream) => {
        if (stream !== "stdout") return undefined;
        partial += text;
        const frames = partial.split("\n");
        partial = frames.pop()!;
        lines.push(...frames.filter(Boolean));
        return undefined;
      },
    }));
    const result = completion.then(outcome => outcome.result);
    void result.catch(() => undefined); // The operation is still awaited below and on every failure path.
    const stop = async () => {
      controller.abort("SIGINT");
      await settleCommandAfterStop({ result, abort: () => controller.abort("SIGINT") });
    };
    caseOwner.onStop(stop);
    caseOwner.onStop(() => { e.events.log.subscribe = subscribe; });
    try {
      await setupWithCleanup(async () => {
        // Three actual subscriptions prove two quiet 300ms renewals, without a guessed sleep.
        await waitFor(() => subscriptions >= 3 && e.events.waiting >= 1, "the quiet deadline renewals", 30_000, { during: completion });
        expect(lines).toHaveLength(0);
        const task = e.task(taskId)!;
        const before = subscriptions;
        e.s.inbox.push({ id: "stream-q", taskId, kind: "question", title: "Streamed?", at: Date.now(), blocking: true });
        task.state = "needs-you";
        e.commit(task);
        await waitFor(() => lines.length > 0, "the complete JSON-lines batch", 30_000, { during: completion });
        expect(lines).toHaveLength(1);
        const batch = JSON.parse(lines[0]!);
        expect(batch.outcome).toBe("completed");
        expect(batch.events.map((event: WorkflowEvent) => event.kind)).toEqual(["coordinator.request", "task.state"]);
        await waitFor(() => subscriptions > before && e.events.waiting >= 1, "the renewed wait", 30_000, { during: completion });
        controller.abort("SIGINT");
        await waitFor(() => e.events.waiting === 0, "the stream's wait released", 2_000);
        expect(e.task(taskId)!.state).toBe("needs-you");
      }, stop);
      expect((await completion).result.code).toBe(130);
      expect(partial).toBe("");
    } finally {
      e.events.log.subscribe = subscribe;
      await stopServer();
    }
  });
});
});
