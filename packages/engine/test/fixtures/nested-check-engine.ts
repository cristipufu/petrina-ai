import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Fakes, engineProcessCases } from "../support.js";

/** Actual child-check entry: native app isolation is asserted in the environment under test. */
export async function nestedCheckEngine(root: string): Promise<void> {
  const owned = join(root, "nested-engine");
  const cases = engineProcessCases();
  await cases.use(owned, async owners => {
    mkdirSync(owned);
    const fakes = new Fakes(join(owned, "fakes")); fakes.scenario({});
    const engine = await owners.harness(join(owned, "home"), fakes.dir);
    try {
      if (engine.hello.type !== "ready") throw new Error(engine.hello.type === "error" ? engine.hello.message : "not ready");
      if (process.env.PETRINA_RECONNECT_PORT || process.env.PETRINA_LIFECYCLE_REPLACEMENT) throw new Error("Engine restart settings leaked");
    } finally { await engine.quit(); }
  });
}
