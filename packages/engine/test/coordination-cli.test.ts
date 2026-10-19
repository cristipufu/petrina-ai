import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { commandHelp, coordinationCli } from "../src/coordination-cli.js";
import type { EngineClient } from "../src/engine-client.js";
import { OPERATIONS } from "../src/operations.js";

afterEach(() => mock.restore());

describe("schema-derived coordination help", () => {
  it("explains source alternatives and generates valid examples for every structured option", () => {
    expect(commandHelp("task", "add")).toContain('{kind: "branch", name: string}');
    expect(commandHelp("task", "add")).toContain('{kind: "pull-request", value: string}');
    expect(commandHelp("task", "list")).toContain('Array<"backlog" | "queued"');
    for (const operation of OPERATIONS) {
      const [group, verb] = operation.name.split(".");
      const help = commandHelp(group, verb);
      for (const match of help.matchAll(/Example: --([\w-]+) '([^']+)'/g)) {
        const key = match[1]!.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        const field = (operation.schema.shape as Record<string, { safeParse: (value: unknown) => { success: boolean } }>)[key]!;
        expect(field.safeParse(JSON.parse(match[2]!)).success, `${operation.name} --${match[1]}`).toBe(true);
      }
    }
  });

  it("names malformed flags and expected shapes without contacting the engine", async () => {
    const output = spyOn(console, "log").mockImplementation(() => {});
    const call = mock(async (_operation: string, _args: unknown) => ({ outcome: "completed" }));
    const client = { call } as unknown as EngineClient;
    for (const argv of [
      ["task", "add", "--start-from", "main"],
      ["task", "add", "--start-from", '{"kind":"branch"}'],
      ["task", "list", "--states", '"backlog"'],
      ["task", "list", "--limit", "NaN"],
      ["engine", "pause", "--wait=perhaps"],
    ]) {
      expect(await coordinationCli([...argv, "--json"], client)).toBe(2);
      const result = JSON.parse(output.mock.calls.at(-1)![0] as string);
      expect(result.message).toContain(argv[2]!.split("=")[0]);
      expect(result.message).toContain("expects");
    }
    expect(call).not.toHaveBeenCalled();
  });

  it("passes valid objects, arrays, booleans and numbers to the existing operation unchanged", async () => {
    spyOn(console, "log").mockImplementation(() => {});
    const call = mock(async (_operation: string, _args: unknown) => ({ outcome: "completed" }));
    const client = { call } as unknown as EngineClient;
    expect(await coordinationCli(["task", "add", "--title", "Fix the layout", "--start-from", '{"kind":"branch","name":"main"}', "--approve-plan=false", "--request-id", "cli-example"], client)).toBe(0);
    expect(call.mock.calls[0]).toEqual(["task.add", { title: "Fix the layout", startFrom: { kind: "branch", name: "main" }, approvePlan: false, requestId: "cli-example" }]);
    expect(await coordinationCli(["task", "list", "--states", '["backlog","queued"]', "--limit", "5", "--held"], client)).toBe(0);
    expect(call.mock.calls[1]).toEqual(["task.list", { states: ["backlog", "queued"], limit: 5, held: true }]);
  });
});
