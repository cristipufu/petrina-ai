import { afterAll, describe, expect, it } from "bun:test";
import { expectRejection } from "@petrina/test-support/rejections";
import { TAKE_OVER_WORDS, type State } from "@petrina/core";
import { coordinatorApiFixtures } from "../../fixtures/coordinator-api.js";
const metadata = coordinatorApiFixtures({ prefix: "petrina-takeover-", title: "Add a greeting" });
afterAll(() => metadata.close());

describe.concurrent("when take over is not available", () => {
  it("is refused for a task with no agent, with a plain reason", async () => {
    const { engine, taskId } = await metadata.fixture();
    await expectRejection(engine.takeOver(taskId), TAKE_OVER_WORDS.noAgent);
    expect((engine.getState() as State).terminals).toEqual([]);
    expect(() => engine.setTerminal("iterm")).toThrow("That terminal is not on this machine");
  });
});
