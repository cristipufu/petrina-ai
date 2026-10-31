import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Task } from "@petrina/core";
import { verificationContextInput, type VerificationContextStorage, type VerificationVersions } from "./verification-context-input.js";

const nativeIndexes: VerificationContextStorage = {
  async saveIndex(dataDir, taskId, body, digest) {
    const folder = join(dataDir, "contexts", taskId, "verification");
  const file = join(folder, `${digest}.json`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const existing = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  if (existing !== undefined && existing !== body) throw new Error("The saved verification evidence changed. Try this step again.");
  if (existing === undefined) {
    const temporary = join(folder, `${digest}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
      try {
        await rename(temporary, file);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES") throw error;
        const saved = await readFile(file, "utf8").catch(() => undefined);
        if (saved === undefined) throw error;
        if (saved !== body) throw new Error("The saved verification evidence changed. Try this step again.");
      }
    } finally { await rm(temporary, { force: true }); }
  }
    return file;
  },
};

/** Native immutable report-index storage; report projection and lazy version consumption are portable. */
export function verificationContext(dataDir: string, task: Pick<Task, "id" | "journey" | "retest" | "repairCheck" | "repair" | "stageIndex" | "plan" | "proofDeliveryGate">, versions?: VerificationVersions | (() => Promise<VerificationVersions>)): ReturnType<typeof verificationContextInput> {
  return verificationContextInput(dataDir, task, versions, nativeIndexes);
}
