import { checkEntryCommandOutcome, matchesCheckLogIdentity, unreportedCheckExit as outcomeUnreported, checkCommandOutcome as outcomeOf } from "@petrina/core";
// Verify and page the diagnostic file belonging to one recorded check.
import type { CheckRun, Task } from "@petrina/core";
import { constants, lstatSync } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Result } from "./coordination.js";
import { cursor, position, readText } from "./evidence-read.js";
import { fingerprint } from "@petrina/storage/receipt-identity";
import { checkLogBeginning } from "./checks.js";

export const SAVED_RESULT_PREVIEW = 1000;
// Saved-result offsets stay in string units; move preview boundaries off a surrogate pair.
const bisectsCharacter = (text: string, at: number) => (text.codePointAt(at - 1) ?? 0) > 0xffff;

export const unreportedCheckExit = (run: CheckRun): boolean => outcomeUnreported(run);
export const checkCommandOutcome = (run?: CheckRun) => outcomeOf(run);

/** The same file facts used by diagnostic continuations, without loading process output. */
export function checkLogRevision(dataDir: string, taskId: string, paths: readonly (string | undefined)[]) {
  return [...new Set(paths.filter((path): path is string => !!path && resolve(path).startsWith(resolve(dataDir, "checks", taskId) + sep)))].map((path) => {
    try {
      const file = lstatSync(path, { bigint: true });
      return [path, file.dev.toString(), file.ino.toString(), file.size.toString(), file.mtimeNs.toString(), file.nlink.toString()];
    } catch { return [path, "unavailable"]; }
  });
}

export type CheckLogSubject = Pick<Task, "id" | "checks" | "checkSetup" | "journey" | "repositories"> & Partial<Pick<Task, "productId">>;

