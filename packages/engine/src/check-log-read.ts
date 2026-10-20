// Verify and page the diagnostic file belonging to one recorded check.
import type { Task } from "@petrina/core";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Result } from "./coordination.js";
import { cursor, fingerprint, position, readText } from "./evidence-read.js";

export function matchesCheckLogIdentity(expected: { device: string; inode: string }, actual: { dev: bigint; ino: bigint }): boolean {
  return expected.device === actual.dev.toString() && expected.inode === actual.ino.toString();
}
export async function readCheckLog(dataDir: string, task: Task, a: { nodeId?: string; index: number; section?: string; cursor?: string; limit?: number }): Promise<Result> {
  const node = a.nodeId ? task.journey?.find((node) => node.id === a.nodeId) : undefined;
  if (a.nodeId && !node) return { outcome: "missing", message: "That journey node does not exist." };
  const run = a.nodeId ? node?.productChecks?.[a.index]?.run : task.checks?.results[a.index];
  const metadata = {
    commandOutcome: !run ? "unavailable" : run.interrupted || run.cleanupIncomplete || run.timedOut ? "unfinished" : run.ok ? "passed" : "failed",
    relevance: a.nodeId ? "historical" : task.checks?.sha || task.checks?.tree ? "recorded-version-only" : "unverified",
    command: run?.command ?? null,
  };
  if (!run) return { outcome: "unavailable", ...metadata, completeness: "missing", message: "This older evidence has no original diagnostic link." };
  const resultScope = [task.id, a.nodeId, a.index, "saved-result"];
  if (a.section === "result")
    return readText(run.output, a, resultScope, { ...metadata, source: "saved-result", completeness: "excerpt-only", unit: "characters" });
  // Engine explanations (startup failures, deadlines and cleanup warnings) can exist only
  // in the saved result. Show a bounded first page alongside the original process log.
  const savedResult = { ...readText(run.output, { limit: Math.min(a.limit ?? 8000, 1000) }, resultScope), section: "result" };
  const details = { ...metadata, savedResult };
  const path = run.logPath && resolve(run.logPath);
  if (!path || !path.startsWith(resolve(dataDir, "checks", task.id) + sep))
    return readText(run.output, a, [task.id, a.nodeId, a.index], {
      ...details,
      completeness: "excerpt-only",
      message: "No complete diagnostic log was recorded. This is the saved excerpt.",
    });
  if (!run.logFileIdentity)
    return readText(run.output, a, [task.id, a.nodeId, a.index, "unverified-log"], {
      ...details,
      completeness: run.logError || run.logComplete === false ? "incomplete" : "legacy-unverified",
      message: "This saved run has no record of which file Petrina created. This is the saved excerpt.",
    });
  try {
    const [entry, root, canonical] = await Promise.all([lstat(path, { bigint: true }), realpath(dataDir), realpath(path)]);
    const directory = resolve(root, "checks", task.id);
    if (!entry.isFile() || entry.nlink !== 1n || !canonical.startsWith(directory + sep)) throw new Error("The diagnostic is not an unshared regular file in this task's check folder.");
    // Do not follow a substituted link. Use the opened file's identity and size for both
    // pagination and reading; a replaced file invalidates its previous continuation.
    // A second hard-link name can alias a private file, so both observations require one link.
    // The saved file identity also proves this is the file Petrina created for this check;
    // link counts alone are insufficient after an atomic replacement removes the other name.
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const exact = await file.stat({ bigint: true });
      const size = Number(exact.size);
      const modified = exact.mtimeNs.toString();
      if (!exact.isFile() || exact.nlink !== 1n || exact.dev !== entry.dev || exact.ino !== entry.ino || !matchesCheckLogIdentity(run.logFileIdentity, exact)) throw new Error("The diagnostic file is not the file Petrina created for this check.");
      const key = fingerprint([task.id, a.nodeId, a.index, path, exact.dev.toString(), exact.ino.toString(), size, modified]);
      const completeness = run.logError || run.logComplete === false ? "incomplete" : run.logComplete ? "complete" : "legacy-unverified";
      if (size === 0 && run.output)
        return readText(run.output, a, [resultScope, path, exact.dev.toString(), exact.ino.toString(), modified], {
          ...details, completeness, logError: run.logError ?? null, source: "saved-result", unit: "characters",
          message: "The process log is empty. This is the saved result, including any failure to start.",
        });
      const at = position(a.cursor, key);
      if (at === undefined) return { outcome: "changed", message: "The diagnostic changed. Read it again from the beginning." };
      const buffer = Buffer.alloc((a.limit ?? 8000) * 4),
        { bytesRead } = await file.read(buffer, 0, buffer.length, at);
      // Limit text by characters while continuations retain exact byte positions. A page
      // reads at most four bytes per requested character and never splits valid UTF-8.
      let end = 0;
      for (let characters = 0; characters < (a.limit ?? 8000) && end < bytesRead; characters++) {
        const first = buffer[end]!;
        let width = first >= 0xf0 && first <= 0xf4 ? 4 : first >= 0xe0 ? 3 : first >= 0xc2 ? 2 : 1;
        if (end + width > bytesRead) {
          if (at + bytesRead < size) break;
          width = bytesRead - end;
        }
        for (let index = 1; index < width; index++)
          if ((buffer[end + index]! & 0xc0) !== 0x80) {
            width = 1;
            break;
          }
        end += width;
      }
      return {
        outcome: "completed",
        ...details,
        completeness,
        logError: run.logError ?? null,
        text: buffer.subarray(0, end).toString("utf8"),
        offset: at,
        total: size,
        unit: "bytes",
        shortened: at + end < size,
        ...(at + end < size ? { next: cursor({ key, at: at + end }) } : {}),
      };
    } finally {
      await file.close();
    }
  } catch {
    return readText(run.output, a, [task.id, a.nodeId, a.index], {
      ...details,
      completeness: "missing-file",
      message: "The original diagnostic file could not be verified or is unavailable. This is the saved excerpt.",
    });
  }
}
