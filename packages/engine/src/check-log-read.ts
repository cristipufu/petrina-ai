import { unreportedCheckExit as outcomeUnreported, checkCommandOutcome as outcomeOf } from "@petrina/core";
// Verify and page the diagnostic file belonging to one recorded check.
import type { CheckRun, Task } from "@petrina/core";
import { constants, lstatSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Result } from "./coordination.js";
import { cursor, fingerprint, position, readText } from "./evidence-read.js";
import { checkLogBeginning } from "./checks.js";
import { CLEANUP_INCOMPLETE } from "@petrina/platform/process-tree";

export function matchesCheckLogIdentity(expected: { device: string; inode: string }, actual: { dev: bigint; ino: bigint }): boolean {
  return expected.device === actual.dev.toString() && expected.inode === actual.ino.toString();
}
export const SAVED_RESULT_PREVIEW = 1000;
// Saved-result offsets stay in string units; move preview boundaries off a surrogate pair.
const bisectsCharacter = (text: string, at: number) => (text.codePointAt(at - 1) ?? 0) > 0xffff;

export const unreportedCheckExit = (run: CheckRun): boolean => outcomeUnreported(run, CLEANUP_INCOMPLETE);
export const checkCommandOutcome = (run?: CheckRun) => outcomeOf(run, CLEANUP_INCOMPLETE);

/** The same file facts used by diagnostic continuations, without loading process output. */
export function checkLogRevision(dataDir: string, taskId: string, paths: readonly (string | undefined)[]) {
  return [...new Set(paths.filter((path): path is string => !!path && resolve(path).startsWith(resolve(dataDir, "checks", taskId) + sep)))].map((path) => {
    try {
      const file = lstatSync(path, { bigint: true });
      return [path, file.dev.toString(), file.ino.toString(), file.size.toString(), file.mtimeNs.toString(), file.nlink.toString()];
    } catch { return [path, "unavailable"]; }
  });
}