export async function readCheckLog(dataDir: string, task: CheckLogSubject, args: {
  nodeId?: string;
  productId?: string;
  setupAttemptId?: string;
  index: number;
  section?: string;
  cursor?: string;
  limit?: number;
  ifRevision?: string;
  preview?: "ends"
}): Promise<Result> {
  const node = args.nodeId ? task.journey?.find((node) => node.id === args.nodeId) : undefined;
  if (args.nodeId && !node) return { outcome: "missing", message: "That journey node does not exist." };
  const work = args.productId ? (task.repositories ?? [task]).find((work) => work.productId === args.productId) : task;
  if (args.productId && !work) return { outcome: "missing", message: "That product has no repository record on this task." };
  const setupScope = args.setupAttemptId === undefined ? [] : [args.setupAttemptId];
  const setups = args.setupAttemptId === undefined ? undefined : args.nodeId
    ? (node?.checkSetups ?? []).filter(attempt => attempt.id === args.setupAttemptId && (!args.productId || attempt.productId === args.productId))
    : work?.checkSetup?.id === args.setupAttemptId ? [work.checkSetup] : [];
  if (setups && setups.length !== 1) return {
    outcome: "missing",
    message: "That exact local setup attempt is not recorded here. No newer attempt is substituted."
  };
  const setup = setups?.[0];
  const setupResult = Array.isArray(setup?.results) ? setup.results[args.index] : undefined;
  if (setupResult && setupResult.requirementId !== setup?.requirements?.[args.index]?.id)
    return { outcome: "unavailable", message: "The recorded setup result does not match its requirement manifest." };
  const entry = args.setupAttemptId === undefined && args.nodeId ? node?.productChecks?.[args.index] : undefined;
  const run = setup ? setupResult?.run : args.setupAttemptId !== undefined ? undefined : args.nodeId ? entry?.run : work?.checks?.results[args.index];
  if (args.ifRevision && (!run || fingerprint(run) !== args.ifRevision)) return {
    outcome: "changed",
    message: "That saved check changed. Inspect the checkpoint again. No newer run is substituted."
  };
  const metadata = {
    commandOutcome: entry ? checkEntryCommandOutcome(entry) : checkCommandOutcome(run),
    reportedOk: run?.ok ?? null,
    relevance: args.nodeId ? "historical" : setup ? setup.input.sha || setup.input.tree ? "recorded-version-only" : "unverified" : work?.checks?.sha || work?.checks?.tree ? "recorded-version-only" : "unverified",
    command: run?.command ?? null,
    ...(setup ? { setupAttemptId: setup.id, requirementId: setupResult?.requirementId ?? null } : {}),
    ...(run && unreportedCheckExit(run) ? { exitUnreported: true } : {}),
  };
  if (!run) return { outcome: "unavailable", ...metadata, completeness: "missing", message: "This older evidence has no original diagnostic link." };
  const resultScope = [task.id, args.nodeId, args.productId, args.index, ...setupScope, "saved-result"];
  if (args.section === "result")
    return readText(run.output, args, resultScope, { ...metadata, source: "saved-result", completeness: "excerpt-only", unit: "characters" });
  // Focused reads retain their ordinary first page and cursor. A compact decision splits that
  // same budget between the beginning and ending, where the runner appends its explanations.
  const previewLimit = Math.min(args.limit ?? 8000, SAVED_RESULT_PREVIEW);
  const split = args.preview === "ends" && run.output.length > previewLimit;
  let headLimit = split ? Math.ceil(previewLimit / 2) : previewLimit;
  if (bisectsCharacter(run.output, headLimit)) headLimit--;
  const savedResult = { ...readText(run.output, { limit: headLimit }, resultScope), section: "result" };
  let endingOffset = run.output.length - (previewLimit - headLimit);
  if (bisectsCharacter(run.output, endingOffset)) endingOffset++;
  const savedResultEnding = split ? {
    ...readText(
      run.output,
      {
      limit: run.output.length - endingOffset,
      cursor: cursor({
      key: fingerprint([
      resultScope,
      run.output
    ]),
      at: endingOffset
    })
    },
      resultScope
    ),
    section: "result", omittedBefore: endingOffset,
  } : undefined;
  const details = { ...metadata, savedResult, ...(savedResultEnding ? { savedResultEnding } : {}) };
  const path = run.logPath && resolve(run.logPath);
  if (!path || !path.startsWith(resolve(dataDir, "checks", task.id) + sep))
    return readText(run.output, args, [task.id, args.nodeId, args.productId, args.index, ...setupScope], {
      ...details,
      completeness: "excerpt-only",
      message: "No complete diagnostic log was recorded. This is the saved excerpt.",
    });
  // Facts are captured only when the log is created, never reconstructed from a current path.
  const { logFileIdentity, logFileLength, logFileBeginning } = run;
  if (!logFileIdentity || logFileLength === undefined || !logFileBeginning)
    return readText(run.output, args, [task.id, args.nodeId, args.productId, args.index, ...setupScope, "unverified-log"], {
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
        || exact.size !== BigInt(logFileLength) || await checkLogBeginning(
          file,
          size
        ) !== logFileBeginning) throw new Error("The diagnostic file is not the file Petrina created for this check.");
      const key = fingerprint([
        task.id,
        args.nodeId,
        args.productId,
        args.index,
        ...setupScope,
        path,
        exact.dev.toString(),
        exact.ino.toString(),
        size,
        modified
      ]);
      const completeness = run.logError || run.logComplete === false ? "incomplete" : run.logComplete ? "complete" : "legacy-unverified";
      if (size === 0 && run.output)
        return readText(run.output, args, [resultScope, path, exact.dev.toString(), exact.ino.toString(), modified], {
          ...details, completeness, logError: run.logError ?? null, source: "saved-result", unit: "characters",
          message: "The process log is empty. This is the saved result, including any failure to start.",
        });
      if (args.preview === "ends" && !args.cursor) {
        const limit = args.limit ?? 8000;
        const buffer = Buffer.alloc(Math.min(size, limit * 4));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        let start = 0;
        while (start < bytesRead && (buffer[start]! & 0xc0) === 0x80) start++;
        const text = Array.from(buffer.subarray(start, bytesRead).toString("utf8")).slice(-limit).join("");
        const offset = size - Buffer.byteLength(text);
        return { outcome: "completed", ...details, completeness, logError: run.logError ?? null,
          text, offset, total: size, unit: "bytes", shortened: false, omittedBefore: offset, source: "process-log" };
      }
      const at = position(args.cursor, key);
      if (at === undefined) return { outcome: "changed", message: "The diagnostic changed. Read it again from the beginning." };
      const buffer = Buffer.alloc((args.limit ?? 8000) * 4),
        { bytesRead } = await file.read(buffer, 0, buffer.length, at);
      // Limit text by characters while continuations retain exact byte positions. A page
      // reads at most four bytes per requested character and never splits valid UTF-8.
      let end = 0;
      for (let characters = 0; characters < (args.limit ?? 8000) && end < bytesRead; characters++) {
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
    return readText(run.output, args, [task.id, args.nodeId, args.productId, args.index, ...setupScope], {
      ...details,
      completeness: "missing-file",
      message: "The original diagnostic file could not be verified or is unavailable. This is the saved excerpt.",
    });
  }
}
