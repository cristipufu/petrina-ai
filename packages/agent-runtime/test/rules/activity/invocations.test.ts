import { expect, it } from "bun:test";
import { ToolInvocations } from "../../../src/tool-invocations.js";
import { createToolActivity } from "../../../src/tool-activity.js";
import type { ToolActivityEvent } from "@petrina/orchestrator";

it("publishes explicit invocation observations without a task, native catalog or clock", () => {
  const events: ToolActivityEvent[] = [];
  let serial = 0, at = 10;
  const tracker = new ToolInvocations(event => events.push(structuredClone(event)), { id: () => `id-${++serial}`, now: () => at++, activity: createToolActivity(() => undefined) });
  tracker.update({ toolCallId: "same", kind: "execute", rawInput: { command: "date" }, status: "in_progress" }, true);
  tracker.update({ toolCallId: "same", status: "completed" }, false);
  expect(events[0]?.invocation).toMatchObject({ id: "id-2", turnId: "id-1", command: "date", startedAt: 10, status: "in_progress" });
  expect(events[1]?.invocation).toMatchObject({ id: "id-2", endedAt: 11, status: "completed" });
  expect(events[1]?.runningTool).toBeUndefined();
  tracker.endTurn(); tracker.startTurn();
  tracker.update({ toolCallId: "same", kind: "read" }, true);
  expect(events.at(-1)?.turnId).toBe("id-3");
  expect(events.at(-1)?.invocation?.id).toBe("id-4");
});
