import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { afterAll, expect, it } from "bun:test";
import { SLOW } from "@petrina/test-support/slow";
import { commandInputText, commandText } from "../../../src/checks.js";
import { BuildResult } from "../../../src/roles.js";
import { promptApplication } from "../../fixtures/prompt-application.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


for (const instructions of [undefined, "Use a focused test for the changed behavior."]) it(`supplies configured checks through context and the actual ${instructions ? "edited" : "built-in"} Builder turn`, async () => {
  return cases.use("prompt-application-", owner => promptApplication(owner, instructions, async f => {
  try {
    const argv = [process.execPath, "checks/welcome.ts", "runs.txt", "--pass"];
    const shown = commandText(argv);
    f.engine.setProductChecks("product", [{ name: "Welcome", command: commandInputText(argv) }]);
    const controller = new AbortController(); owner.onStop(() => controller.abort());
    await owner.run(f.engine, () => f.engine["turns"].turn(f.scope, "builder", "sol-high", () => f.engine["context"].sectionsFor(f.scope, "builder"), BuildResult, controller.signal));
    const received = f.agents.received("build");
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toContain(`## Product checks\n- Welcome: ${shown}`);
    if (instructions) expect(received[0]!.text).toContain(instructions);
    expect(f.task.journey!.at(-1)!.agentInputs!.at(-1)!.sections).toContainEqual({ title: "Product checks", body: `- Welcome: ${shown}` });
  } finally { await owner.stop(f.engine); }

  }));
}, 30_000 * SLOW);
