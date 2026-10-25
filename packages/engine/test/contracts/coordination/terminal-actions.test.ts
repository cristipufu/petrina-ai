import {afterAll,describe,expect,it,spyOn} from "bun:test";
import {expectRejection} from "@petrina/test-support/rejections";
import {coordinatorRecords} from "../../fixtures/coordinator-records.js";
import {removeDir} from "../../fixtures.js";
import {dispatch} from "../../../src/server.js";

describe("the local API's limits on take over and hand back", () => {
  const roots: string[] = [];
  afterAll(() => roots.forEach(removeDir));

  it("takes a task id and a note of at most 4000 characters", async () => {
    const {engine} = await coordinatorRecords(roots);
    const calls: unknown[][] = [];
    const takeOver = spyOn(engine, "takeOver").mockImplementation(async (...args) => {calls.push(["takeOver", ...args]); return {command: "launcher"};});
    const handBack = spyOn(engine, "handBack").mockImplementation(async (...args) => {calls.push(["handBack", ...args]);});
    const setTerminal = spyOn(engine, "setTerminal").mockImplementation((...args) => {calls.push(["setTerminal", ...args]);});
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
