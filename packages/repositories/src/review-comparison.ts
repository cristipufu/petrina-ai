import { basename } from "node:path";
import { completeAll } from "@petrina/core";
import { hasNoLooseLockfileChangesInRange, haveIdenticalLooseRange, run, tryFastPlainReviewComparison } from "./git.js";
import { parseDiffPacket } from "./diff-format.js";

const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
export const EXCLUDE_LOCKS = LOCKFILES.map(name => `:(glob,exclude)**/${name}`);
export const ONLY_LOCKS = LOCKFILES.map(name => `:(glob)**/${name}`);

export function hasNoPortLockfileChanges(path: string, from: string, portHead: string, onto: string, currentHead: string): boolean {
  return hasNoLooseLockfileChangesInRange(path, from, portHead, LOCKFILES) &&
    hasNoLooseLockfileChangesInRange(path, onto, currentHead, LOCKFILES);
}

async function output(path: string, args: string[]): Promise<string> {
  const result = await run(["git", ...args], path, undefined, { timeoutMs: 30_000, rawOutput: true });
  if (result.code !== 0) throw new Error(`Could not prepare the review comparison: ${result.stderr || "Git did not finish"}`);
  return result.stdout;
}

/** One comparison observation; lockfile changes retain Git's separate path selection and rename semantics. */
export async function readReviewComparison(path: string, range: string, files?: readonly string[]): Promise<{ stat: string; patch: string; locks: string }> {
  if (files?.length === 0 || haveIdenticalLooseRange(path, range, files)) return { stat: "", patch: "", locks: "" };
  const fast = tryFastPlainReviewComparison(path, range, files, LOCKFILES);
  if (fast) return fast;
  const selected = files?.map(file => `:(literal)${file}`) ?? ["."];
  const options = ["diff", "--no-ext-diff", "--no-textconv", "--no-color"];
  const packet = parseDiffPacket(await output(path, [...options, "--numstat", "-z", "--stat", "--patch", range, "--", ...selected]));
  if (!packet.paths.some(file => LOCKFILES.includes(basename(file)))) return { stat: packet.stat, patch: packet.patch, locks: "" };
  const lockPaths = files ? files.filter(file => LOCKFILES.includes(basename(file))).map(file => `:(literal)${file}`) : ONLY_LOCKS;
  const [patch, locks] = await completeAll([
    output(path, [...options, range, "--", ...selected, ...EXCLUDE_LOCKS]),
    lockPaths.length ? output(path, [...options, range, "--", ...lockPaths]) : Promise.resolve(""),
  ]);
  return { stat: packet.stat, patch: patch!, locks: locks! };
}
