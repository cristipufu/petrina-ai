import { describe, expect, it } from "bun:test";
import { OPERATIONS } from "../../../src/operations.js";
import { docContracts, extractOperationGroups } from "../../quality/docs.js";

describe("documentation contracts", () => {
  it("verifies every operation group is documented in docs/coordination.md", () => {
    const valid = new Map([
      ["docs/coordination.md", "Groups are `engine`, `task` and `validation`.\n"],
      [
        "packages/engine/src/operations.ts",
        'op("task.list", "list", {}); op(`engine.${name}`, "lifecycle", {}); op("validation.run", "run", {});\n',
      ],
    ]);
    expect(extractOperationGroups(valid.get("packages/engine/src/operations.ts")!)).toEqual([
      "engine",
      "task",
      "validation",
    ]);
    expect(docContracts(valid)).toEqual([]);

    const missing = new Map([
      ["docs/coordination.md", "Groups are `engine` and `task`.\n"],
    ]);
    expect(docContracts(missing, OPERATIONS.map((entry) => entry.name))).toContain(
      "docs/coordination.md: missing operation group `validation` from packages/engine/src/operations.ts",
    );
  });

  it("verifies relative links across active docs while ignoring fenced code, external URLs, and docs/archive/", () => {
    const files = new Map([
      ["AGENTS.md", "# Rules\n"],
      ["docs/design.md", "See [UX](ux.md#board) and [Engine](architecture/engine-runtime.md).\n"],
      ["docs/ux.md", "# UX\n"],
      [
        "docs/architecture/engine-runtime.md",
        [
          "Back to [design](../design.md) and [rules](../../AGENTS.md).",
          "External [MCP](https://modelcontextprotocol.io/specification) and [anchor](#scheduling).",
          "```md",
          "[Example inside fenced block](does-not-exist.md)",
          "```",
          "Inline `[code link](also-ignored.md)` is ignored.",
        ].join("\n"),
      ],
      ["docs/archive/old-brief.md", "Historical [removed file](../removed.md) is excluded.\n"],
    ]);
    expect(docContracts(files, [])).toEqual([]);

    files.set("docs/architecture/broken.md", "Broken [target](../missing-doc.md#section).\n");
    files.set("README.md", "Root [broken](docs/does-not-exist.md).\n");
    expect(docContracts(files, [])).toEqual([
      "README.md:1: broken documentation link 'docs/does-not-exist.md' (expected 'docs/does-not-exist.md' in repository)",
      "docs/architecture/broken.md:1: broken documentation link '../missing-doc.md#section' (expected 'docs/missing-doc.md' in repository)",
    ]);
  });
});
