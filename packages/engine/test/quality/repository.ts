import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { runGit } from "@petrina/test-support/commands";
import { isSource, impactPlan, type CoverageMap, type ImpactPlan } from "./impact.js";
import { conventions as sourceConventions } from "./conventions.js";
import { layerStructure, TEST_LAYER_INVENTORY } from "./layers.js";

export const ROOT = resolve(import.meta.dir, "../../../..");
export async function readGit(root: string, args: string[]): Promise<string> {
  let result;
  try { result = await runGit(args, { cwd: root, timeoutMs: 30_000 }); }
  catch (error) { throw new Error(`Could not inspect test inputs: ${error instanceof Error ? error.message : String(error)}`); }
  if (result.code !== 0) throw new Error(`Could not inspect test inputs: git ${args[0]} failed (${result.stderr.trim()})`);
  return result.stdout;
}

export async function inputs(root: string): Promise<Map<string, string>> {
  const files = new Set((await readGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0").filter(Boolean));
  const result = new Map<string, string>();
  for (const file of [...files].sort()) {
    try {
      const body = readFileSync(join(root, file));
      result.set(file, isSource(file) || file.endsWith("package.json") || file === TEST_LAYER_INVENTORY ? body.toString("utf8") : createHash("sha256").update(body).digest("hex"));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return result;
}

/** The repository scan also requires every not-yet-migrated file to remain in the audit inventory. */
export function conventions(files: ReadonlyMap<string, string>): string[] {
  return [...sourceConventions(files), ...layerStructure(files)].sort();
}

export async function observe(root: string, base = "origin/main", coverage?: CoverageMap): Promise<ImpactPlan & { base: string; head: string }> {
  const files = await inputs(root);
  const head = (await readGit(root, ["rev-parse", "HEAD"])).trim();
  const resolved = (await readGit(root, ["rev-parse", "--verify", `${base}^{commit}`])).trim();
  const changes = [
    ...(await readGit(root, ["diff", "--name-only", "-z", "--no-renames", resolved, "--"])).split("\0"),
    ...(await readGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"),
  ].filter(Boolean);
  return { ...impactPlan(files, changes, coverage), base: resolved, head };
}

export function recordedCoverage(root: string): CoverageMap | undefined {
  let body: unknown;
  try { body = JSON.parse(readFileSync(join(root, ".test-results", "coverage-map.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const record = body as CoverageMap;
  if (!record || record.version !== 1 || typeof record.fingerprint !== "string" || !record.tests || typeof record.tests !== "object"
    || Object.values(record.tests).some(paths => !Array.isArray(paths) || paths.some(path => typeof path !== "string"))) throw new Error("Recorded coverage is not a recognised input map; use the full suite");
  return record;
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "conventions") {
    const errors = conventions(await inputs(ROOT));
    if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
    else console.log("Test fixture and assertion conventions passed");
  } else if (command === "impact") {
    console.log(JSON.stringify(await observe(ROOT, process.argv[3], recordedCoverage(ROOT)), null, 2));
  } else throw new Error("Use conventions or impact [base-ref]");
}
