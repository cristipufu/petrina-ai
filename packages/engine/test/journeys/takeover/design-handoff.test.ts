import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { waitFor } from "@petrina/test-support/fixtures";

import { sessionState } from "@petrina/agent-runtime/terminal";
import { takeoverFixtures, takeoverDir } from "../../fixtures/takeover.js";

const fixtures = takeoverFixtures(), start = fixtures.start;
afterAll(() => fixtures.close());
const posix = process.platform !== "win32";

describe.skipIf(!posix)("hand changes during design", () => {
  it("clears the question the architect had open, keeps the change, and the plan carries on in order with no extra review pass", async () => {
  return fixtures.use(async caseOwner => {
    const run = await start(caseOwner, { builder: "plain" }, "[no-check]");
    try {
      const asked = await waitFor(() => run.engine().getState().inbox.find((item) => item.taskId === run.taskId && item.kind === "question"), "the architect's question");
      expect(asked).toBeTruthy();
      await run.working("architect");
      run.cli({ write: { "design-note.txt": "A sketch\n" } });
      const engine = run.engine();
      await engine.takeOver(run.taskId);
      expect(engine.getState().inbox.filter((item) => item.taskId === run.taskId).map((item) => item.kind)).toEqual(["driving"]);
      expect(run.task().conversation?.asked).toBeUndefined();
      await waitFor(async () => (await sessionState(takeoverDir(run.data, run.taskId))) === "ended", "the app to close");
      await engine.handBack(run.taskId);
      expect(run.task().rereview).toBeUndefined();
      expect(run.task().handChanges).toBe(true);

      const done = await run.finished();
      expect(done.timeline.some((entry) => entry.text === "Reviewing your changes: the review starts again from the first reviewer")).toBe(false);
      // Two reviewers in the chain, each once.
      expect(done.timeline.filter((entry) => entry.text === "Code reviewer started")).toHaveLength(2);
      expect(readFileSync(join(run.product, "design-note.txt"), "utf8").trim()).toBe("A sketch");

    } finally { await run.close(); }

  });
});
});
