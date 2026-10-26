import { afterAll, expect, it } from "bun:test";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";
import { commandInputText } from "../../../src/checks.js";
import { BuildResult } from "../../../src/roles.js";
import { promptApplication } from "../../fixtures/prompt-application.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const instructions of [undefined, "Use a focused test for the changed behavior."]) it(`supplies configured checks through context and the actual ${instructions ? "edited" : "built-in"} Builder turn`, async () => {
  const root = tempDir("prompt-application-"); roots.push(root);
  const f = await promptApplication(root, instructions);
  try {
    const command = commandInputText([process.execPath, "checks/welcome.ts", "runs.txt", "--pass"]);
    f.engine.setProductChecks("product", [{ name: "Welcome", command }]);
    await f.engine["turns"].turn(f.scope, "builder", "sol-high", () => f.engine["context"].sectionsFor(f.scope, "builder"), BuildResult, new AbortController().signal);
    const received = f.agents.received("build");
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toContain(`## Product checks\n- Welcome: ${command}`);
    if (instructions) expect(received[0]!.text).toContain(instructions);
    expect(f.task.journey!.at(-1)!.agentInputs!.at(-1)!.sections).toContainEqual({ title: "Product checks", body: `- Welcome: ${command}` });
  } finally { await f.engine.shutdown(); }
}, 30_000 * SLOW);
