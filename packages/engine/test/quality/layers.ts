import { isSource, isTest, workspaceOf } from "./test-paths.js";
import { sourceFacts } from "./source.js";
import { sourceCandidates } from "./source-paths.js";
import { TEST_WORKSPACES } from "./workspaces.js";

export const TEST_LAYERS = ["rules", "orchestration", "presentation", "contracts", "journeys"] as const;
type TestLayer = (typeof TEST_LAYERS)[number];
export const TEST_LAYER_INVENTORY = "docs/plans/test-layer-audit.json";

const EFFECTS =
  /^(?:node:)?(?:fs(?:\/.*)?|child_process|net|http(?:2|s)?|dgram|dns(?:\/.*)?|worker_threads|cluster|process|os)$|^bun(?::sqlite)?$|^(?:@playwright\/|playwright(?:\/|$))/;

const PURE_IMPORTS = new Set([
  "bun:test",
  "vitest",
  "@babel/parser",
  "saxes",
  "zod",
  "path",
  "path/posix",
  "path/win32",
  "url",
  "buffer",
  "crypto",
  "util",
  "util/types",
  "assert",
  "assert/strict",
  "events",
  "async_hooks",
  "string_decoder",
]);

const UI_CSS_ASSETS = new Set(["@xyflow/react/dist/base.css", "@xyflow/react/dist/style.css"]);
const UI_IMPORTS = /^(?:react(?:\/|$)|react-dom(?:\/|$)|lucide-react$|@xyflow\/react$|react-markdown$|remark-gfm$)/;
const NATIVE_GLOBALS = /^(?:Bun|process)(?:$|\.|\[)/;

export function testLayer(file: string): { layer: TestLayer; area: string } | undefined {
  const workspace = workspaceOf(file);
  const parts = workspace && file.slice(workspace.length + 1).split("/");
  if (!parts || parts[0] !== "test" || !TEST_LAYERS.includes(parts[1] as TestLayer) || parts.length < 4 || !parts[2]) {
    return undefined;
  }
  return { layer: parts[1] as TestLayer, area: parts.slice(2, -1).join("/") };
}

/** The explicit migration inventory is not permission to add another unstructured test file. */
export function layerStructure(files: ReadonlyMap<string, string>): string[] {
  const body = files.get(TEST_LAYER_INVENTORY);
  if (!body) {
    return [`${TEST_LAYER_INVENTORY}: missing complete test-layer migration inventory`];
  }
  let pending: Set<string>;
  let recorded: string[];
  try {
    const inventory = JSON.parse(body);
    if (inventory.version !== 1 || !Array.isArray(inventory.files)) {
      throw new Error("Invalid inventory");
    }
    const paths = inventory.files.map((row: { file?: unknown }) => row.file);
    if (paths.some((file: unknown) => typeof file !== "string" || !isTest(file)) || new Set(paths).size !== paths.length) {
      throw new Error("Invalid test identities");
    }
    const hasInvalidStatus = inventory.files.some(
      (row: { status?: unknown; file: string }) =>
        !["pending", "reviewed"].includes(row.status as string) ||
        (row.status === "reviewed" && !testLayer(row.file)),
    );
    if (hasInvalidStatus) {
      throw new Error("Invalid audit status");
    }
    const hasInvalidSplit = inventory.files.some(
      (row: { status: string; file: string; splitFiles?: unknown }) =>
        row.splitFiles !== undefined &&
        (row.status !== "reviewed" ||
          !Array.isArray(row.splitFiles) ||
          !row.splitFiles.includes(row.file) ||
          new Set(row.splitFiles).size !== row.splitFiles.length ||
          row.splitFiles.some((file: unknown) => typeof file !== "string" || !isTest(file) || !testLayer(file))),
    );
    if (hasInvalidSplit) {
      throw new Error("Invalid split ownership");
    }
    pending = new Set(
      inventory.files
        .filter((row: { status: string }) => row.status === "pending")
        .map((row: { file: string }) => row.file),
    );
    recorded = [
      ...new Set<string>(
        inventory.files.flatMap((row: { file: string; splitFiles?: string[] }) => row.splitFiles ?? [row.file]),
      ),
    ];
  } catch {
    return [`${TEST_LAYER_INVENTORY}: invalid test-layer migration inventory`];
  }

  const missing = recorded
    .filter((file) => !files.has(file))
    .map((file) => `${file}: missing inventoried test; audit its replacement before removing it`);
  const unstructured = [...files.keys()]
    .filter(isTest)
    .flatMap((file) =>
      testLayer(file) || pending.has(file)
        ? []
        : [`${file}: place tests in test/<layer>/<area>; split mixed responsibilities instead of adding a flat test file`],
    );
  return [...missing, ...unstructured];
}

/** Follow runtime local imports; a helper or barrel must not smuggle a real boundary into a lower layer. */
export function layerBoundaries(files: ReadonlyMap<string, string>): string[] {
  const roots = [...files.keys()].filter(isTest).flatMap((file) => {
    const classified = testLayer(file);
    return classified && ["rules", "orchestration", "presentation"].includes(classified.layer)
      ? [{ file, label: classified.layer }]
      : [];
  });
  return dependencyBoundaries(files, roots);
}

/** Native test packages own their protocol/process peers; application workflow fixtures stay above them. */
export function childFixtureBoundaries(
  file: string,
  programs: ReturnType<typeof sourceFacts>["childPrograms"],
  files: ReadonlyMap<string, string>,
): string[] {
  const owner = workspaceOf(file);
  if (!owner || owner === "packages/engine" || !file.startsWith(`${owner}/test/`)) {
    return [];
  }
  const errors: string[] = [];
  for (const program of programs) {
    const target = sourceCandidates("repository.ts", `./${program.path}`).find((candidate) => files.has(candidate));
    const other = target && workspaceOf(target);
    if (target && isSource(target) && other && other !== owner && target.startsWith(`${other}/test/`)) {
      errors.push(
        `${file}:${program.line}: child fixture ${target} belongs to ${other}; use an owned protocol peer or public @petrina/test-support`,
      );
    }
  }
  return [...new Set(errors)].sort();
}

/** Enforce production direction across every workspace, including untested files and type-only back references. */
export function packageBoundaries(files: ReadonlyMap<string, string>): string[] {
  const pure = new Set(["packages/core", "packages/orchestrator"]);
  const allowed = new Map<string, readonly string[]>([
    ["packages/core", []],
    ["packages/orchestrator", ["packages/core"]],
    ["packages/storage", ["packages/core"]],
    ["packages/platform", []],
    ["packages/test-support", ["packages/platform"]],
    ["packages/agent-runtime", ["packages/core", "packages/orchestrator", "packages/platform"]],
    ["packages/repositories", ["packages/core", "packages/orchestrator", "packages/platform"]],
    [
      "packages/engine",
      [
        "packages/core",
        "packages/orchestrator",
        "packages/storage",
        "packages/platform",
        "packages/agent-runtime",
        "packages/repositories",
      ],
    ],
    ["apps/desktop", ["packages/core"]],
  ]);

  const roots = [...files.keys()].filter(
    (file) => isSource(file) && [...allowed.keys()].some((workspace) => file.startsWith(`${workspace}/src/`)),
  );
  const errors = dependencyBoundaries(
    files,
    roots.filter((file) => pure.has(workspaceOf(file)!)).map((file) => ({ file, label: "pure package" })),
  );

  const rootSet = new Set(roots);
  const runtimeEdges = new Map<string, string[]>();

  for (const file of roots) {
    const owner = workspaceOf(file)!;
    let parsed;
    try {
      parsed = sourceFacts(files.get(file)!, file);
    } catch {
      continue; // The dependency check retains the parse error.
    }
    if (owner === "apps/desktop") {
      for (const access of parsed.effectAccess) {
        if (NATIVE_GLOBALS.test(access.name)) {
          errors.push(
            `${file}:${access.line}: desktop UI cannot access ${access.name}; keep native runtime capabilities behind Tauri or the local API`,
          );
        }
      }
    }
    const localDeps: string[] = [];
    for (const entry of parsed.imports) {
      if (pure.has(owner) && !entry.runtime && EFFECTS.test(entry.path)) {
        errors.push(`${file}: native ${entry.path} types belong to an adapter; keep the controller contract portable`);
      }
      if (owner === "apps/desktop" && EFFECTS.test(entry.path)) {
        errors.push(
          `${file}: desktop UI cannot depend on native ${entry.path}, including through types; keep host capabilities behind Tauri or the local API`,
        );
      }
      if (
        owner !== "packages/test-support" &&
        (entry.path === "@petrina/test-support" || entry.path.startsWith("@petrina/test-support/"))
      ) {
        errors.push(`${file}: production code cannot depend on test support, including through types`);
      }
      const candidates = sourceCandidates(file, entry.path).filter((candidate) => files.has(candidate));
      if (entry.runtime) {
        const hit = candidates.find((candidate) => rootSet.has(candidate) && workspaceOf(candidate) === owner);
        if (hit) localDeps.push(hit);
      }
      for (const target of candidates) {
        const other = workspaceOf(target);
        if (other === "packages/test-support" && owner !== "packages/test-support") {
          errors.push(`${file}: production code cannot depend on test support, including through types`);
        } else if (other && other !== owner && !allowed.get(owner)!.includes(other)) {
          errors.push(`${file}: ${owner} cannot depend on ${other}, including through types; use an owned contract`);
        }
        if (target.includes("/test/")) {
          errors.push(`${file}: production code cannot import test fixtures`);
        }
      }
    }
    runtimeEdges.set(file, [...new Set(localDeps)]);
  }

  errors.push(...runtimeCycles(runtimeEdges));

  for (const [owner, dependencies] of allowed) {
    const manifest = files.get(`${owner}/package.json`);
    if (!manifest) continue;
    try {
      for (const name of Object.keys(JSON.parse(manifest).dependencies ?? {})) {
        const target = TEST_WORKSPACES.find((workspace) => workspace.name === name);
        if (target && !dependencies.includes(target.path)) {
          errors.push(`${owner}/package.json: dependency ${name} violates the package direction`);
        }
      }
    } catch {
      errors.push(`${owner}/package.json: cannot inspect production dependencies`);
    }
  }

  return [...new Set(errors)].sort();
}

function runtimeCycles(edges: ReadonlyMap<string, readonly string[]>): string[] {
  const errors: string[] = [];
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();

  const visit = (node: string) => {
    indices.set(node, index);
    low.set(node, index);
    index++;
    stack.push(node);
    onStack.add(node);
    for (const next of edges.get(node) ?? []) {
      if (!indices.has(next)) {
        visit(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, indices.get(next)!));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const scc: string[] = [];
      while (true) {
        const member = stack.pop()!;
        onStack.delete(member);
        scc.push(member);
        if (member === node) break;
      }
      if (scc.length > 1 || (edges.get(node) ?? []).includes(node)) {
        const sorted = [...scc].sort();
        errors.push(`${sorted[0]}: intra-package runtime import cycle (${sorted.join(" <-> ")}); extract a shared leaf module`);
      }
    }
  };

  for (const node of [...edges.keys()].sort()) {
    if (!indices.has(node)) visit(node);
  }
  return errors;
}

function dependencyBoundaries(
  files: ReadonlyMap<string, string>,
  roots: readonly { file: string; label: string }[],
): string[] {
  const errors: string[] = [];
  const facts = new Map<string, ReturnType<typeof sourceFacts>>();
  const parseCached = (path: string) => {
    let parsed = facts.get(path);
    if (!parsed) {
      parsed = sourceFacts(files.get(path)!, path);
      facts.set(path, parsed);
    }
    return parsed;
  };

  for (const { file, label } of roots) {
    const replaced = new Set<string>();
    const externalReplacements = new Set<string>();
    if (label === "presentation") {
      try {
        for (const replacement of parseCached(file).fullModuleMocks) {
          const candidates = sourceCandidates(file, replacement.path);
          const target = candidates.find((candidate) => files.has(candidate));
          if (target) replaced.add(target);
          else if (candidates.length) errors.push(`${file}: unresolved full presentation replacement ${replacement.path}`);
          else externalReplacements.add(replacement.path);
        }
      } catch {
        /* The traversal reports syntax and dependency failures below. */
      }
    }

    const seen = new Set<string>();
    const todo = [{ path: file, unmocked: false }];
    while (todo.length) {
      const { path: next, unmocked } = todo.pop()!;
      const identity = `${next}:${unmocked}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      try {
        const parsed = parseCached(next);
        if (parsed.uncertain) {
          errors.push(
            `${file}: ${label} dependency ${next} has a computed runtime import; use an explicit pure dependency or effect contract`,
          );
        }
        if (label === "presentation") {
          for (const invalid of parsed.invalidModuleMocks) {
            errors.push(`${file}: unsupported presentation replacement at ${next}:${invalid.line}: ${invalid.reason}`);
          }
        }
        for (const access of parsed.effectAccess) {
          errors.push(
            `${file}: ${label} dependency ${next}:${access.line} accesses ${access.name}; use an injected effect or test the native boundary in contracts`,
          );
        }
        for (const entry of parsed.imports.filter((item) => item.runtime)) {
          const candidates = sourceCandidates(next, entry.path);
          const target = candidates.find((candidate) => files.has(candidate));
          const actual = unmocked || entry.unmocked === true;
          if (label === "presentation" && !actual && (target ? replaced.has(target) : externalReplacements.has(entry.path))) {
            continue;
          }
          if (entry.path.endsWith(".css")) {
            if (label === "presentation" && (target || UI_CSS_ASSETS.has(entry.path))) continue;
            errors.push(
              `${file}: ${label} dependency ${next} imports ${entry.path}; stylesheets need a real presentation asset or browser contract`,
            );
            continue;
          }
          if (EFFECTS.test(entry.path)) {
            errors.push(`${file}: ${label} dependency ${next} imports ${entry.path}; real I/O belongs in contracts or journeys`);
          }
          if (target && isSource(target)) {
            todo.push({ path: target, unmocked: actual });
          } else if (candidates.length && !target) {
            errors.push(`${file}: unresolved ${label} dependency ${entry.path} in ${next}`);
          } else if (
            !target &&
            !EFFECTS.test(entry.path) &&
            !PURE_IMPORTS.has(entry.path.replace(/^node:/, "")) &&
            !(label === "presentation" && UI_IMPORTS.test(entry.path))
          ) {
            errors.push(
              `${file}: unreviewed external ${label} dependency ${entry.path} in ${next}; keep native adapters outside this layer`,
            );
          }
        }
      } catch (error) {
        errors.push(
          `${file}: cannot inspect ${label} dependency ${next}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  return [...new Set(errors)].sort();
}
