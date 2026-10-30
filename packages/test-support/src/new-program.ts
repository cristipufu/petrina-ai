import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, removeDir } from "./fixtures.js";
import { runCommand } from "./commands.js";
import { currentSlow } from "./slow.js";
import { registerFixtureRoot } from "./fixture-retention.js";
import { runSettlements } from "./run-settlement.js";

/** Check the real POSIX executable boundary once per worker, retaining its original startup allowance. */
export function newProgramsStart(): Promise<void> {
  return checked ??= startsNewProgram(10_000);
}
let checked: Promise<void> | undefined;

/** Private canonical-run boundary for the startup probe's cleanup contract. */
export async function startsNewProgram(ms: number, run: typeof runCommand = runCommand): Promise<void> {
  if (process.platform === "win32") return;
  const dir = tempDir("petrina-new-program-");
  const file = join(dir, "new-program");
  const settlements = runSettlements();
  try {
    registerFixtureRoot(dir);
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const observation = await settlements.observe({ run: () => run([file], { cwd: dir, timeoutMs: ms * currentSlow() }) });
    if (observation.kind === "rejected") throw observation.error;
    if (observation.result.code !== 0) throw new Error(`The new program exited with code ${observation.result.code}.`);
  } catch (cause) {
    throw new Error(
      `This machine could not complete a newly written program within ${ms / 1000} seconds. ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  } finally { await settlements.dispose({ close: () => removeDir(dir) }); }
}
