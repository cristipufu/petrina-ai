import { expect, it, describe } from "vitest";
import { eventFixture } from "../../fixtures/workflow-events.js";

describe("focused monitoring evidence regressions", () => {
it("keeps the byte retention bound even when one complete detail exceeds it, and expires its page explicitly", async () => {
    const f = eventFixture({ bytes: 1000 }); const events = f.query;
    const start = await events({ timeoutMs: 0 });
    const [event] = f.events.log.append([{ at: 1, kind: "node.started", taskId: "large", productIds: ["product"], summary: "A step", cause: { reason: "x".repeat(9000) } }]);
    expect(f.events.log.size).toBe(0);
    expect(await events({ cursor: start.cursor, timeoutMs: 0 })).toMatchObject({ outcome: "continuity-lost", reason: "replay-expired" });
    expect(await f.events.log.read(event!.id, {  })).toMatchObject({ outcome: "unavailable", reason: "replay-expired" });
    expect(await f.events.log.read("other-run:1", {  })).toMatchObject({ outcome: "unavailable", reason: "different-engine-run" });
  });
});
