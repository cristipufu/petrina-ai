import { createHash } from "node:crypto";
import { builtinModules } from "node:module";
import { dirname, posix } from "node:path";
import { sourceFacts } from "./source.js";

export const WORKSPACES = ["packages/core", "packages/engine", "apps/desktop"] as const;
export const isTest = (file: string): boolean => /(?:^|\/)(?:[^/]+[._])?(?:test|spec)\.[cm]?[jt]sx?$/.test(file);
export const isSource = (file: string): boolean => /\.[cm]?[jt]sx?$/.test(file);
export const workspaceOf = (file: string): string | undefined => WORKSPACES.find(workspace => file.startsWith(`${workspace}/`));
const aliases = new Map([["@petrina/core", "packages/core/src/index.ts"], ["@petrina/engine", "packages/engine/src/index.ts"]]);
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
export interface CoverageMap { version: 1; fingerprint: string; tests: Record<string, string[]> }
export interface ImpactPlan {
  mode: "observation";
  fingerprint: string;
  changed: string[];
  selected: string[];
  total: number;
  reasons: string[];
  coverage: "absent" | "current" | "stale";
}

/** The complete current input set, not timestamps or a previously inferred dependency cache. */
export function fingerprint(files: ReadonlyMap<string, string>): string {
  const hash = createHash("sha256").update(JSON.stringify({ schema: 1, bun: Bun.version, platform: process.platform, arch: process.arch, ci: process.env.CI ?? "", browser: process.env.PETRINA_BROWSER_CHECK ?? "" }));
  for (const [path, body] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) hash.update(JSON.stringify([path, body]));
  return hash.digest("hex");
}

export function impactPlan(files: ReadonlyMap<string, string>, changes: readonly string[], coverage?: CoverageMap): ImpactPlan {
  const tests = [...files.keys()].filter(isTest).sort();
  const changed = [...new Set(changes)].sort();
  const digest = fingerprint(files);
  const selected = new Set<string>();
  const reasons = new Set<string>();
  const reverse = new Map<string, Set<string>>();
  const uncertain = new Set<string>();
  const declared = new Map(WORKSPACES.map(workspace => {
    try {
      const manifest = JSON.parse(files.get(`${workspace}/package.json`) ?? "{}");
      return [workspace as string, new Set([...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})])];
    } catch { return [workspace as string, new Set<string>()]; }
  }));
  const full = (reason: string, workspace?: string) => {
    reasons.add(reason);
    for (const test of tests) if (!workspace || workspaceOf(test) === workspace) selected.add(test);
  };
  const resolve = (from: string, path: string): string | undefined => {
    const target = aliases.get(path) ?? (path.startsWith(".") ? posix.normalize(posix.join(dirname(from), path)) : undefined);
    if (!target) return;
    return [target, target.replace(/\.js$/, ".ts"), target.replace(/\.js$/, ".tsx"), `${target}.ts`, `${target}.tsx`, `${target}/index.ts`].find(file => files.has(file));
  };
  for (const [file, source] of files) {
    if (!isSource(file)) continue;
    try {
      const facts = sourceFacts(source, file);
      if (facts.uncertain) uncertain.add(file);
      for (const entry of facts.imports) {
        const dependency = resolve(file, entry.path);
        if (dependency) {
          const users = reverse.get(dependency) ?? new Set(); users.add(file); reverse.set(dependency, users);
        } else if (entry.path.startsWith(".") || entry.path.startsWith("@petrina/") || (!builtins.has(entry.path) && !entry.path.startsWith("bun:") && !declared.get(workspaceOf(file) ?? "")?.has(entry.path.startsWith("@") ? entry.path.split("/").slice(0, 2).join("/") : entry.path.split("/")[0]!))) {
          uncertain.add(file);
        }
      }
    } catch { uncertain.add(file); }
  }
  function dependents(file: string): Set<string> {
    const seen = new Set<string>(), todo = [file];
    while (todo.length) {
      const next = todo.pop()!;
      if (seen.has(next)) continue;
      seen.add(next); todo.push(...(reverse.get(next) ?? []));
    }
    return seen;
  }
  for (const file of changed) {
    const workspace = workspaceOf(file);
    // Fixtures and runtime entrypoints contain child-process and file-loading edges beyond ESM imports.
    if (!files.has(file) || !workspace || !isSource(file) || file.includes("/test/") && !isTest(file) || /(?:^|\/)(?:cli|harness|browser-server)\.[jt]s$/.test(file) || /(?:^|\/)(?:vite|vitest)\.config\./.test(file)) {
      full(`Full suite: changed, deleted or unmapped shared input ${file}`); continue;
    }
    const affected = [...dependents(file)].filter(isTest);
    if (!affected.length) full(`Full suite: no established test dependency for ${file}`);
    else affected.forEach(test => selected.add(test));
  }
  if (changed.length) for (const file of uncertain) {
    const affected = [...dependents(file)].filter(isTest);
    if (affected.length) {
      reasons.add(`Conservative consumers of unresolved imports: ${file}`);
      affected.forEach(test => selected.add(test));
    }
  }
  const coverageState = !coverage ? "absent" : coverage.version === 1 && coverage.fingerprint === digest ? "current" : "stale";
  if (coverageState === "stale") full("Full suite: coverage input fingerprint is stale");
  if (coverageState === "current") for (const [test, paths] of Object.entries(coverage!.tests)) {
    if (!tests.includes(test)) { full(`Full suite: unknown coverage test ${test}`); continue; }
    if (paths.some(path => changed.includes(path))) selected.add(test);
  }
  return { mode: "observation", fingerprint: digest, changed, selected: [...selected].sort(), total: tests.length, reasons: [...reasons].sort(), coverage: coverageState };
}
