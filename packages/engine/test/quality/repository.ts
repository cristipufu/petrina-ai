import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runGit } from "@petrina/test-support/commands";
import { conventions as sourceConventions } from "./conventions.js";
import { docContracts } from "./docs.js";
import { impactRuntime } from "./impact-runtime.js";
import { impactPlan, isSource, type CoverageMap, type ImpactPlan } from "./impact.js";
import { layerStructure, TEST_LAYER_INVENTORY } from "./layers.js";

export const ROOT = resolve(import.meta.dir, "../../../..");

export async function readGit(root: string, args: string[]): Promise<string> {
  let result;
  try {
    result = await runGit(args, { cwd: root, timeoutMs: 30_000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not inspect test inputs: ${detail}`);
  }
  if (result.code !== 0) {
    throw new Error(`Could not inspect test inputs: git ${args[0]} failed (${result.stderr.trim()})`);
  }
  return result.stdout;
}

export async function inputs(root: string): Promise<Map<string, string>> {
  const rawList = await readGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const files = new Set(rawList.split("\0").filter(Boolean));
  const result = new Map<string, string>();
  for (const file of [...files].sort()) {
    try {
      const body = readFileSync(join(root, file));
      const keepText =
        isSource(file)
        || file.endsWith(".css")
        || file.endsWith(".rs")
        || file.endsWith("package.json")
        || file === TEST_LAYER_INVENTORY
        || (file.startsWith("docs/") && file.endsWith(".md"))
        || (!file.includes("/") && file.endsWith(".md"));
      result.set(file, keepText ? body.toString("utf8") : createHash("sha256").update(body).digest("hex"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return result;
}

/** The repository scan also requires every not-yet-migrated file to remain in the audit inventory. */
export function conventions(files: ReadonlyMap<string, string>): string[] {
  return [...sourceConventions(files), ...layerStructure(files), ...docContracts(files)].sort();
}

export async function observe(
  root: string,
  base = "origin/main",
  coverage?: CoverageMap,
): Promise<ImpactPlan & { base: string; head: string }> {
  const files = await inputs(root);
  const head = (await readGit(root, ["rev-parse", "HEAD"])).trim();
  const resolved = (await readGit(root, ["rev-parse", "--verify", `${base}^{commit}`])).trim();
  const changes = [
    ...(await readGit(root, ["diff", "--name-only", "-z", "--no-renames", resolved, "--"])).split("\0"),
    ...(await readGit(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"),
  ].filter(Boolean);
  return { ...impactPlan(files, changes, impactRuntime(), coverage), base: resolved, head };
}

export function recordedCoverage(root: string): CoverageMap | undefined {
  let body: unknown;
  try {
    body = JSON.parse(readFileSync(join(root, ".test-results", "coverage-map.json"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const record = body as CoverageMap;
  const invalidTests =
    !record
    || record.version !== 1
    || typeof record.fingerprint !== "string"
    || !record.tests
    || typeof record.tests !== "object"
    || Object.values(record.tests).some(
      (paths) => !Array.isArray(paths) || paths.some((path) => typeof path !== "string"),
    );
  if (invalidTests) {
    throw new Error("Recorded coverage is not a recognised input map; use the full suite");
  }
  return record;
}

if (import.meta.main) {
  const command = process.argv[2];
  if (command === "conventions") {
    const errors = conventions(await inputs(ROOT));
    if (errors.length) {
      console.error(errors.join("\n"));
      process.exitCode = 1;
    } else {
      console.log("Test fixture and assertion conventions passed");
    }
  } else if (command === "impact") {
    console.log(JSON.stringify(await observe(ROOT, process.argv[3], recordedCoverage(ROOT)), null, 2));
  } else {
    throw new Error("Use conventions or impact [base-ref]");
  }
}
