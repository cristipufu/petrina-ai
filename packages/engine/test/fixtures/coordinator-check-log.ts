import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckRun } from "@petrina/core";
import { runChecks } from "../fixtures.js";

/** Actual captured process provenance, with a separate writable log for every case. */
export async function createdFailure(home: string, taskId: string, text: string): Promise<CheckRun> {
  const payload = join(home, "check-output.txt");
  writeFileSync(payload, text);
  try {
    const source = `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(payload)})); process.exit(1)`;
    const [run] = await runChecks(home, [{ name: "Check", argv: [process.execPath, "-e", source] }], process.env, 10_000, undefined, join(home, "checks", taskId));
    return run!;
  } finally { unlinkSync(payload); }
}

/** Retarget only with all the identity facts captured by the actual runner. */
export const retarget = (run: CheckRun, fresh: CheckRun, logPath = fresh.logPath) =>
  Object.assign(run, { logPath, logFileIdentity: fresh.logFileIdentity, logFileLength: fresh.logFileLength, logFileBeginning: fresh.logFileBeginning });
