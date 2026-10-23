import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { commandHelp, coordinationCli, followEvents } from "../src/coordination-cli.js";
import type { EngineClient } from "../src/engine-client.js";
import { OPERATIONS, operation } from "../src/operations.js";

const root = resolve(import.meta.dir, "../../..");

afterEach(() => mock.restore());

describe("schema-derived coordination help", () => {
  it("explains source alternatives and generates valid examples for every structured option", () => {
    expect(commandHelp()).toContain("docs/coordination.md");
    expect(commandHelp()).toContain("docs/coordinator.md");
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

  it("links docs/coordinator.md from discovery points and references only supported operations", () => {
    const guide = readFileSync(resolve(root, "docs/coordinator.md"), "utf8");
    expect(readFileSync(resolve(root, "docs/coordination.md"), "utf8")).toContain("(coordinator.md)");
    expect(readFileSync(resolve(root, "README.md"), "utf8")).toContain("(docs/coordinator.md)");
    expect(readFileSync(resolve(root, "AGENTS.md"), "utf8")).toContain("(docs/coordinator.md)");
    expect(readFileSync(resolve(root, "docs/design.md"), "utf8")).toContain("(coordinator.md)");
    const groups = new Set(OPERATIONS.map((entry) => entry.name.split(".")[0]!));
    for (const match of guide.matchAll(/`(?:petrina\s+)?([a-z-]+)\s+([a-z-]+)(?:\s+[^`]*)?`/g)) {
      const [, group, verb] = match;
      if (groups.has(group!)) expect(operation(`${group}.${verb}`), `${group} ${verb}`).toBeDefined();
    }
    for (const match of guide.matchAll(/`petrina_([a-z]+)_([a-z_]+)`/g)) {
      const name = `${match[1]}.${match[2]!.replaceAll("_", "-")}`;
      expect(operation(name), name).toBeDefined();
    }
    expect(guide).toContain("**Failed or interrupted automated checks (`delivery` check problem)**");
    expect(guide).toContain("**Exhausted or unverified acceptance (`delivery`)**");
    expect(guide).toContain('`decision: "accepted"`, not `unconfirmed`');
    expect(guide).toContain("`watch wait --condition landed` completes only when the task's displayed `landing` is `landed`");
    expect(guide).toContain("**Unfinished local push (`publishing.result` kind `local-unpushed`):**");
    expect(guide).toContain("Petrina raises a `stuck` Inbox item whose decision is `inbox retry` (`inbox recovery` is refused).");
    expect(guide).toContain("**Interrupted delivery (`publishing.result` kind `interrupted`):**");
    expect(guide).not.toMatch(/\/Users\/|\/home\/|\btask-\d+\b|\bk\d{4,}\b|\b(?:Opus|Sonnet|Fable|Argon|Flash|Grok|astra)\b/i);
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
      ["task", "wait", "--reason", "null"],
      ["task", "wait", "--after", '"task-id"'],
      ["task", "wait", "--after", "[false]"],
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

describe("continuous event output", () => {
  it("refuses an immediate deadline for a continuous stream before querying, while a single immediate query still works", async () => {
    const call = mock().mockResolvedValueOnce({ outcome: "completed", cursor: "next", events: [] }).mockResolvedValueOnce({ outcome: "disconnected" });
    const client = { call } as unknown as EngineClient;
    const lines: string[] = [];
    expect(await followEvents(client, { timeoutMs: 0 }, line => { lines.push(line); return true; })).toBe(2);
    expect(lines.map(line => JSON.parse(line))).toEqual([{ outcome: "invalid", message: expect.stringContaining("positive deadline") }]);
    expect(call).not.toHaveBeenCalled();
    const output = spyOn(console, "log").mockImplementation(() => {});
    expect(await coordinationCli(["watch", "events", "--timeout-ms", "0", "--json"], client)).toBe(0);
    expect(call).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({ outcome: "completed", events: [] });
  });

  it("renews a quiet positive deadline silently from its cursor", async () => {
    const call = mock().mockResolvedValueOnce({ outcome: "timed-out", cursor: "quiet", events: [] }).mockResolvedValueOnce({ outcome: "disconnected" });
    const lines: string[] = [];
    expect(await followEvents({ call } as unknown as EngineClient, { timeoutMs: 20 }, line => { lines.push(line); return true; })).toBe(1);
    expect(lines.map(line => JSON.parse(line).outcome)).toEqual(["disconnected"]);
    expect(call.mock.calls[1]![1]).toMatchObject({ timeoutMs: 20, cursor: "quiet" });
  });

  it("releases backpressure and its listeners when the output pipe closes", async () => {
    const listeners = ["error", "close", "drain"].map(event => process.stdout.listenerCount(event));
    const call = mock(async () => ({ outcome: "completed", cursor: "next", events: [{ summary: "Started" }] }));
    const client = { call } as unknown as EngineClient;
    expect(await followEvents(client, {}, () => {
      queueMicrotask(() => process.stdout.emit("error", new Error("The reader closed its pipe")));
      return false;
    })).toBe(130);
    expect(call).toHaveBeenCalledTimes(1);
    expect(["error", "close", "drain"].map(event => process.stdout.listenerCount(event))).toEqual(listeners);
  });

  it("continues after a slow reader drains and removes its listeners on disconnection", async () => {
    const listeners = ["error", "close", "drain"].map(event => process.stdout.listenerCount(event));
    const call = mock().mockResolvedValueOnce({ outcome: "completed", cursor: "next", events: [{ summary: "Started" }] }).mockResolvedValueOnce({ outcome: "disconnected", message: "The engine stopped" });
    const lines: string[] = [];
    expect(await followEvents({ call } as unknown as EngineClient, {}, line => {
      lines.push(line);
      if (lines.length > 1) return true;
      queueMicrotask(() => process.stdout.emit("drain"));
      return false;
    })).toBe(1);
    expect(lines.map(line => JSON.parse(line).outcome)).toEqual(["completed", "disconnected"]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(["error", "close", "drain"].map(event => process.stdout.listenerCount(event))).toEqual(listeners);
  });
});
