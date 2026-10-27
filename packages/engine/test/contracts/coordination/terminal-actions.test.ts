import {afterAll,describe,expect,it,spyOn} from "bun:test";
import {expectRejection} from "@petrina/test-support/rejections";
import {coordinatorRecordFixtures} from "../../fixtures/coordinator-records.js";
import {dispatch} from "../../../src/server.js";

describe("the local API's limits on take over and hand back", () => {
const owners = coordinatorRecordFixtures();
afterAll(() => owners.close());

  it("takes a task id and a note of at most 4000 characters", async () => {
  return owners.use(async ({engine, owner: lifetime}) => {

    const calls: unknown[][] = [];
    lifetime.check();
    const takeOver = spyOn(engine, "takeOver");
    lifetime.onStop(() => takeOver.mockRestore());
    takeOver.mockImplementation(async (...args) => {calls.push(["takeOver", ...args]); return {command: "launcher"};});
    lifetime.check();
    const handBack = spyOn(engine, "handBack");
    lifetime.onStop(() => handBack.mockRestore());
    handBack.mockImplementation(async (...args) => {calls.push(["handBack", ...args]);});
    lifetime.check();
    const setTerminal = spyOn(engine, "setTerminal");
    lifetime.onStop(() => setTerminal.mockRestore());
    setTerminal.mockImplementation((...args) => {calls.push(["setTerminal", ...args]);});
    try {
    await dispatch(engine, { name: "takeOver", args: ["task-7", "copy"] });
    await dispatch(engine, { name: "handBack", args: ["task-7", "x".repeat(4000), true] });
    expect(calls).toEqual([
      ["takeOver", "task-7", "copy"],
      ["handBack", "task-7", "x".repeat(4000), true],
    ]);
    await expectRejection(dispatch(engine, { name: "handBack", args: ["task-7", "x".repeat(4001)] }));
    await expectRejection(dispatch(engine, { name: "takeOver", args: ["../task-7"] }));
    await expectRejection(dispatch(engine, { name: "takeOver", args: ["task-7", "shell"] }));
    await expectRejection(dispatch(engine, { name: "setTerminal", args: ["iTerm; rm"] }));
    } finally {takeOver.mockRestore(); handBack.mockRestore(); setTerminal.mockRestore(); await engine.shutdown();}
  });
});
});
