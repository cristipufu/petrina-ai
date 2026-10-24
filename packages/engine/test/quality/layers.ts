import { isSource, isTest, workspaceOf } from "./test-paths.js";
import { sourceFacts } from "./source.js";
import { sourceCandidates } from "./source-paths.js";

export const TEST_LAYERS = ["rules", "orchestration", "presentation", "contracts", "journeys"] as const;
type TestLayer = typeof TEST_LAYERS[number];
export const TEST_LAYER_INVENTORY = "docs/plans/test-layer-audit.json";
const EFFECTS = /^(?:node:)?(?:fs(?:\/.*)?|child_process|net|http(?:2|s)?|dgram|dns(?:\/.*)?|worker_threads|cluster|process|os)$|^bun(?::sqlite)?$|^(?:@playwright\/|playwright(?:\/|$))/;
const PURE_IMPORTS = new Set(["bun:test", "vitest", "@babel/parser", "saxes", "zod", "path", "path/posix", "path/win32", "url", "buffer", "crypto", "util", "util/types", "assert", "assert/strict", "events", "async_hooks", "string_decoder"]);
const UI_IMPORTS = /^(?:react(?:\/|$)|react-dom(?:\/|$)|lucide-react$|@xyflow\/react$|react-markdown$|remark-gfm$)/;

export function testLayer(file: string): { layer: TestLayer; area: string } | undefined {
  const workspace = workspaceOf(file);
  const parts = workspace && file.slice(workspace.length + 1).split("/");
  if (!parts || parts[0] !== "test" || !TEST_LAYERS.includes(parts[1] as TestLayer) || parts.length < 4 || !parts[2]) return;
  return { layer: parts[1] as TestLayer, area: parts.slice(2, -1).join("/") };
}

/** The explicit migration inventory is not permission to add another unstructured test file. */
export function layerStructure(files: ReadonlyMap<string, string>): string[] {
  const body = files.get(TEST_LAYER_INVENTORY);
  if (!body) return [`${TEST_LAYER_INVENTORY}: missing complete test-layer migration inventory`];
  let pending: Set<string>, recorded: string[];
  try {
    const inventory = JSON.parse(body);
    if (inventory.version !== 1 || !Array.isArray(inventory.files)) throw new Error("Invalid inventory");
    const paths = inventory.files.map((row: { file?: unknown }) => row.file);
    if (paths.some((file: unknown) => typeof file !== "string" || !isTest(file)) || new Set(paths).size !== paths.length) throw new Error("Invalid test identities");
    if (inventory.files.some((row: { status?: unknown; file: string }) => !["pending", "reviewed"].includes(row.status as string) || row.status === "reviewed" && !testLayer(row.file))) throw new Error("Invalid audit status");
    pending = new Set(inventory.files.filter((row: { status: string }) => row.status === "pending").map((row: { file: string }) => row.file));
    recorded = paths;
  } catch { return [`${TEST_LAYER_INVENTORY}: invalid test-layer migration inventory`]; }
  return [...recorded.filter(file => !files.has(file)).map(file => `${file}: missing inventoried test; audit its replacement before removing it`),
    ...[...files.keys()].filter(isTest).flatMap(file => testLayer(file) || pending.has(file) ? [] : [`${file}: place tests in test/<layer>/<area>; split mixed responsibilities instead of adding a flat test file`])];
}

/** Follow runtime local imports; a helper or barrel must not smuggle a real boundary into a lower layer. */
export function layerBoundaries(files: ReadonlyMap<string, string>): string[] {
  const errors: string[] = [];
  const facts = new Map<string, ReturnType<typeof sourceFacts>>();
  for (const file of [...files.keys()].filter(isTest).sort()) {
    const classified = testLayer(file);
    if (!classified || !["rules", "orchestration", "presentation"].includes(classified.layer)) continue;
    const seen = new Set<string>(), todo = [file];
    while (todo.length) {
      const next = todo.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      try {
        let parsed = facts.get(next);
        if (!parsed) { parsed = sourceFacts(files.get(next)!, next); facts.set(next, parsed); }
        if (parsed.uncertain) errors.push(`${file}: ${classified.layer} dependency ${next} has a computed runtime import; use an explicit pure dependency or effect contract`);
        for (const access of parsed.effectAccess) errors.push(`${file}: ${classified.layer} dependency ${next}:${access.line} accesses ${access.name}; use an injected effect or test the native boundary in contracts`);
        for (const entry of parsed.imports.filter(entry => entry.runtime)) {
          if (EFFECTS.test(entry.path)) errors.push(`${file}: ${classified.layer} dependency ${next} imports ${entry.path}; real I/O belongs in contracts or journeys`);
          const candidates = sourceCandidates(next, entry.path);
          const target = candidates.find(candidate => files.has(candidate));
          if (target && isSource(target)) todo.push(target);
          else if (candidates.length && !target) errors.push(`${file}: unresolved ${classified.layer} dependency ${entry.path} in ${next}`);
          else if (!target && !EFFECTS.test(entry.path) && !PURE_IMPORTS.has(entry.path.replace(/^node:/, "")) && !(classified.layer === "presentation" && UI_IMPORTS.test(entry.path))) errors.push(`${file}: unreviewed external ${classified.layer} dependency ${entry.path} in ${next}; keep native adapters outside this layer`);
        }
      } catch (error) { errors.push(`${file}: cannot inspect ${classified.layer} dependency ${next}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  return [...new Set(errors)].sort();
}