export async function readCheckLog(dataDir: string, task: Task, a: { nodeId?: string; productId?: string; index: number; section?: string; cursor?: string; limit?: number; ifRevision?: string; preview?: "ends" }): Promise<Result> {
  const node = a.nodeId ? task.journey?.find((node) => node.id === a.nodeId) : undefined;
  if (a.nodeId && !node) return { outcome: "missing", message: "That journey node does not exist." };
  const work = a.productId ? (task.repositories ?? [task]).find((work) => work.productId === a.productId) : task;
  if (a.productId && !work) return { outcome: "missing", message: "That product has no repository record on this task." };
  const run = a.nodeId ? node?.productChecks?.[a.index]?.run : work?.checks?.results[a.index];
  if (a.ifRevision && (!run || fingerprint(run) !== a.ifRevision)) return { outcome: "changed", message: "That saved check changed. Inspect the checkpoint again. No newer run is substituted." };
  const metadata = {
    commandOutcome: checkCommandOutcome(run),
    relevance: a.nodeId ? "historical" : work?.checks?.sha || work?.checks?.tree ? "recorded-version-only" : "unverified",
    command: run?.command ?? null,
    ...(run && unreportedCheckExit(run) ? { exitUnreported: true } : {}),
  };
  if (!run) return { outcome: "unavailable", ...metadata, completeness: "missing", message: "This older evidence has no original diagnostic link." };
  const resultScope = [task.id, a.nodeId, a.productId, a.index, "saved-result"];
  if (a.section === "result")
    return readText(run.output, a, resultScope, { ...metadata, source: "saved-result", completeness: "excerpt-only", unit: "characters" });
  // Focused reads retain their ordinary first page and cursor. A compact decision splits that
  // same budget between the beginning and ending, where the runner appends its explanations.
  const previewLimit = Math.min(a.limit ?? 8000, SAVED_RESULT_PREVIEW);
  const split = a.preview === "ends" && run.output.length > previewLimit;
  let headLimit = split ? Math.ceil(previewLimit / 2) : previewLimit;
  if (bisectsCharacter(run.output, headLimit)) headLimit--;
  const savedResult = { ...readText(run.output, { limit: headLimit }, resultScope), section: "result" };
  let endingOffset = run.output.length - (previewLimit - headLimit);
  if (bisectsCharacter(run.output, endingOffset)) endingOffset++;
  const savedResultEnding = split ? {
    ...readText(run.output, { limit: run.output.length - endingOffset, cursor: cursor({ key: fingerprint([resultScope, run.output]), at: endingOffset }) }, resultScope),
    section: "result", omittedBefore: endingOffset,
  } : undefined;
  const details = { ...metadata, savedResult, ...(savedResultEnding ? { savedResultEnding } : {}) };
  const path = run.logPath && resolve(run.logPath);
  if (!path || !path.startsWith(resolve(dataDir, "checks", task.id) + sep))
    return readText(run.output, a, [task.id, a.nodeId, a.productId, a.index], {
      ...details,
      completeness: "excerpt-only",
      message: "No complete diagnostic log was recorded. This is the saved excerpt.",
    });
  // Facts are captured only when the log is created, never reconstructed from a current path.
  const { logFileIdentity, logFileLength, logFileBeginning } = run;
  if (!logFileIdentity || logFileLength === undefined || !logFileBeginning)
    return readText(run.output, a, [task.id, a.nodeId, a.productId, a.index, "unverified-log"], {
      ...details,
      completeness: run.logError || run.logComplete === false ? "incomplete" : "legacy-unverified",
      message: logFileIdentity
        ? "This saved run has no record of the length and beginning of the file Petrina created. This is the saved excerpt."
        : "This saved run has no record of which file Petrina created. This is the saved excerpt.",
    });
  try {
    const [entry, root, canonical] = await Promise.all([lstat(path, { bigint: true }), realpath(dataDir), realpath(path)]);
    const directory = resolve(root, "checks", task.id);
    if (!entry.isFile() || entry.nlink !== 1n || !canonical.startsWith(directory + sep)) throw new Error("The diagnostic is not an unshared regular file in this task's check folder.");
    // Do not follow a substituted link. Use the opened file's identity and size for both
    // pagination and reading; a replaced file invalidates its previous continuation.
    // A second hard-link name can alias a private file, so both observations require one link.
    // The saved file identity also ties this to the file Petrina created for this check;
    // link counts alone are insufficient after an atomic replacement removes the other name.
    // A removed log's number can be reused by a later file, so the opened file must also have
    // the recorded length and beginning. That recognises the file; it does not prove later bytes.
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const exact = await file.stat({ bigint: true });
      const size = Number(exact.size);
      const modified = exact.mtimeNs.toString();
      if (!exact.isFile() || exact.nlink !== 1n || exact.dev !== entry.dev || exact.ino !== entry.ino || !matchesCheckLogIdentity(logFileIdentity, exact)
        || exact.size !== BigInt(logFileLength) || await checkLogBeginning(file, size) !== logFileBeginning) throw new Error("The diagnostic file is not the file Petrina created for this check.");
      const key = fingerprint([task.id, a.nodeId, a.productId, a.index, path, exact.dev.toString(), exact.ino.toString(), size, modified]);
      const completeness = run.logError || run.logComplete === false ? "incomplete" : run.logComplete ? "complete" : "legacy-unverified";
      if (size === 0 && run.output)
        return readText(run.output, a, [resultScope, path, exact.dev.toString(), exact.ino.toString(), modified], {
          ...details, completeness, logError: run.logError ?? null, source: "saved-result", unit: "characters",
          message: "The process log is empty. This is the saved result, including any failure to start.",
        });
      if (a.preview === "ends" && !a.cursor) {
        const limit = a.limit ?? 8000;
        const buffer = Buffer.alloc(Math.min(size, limit * 4));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        let start = 0;
        while (start < bytesRead && (buffer[start]! & 0xc0) === 0x80) start++;
        const text = Array.from(buffer.subarray(start, bytesRead).toString("utf8")).slice(-limit).join("");
        const offset = size - Buffer.byteLength(text);
        return { outcome: "completed", ...details, completeness, logError: run.logError ?? null,
          text, offset, total: size, unit: "bytes", shortened: false, omittedBefore: offset, source: "process-log" };
      }
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
    return readText(run.output, a, [task.id, a.nodeId, a.productId, a.index], {
      ...details,
      completeness: "missing-file",
      message: "The original diagnostic file could not be verified or is unavailable. This is the saved excerpt.",
    });
  }
}
