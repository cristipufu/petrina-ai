import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addLearnings } from "../../../src/learnings.js";
import { removeDir, tempDir } from "../../fixtures.js";

describe("the Learnings section of AGENTS.md", () => {
  const folder = tempDir("petrina-learnings-");
  afterAll(() => removeDir(folder));
  const at = (name: string, text?: string) => {
    const root = mkdtempSync(join(folder, `${name}-`));
    if (text !== undefined) writeFileSync(join(root, "AGENTS.md"), text);
    return root;
  };
  const read = (root: string) => readFileSync(join(root, "AGENTS.md"), "utf8");

  it("starts the file, or the section at the end of an existing file", () => {
    const empty = at("empty");
    addLearnings(empty, ["Run the tests with bun test."]);
    expect(read(empty)).toBe("## Learnings\n\nWhat agents learned about working in this repository, added with the coordinator's OK.\n\n- Run the tests with bun test.\n");
    const kept = at("kept", "# Agents\n\nBe brief.\n");
    addLearnings(kept, ["One more"]);
    expect(read(kept)).toBe("# Agents\n\nBe brief.\n\n## Learnings\n\nWhat agents learned about working in this repository, added with the coordinator's OK.\n\n- One more\n");
  });

  it("adds to the end of the section, before whatever follows it", () => {
    const root = at("middle", "# Agents\n\n## Learnings\n\nIntro.\n\n- First\n\n## Checks\n\nRun them.\n");
    addLearnings(root, ["Second", "Third\nwith a break"]);
    expect(read(root)).toBe("# Agents\n\n## Learnings\n\nIntro.\n\n- First\n- Second\n- Third with a break\n\n## Checks\n\nRun them.\n");
  });

  it("keeps the native learning writer byte-for-byte consistent with the text policy", () => {
    const base = "# Agents\n\n## Learnings\n\nIntro.\n\n- First\n\n\n## Checks\n\nRun them.";
    const root = at("added", base);
    addLearnings(root, ["Second", "Third."]);
    expect(read(root)).toBe("# Agents\n\n## Learnings\n\nIntro.\n\n- First\n- Second\n- Third.\n\n## Checks\n\nRun them.\n");
  });
});
