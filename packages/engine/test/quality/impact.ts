import { createHash } from "node:crypto";
import { sourceCandidates } from "./source-paths.js";
import { sourceFacts } from "./source.js";
import { isSource, isTest, WORKSPACES, workspaceOf } from "./test-paths.js";

export { isSource, isTest, WORKSPACES, workspaceOf } from "./test-paths.js";

export interface ImpactIdentity {
  bun: string;
  platform: string;
  arch: string;
  ci: string;
  browser: string;
}

export interface ImpactRuntime {
  identity: ImpactIdentity;
  builtinModules: readonly string[];
}

export interface CoverageMap {
  version: 1;
  fingerprint: string;
  tests: Record<string, string[]>;
}

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
export function fingerprint(files: ReadonlyMap<string, string>, identity: ImpactIdentity): string {
  const hash = createHash("sha256").update(
    JSON.stringify({
      schema: 1,
      bun: identity.bun,
      platform: identity.platform,
      arch: identity.arch,
      ci: identity.ci,
      browser: identity.browser,
    }),
  );
  const ordered = [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, body] of ordered) hash.update(JSON.stringify([path, body]));
  return hash.digest("hex");
}

function packageNameOf(specifier: string): string {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
}

export function impactPlan(
  files: ReadonlyMap<string, string>,
  changes: readonly string[],
  runtime: ImpactRuntime,
  coverage?: CoverageMap,
): ImpactPlan {
  const tests = [...files.keys()].filter(isTest).sort();
  const changed = [...new Set(changes)].sort();
  const digest = fingerprint(files, runtime.identity);
  const builtins = new Set(runtime.builtinModules.flatMap((name) => [name, `node:${name}`]));
  const selected = new Set<string>();
  const reasons = new Set<string>();
  const reverse = new Map<string, Set<string>>();
  const uncertain = new Set<string>();

  const declared = new Map(
    WORKSPACES.map((workspace) => {
      try {
        const manifest = JSON.parse(files.get(`${workspace}/package.json`) ?? "{}");
        const deps = new Set([
          ...Object.keys(manifest.dependencies ?? {}),
          ...Object.keys(manifest.devDependencies ?? {}),
        ]);
        return [workspace as string, deps];
      } catch {
        return [workspace as string, new Set<string>()];
      }
    }),
  );

  const full = (reason: string, workspace?: string) => {
    reasons.add(reason);
    for (const test of tests) if (!workspace || workspaceOf(test) === workspace) selected.add(test);
  };

  for (const [file, source] of files) {
    if (!isSource(file)) continue;
    try {
      const facts = sourceFacts(source, file);
      if (facts.uncertain) uncertain.add(file);
      for (const entry of facts.imports) {
        const dependency = sourceCandidates(file, entry.path).find((candidate) => files.has(candidate));
        if (dependency) {
          const users = reverse.get(dependency) ?? new Set();
          users.add(file);
          reverse.set(dependency, users);
        } else {
          const isExternalDeclared =
            builtins.has(entry.path)
            || entry.path.startsWith("bun:")
            || Boolean(declared.get(workspaceOf(file) ?? "")?.has(packageNameOf(entry.path)));
          if (entry.path.startsWith(".") || entry.path.startsWith("@petrina/") || !isExternalDeclared) {
            uncertain.add(file);
          }
        }
      }
    } catch {
      uncertain.add(file);
    }
  }

  function dependents(file: string): Set<string> {
    const seen = new Set<string>();
    const todo = [file];
    while (todo.length) {
      const next = todo.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      todo.push(...(reverse.get(next) ?? []));
    }
    return seen;
  }

  for (const file of changed) {
    const workspace = workspaceOf(file);
    // Fixtures and runtime entrypoints contain child-process and file-loading edges beyond ESM imports.
    const isUnmappedInput =
      !files.has(file)
      || !workspace
      || !isSource(file)
      || (file.includes("/test/") && !isTest(file))
      || /(?:^|\/)(?:cli|harness|browser-server)\.[jt]s$/.test(file)
      || /(?:^|\/)(?:vite|vitest)\.config\./.test(file);
    if (isUnmappedInput) {
      full(`Full suite: changed, deleted or unmapped shared input ${file}`);
      continue;
    }
    const affected = [...dependents(file)].filter(isTest);
    if (!affected.length) full(`Full suite: no established test dependency for ${file}`);
    else affected.forEach((test) => selected.add(test));
  }

  if (changed.length) {
    for (const file of uncertain) {
      const affected = [...dependents(file)].filter(isTest);
      if (affected.length) {
        reasons.add(`Conservative consumers of unresolved imports: ${file}`);
        affected.forEach((test) => selected.add(test));
      }
    }
  }

  const coverageState = !coverage
    ? "absent"
    : coverage.version === 1 && coverage.fingerprint === digest
      ? "current"
      : "stale";
  if (coverageState === "stale") full("Full suite: coverage input fingerprint is stale");
  if (coverageState === "current") {
    for (const [test, paths] of Object.entries(coverage!.tests)) {
      if (!tests.includes(test)) {
        full(`Full suite: unknown coverage test ${test}`);
        continue;
      }
      if (paths.some((path) => changed.includes(path))) selected.add(test);
    }
  }

  return {
    mode: "observation",
    fingerprint: digest,
    changed,
    selected: [...selected].sort(),
    total: tests.length,
    reasons: [...reasons].sort(),
    coverage: coverageState,
  };
}
