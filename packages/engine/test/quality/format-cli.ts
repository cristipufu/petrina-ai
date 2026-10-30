import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  FROZEN_PRODUCTION_LINE_CEILINGS,
  formatProductionSource,
  productionFormattingViolations,
} from "./format.js";
import { isTest, WORKSPACES } from "./test-paths.js";

const ROOT = resolve(import.meta.dir, "../../../..");

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries.sort()) {
    if (entry === "node_modules" || entry === "dist" || entry === "target") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (/\.(?:ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function productionFiles(root: string): string[] {
  const files: string[] = [];
  for (const workspace of WORKSPACES) {
    for (const full of walkSourceFiles(join(root, workspace, "src"))) {
      const rel = relative(root, full).replaceAll("\\", "/");
      if (isTest(rel) || rel in FROZEN_PRODUCTION_LINE_CEILINGS) continue;
      files.push(rel);
    }
  }
  return files.sort();
}

const mode = process.argv[2] ?? "--check";
if (mode !== "--write" && mode !== "--check") {
  console.error("Usage: bun packages/engine/test/quality/format-cli.ts [--write | --check]");
  process.exit(1);
}

const files = productionFiles(ROOT);
if (mode === "--write") {
  let updated = 0;
  for (const rel of files) {
    const full = join(ROOT, rel);
    const original = readFileSync(full, "utf8");
    const formatted = formatProductionSource(original, rel);
    if (formatted !== original) {
      writeFileSync(full, formatted, "utf8");
      updated++;
    }
  }
  console.log(`Formatted ${updated} production file(s) across ${files.length} checked source files.`);
} else {
  const errors: string[] = [];
  for (const rel of files) {
    const source = readFileSync(join(ROOT, rel), "utf8");
    for (const violation of productionFormattingViolations(source, rel)) {
      errors.push(`${rel}:${violation.line}: ${violation.reason}`);
    }
  }
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else {
    console.log(`Production formatting check passed (${files.length} files).`);
  }
}
