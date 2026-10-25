import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OPERATIONS, operation } from "../../../src/operations.js";
const root = resolve(import.meta.dir, "../../../../..");
describe("schema-derived coordination help", () => {
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
});
