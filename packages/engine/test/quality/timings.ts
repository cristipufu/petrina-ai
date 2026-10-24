import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { writeFixtureJson } from "@petrina/test-support/fixture-json";
import { testTimingHints } from "@petrina/test-support/test-timings";

export type TimingHintUse = { kind: "used"; files: number; artifact: string; sha256: string }
  | { kind: "absent" } | { kind: "unusable"; reason: string };
export type TimingHintUpdate = { kind: "saved"; files: number } | { kind: "unavailable"; reason: string };
const cache = (root: string, workspace: string) => join(root, ".test-results", "timings", `${workspace.split("/").at(-1)}.json`);
const localFiles = (workspace: string, expected: readonly string[]) => expected.filter(file => file.startsWith(`${workspace}/`)).map(file => file.slice(workspace.length + 1));
const reason = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Keep the exact seed alongside the measured output, so a later diagnosis can reproduce ordering. */
export function seedTestTimings(root: string, workspace: string, output: string, expected: readonly string[]): TimingHintUse {
  let body: string;
  try { body = readFileSync(cache(root, workspace), "utf8"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "absent" } : { kind: "unusable", reason: reason(error) }; }
  const hints = testTimingHints(body, localFiles(workspace, expected));
  if (!hints) return { kind: "unusable", reason: "No valid durations for current test files" };
  try {
    const used = join(dirname(output), `${workspace.split("/").at(-1)}-timings-used.json`);
    writeFixtureJson(used, hints, 2);
    writeFixtureJson(output, hints, 2);
    return { kind: "used", files: Object.keys(hints.files).length, artifact: relative(root, used).replaceAll("\\", "/"), sha256: createHash("sha256").update(JSON.stringify(hints, null, 2)).digest("hex") };
  } catch (error) { return { kind: "unusable", reason: reason(error) }; }
}

/** Called only after the complete required run passed on stable inputs; hints remain optional. */
export function keepTestTimings(root: string, workspace: string, measured: string, expected: readonly string[]): TimingHintUpdate {
  try {
    const hints = testTimingHints(readFileSync(measured, "utf8"), localFiles(workspace, expected));
    if (!hints) return { kind: "unavailable", reason: "No valid measured durations for current test files" };
    const file = cache(root, workspace);
    mkdirSync(dirname(file), { recursive: true });
    writeFixtureJson(file, hints, 2);
    return { kind: "saved", files: Object.keys(hints.files).length };
  } catch (error) { return { kind: "unavailable", reason: reason(error) }; }
}
