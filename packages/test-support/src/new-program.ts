import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir, removeDir } from "./fixtures.js";
import { runCommand } from "./commands.js";
import { currentSlow } from "./slow.js";

/** Check the real POSIX executable boundary once per worker, retaining its original startup allowance. */
export function newProgramsStart(): Promise<void> {
  return checked ??= startsNewProgram(10_000);
}
let checked: Promise<void> | undefined;

async function startsNewProgram(ms: number): Promise<void> {
  if (process.platform === "win32") return;
  const dir = tempDir("petrina-new-program-");
  const file = join(dir, "new-program");
  try {
    writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const result = await runCommand([file], { cwd: dir, timeoutMs: ms * currentSlow() });
    if (result.code !== 0) throw new Error(`The new program exited with code ${result.code}.`);
  } catch (cause) {
    throw new Error(`This machine could not complete a newly written program within ${ms / 1000} seconds. ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  } finally { removeDir(dir); }
}
