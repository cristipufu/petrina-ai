import { isSource, isTest } from "./test-paths.js";
import { sourceFacts } from "./source.js";
import { sourceCandidates } from "./source-paths.js";
import { layerBoundaries } from "./layers.js";

export function conventions(files: ReadonlyMap<string, string>): string[] {
  const errors: string[] = [];
  for (const [file, source] of files) {
    const engine = file.startsWith("packages/engine/test/");
    if ((!engine && !isTest(file)) || !isSource(file)) continue;
    let facts;
    try { facts = sourceFacts(source, file); }
    catch (error) { errors.push(`${file}: cannot parse test source: ${error instanceof Error ? error.message : String(error)}`); continue; }
    const fromProduction = (path: string, ...modules: readonly string[]) => sourceCandidates(file, path).some(candidate => modules.some(module => candidate === `packages/engine/src/${module}.ts`));
    if (engine && file !== "packages/engine/test/engine.ts") for (const entry of facts.imports) {
      if (entry.runtime && fromProduction(entry.path, "engine", "index") && entry.names.some(name => ["Engine", "*", "default"].includes(name))) errors.push(`${file}: import Engine from the isolated test/engine fixture`);
    }
    if (engine && file !== "packages/engine/test/client.ts") for (const entry of facts.imports) {
      if (entry.runtime && fromProduction(entry.path, "engine-client") && entry.names.some(name => ["EngineClient", "*", "default"].includes(name))) errors.push(`${file}: import EngineClient from test/client so lifecycle starts use the isolated fixture CLI`);
    }
    if (engine && file !== "packages/engine/test/fixtures.ts") for (const entry of facts.imports) {
      if (entry.runtime && fromProduction(entry.path, "checks") && entry.names.some(name => ["runChecks", "*", "default"].includes(name))) errors.push(`${file}: import runChecks from test/fixtures, which never reads this Mac's power log`);
    }
    if (engine) for (const line of facts.promiseMatchers) errors.push(`${file}:${line}: await rejectionOf/expectRejection or the ordinary Promise before asserting; do not use Bun's promise matchers`);
    for (const line of facts.blockingCalls) errors.push(`${file}:${line}: run test programs with runCommand or git from test/commands; a synchronous child call holds the whole test worker until its exit is reported`);
    if (engine) for (const { line, name } of facts.unfinished) errors.push(`${file}:${line}: await ${name}(…), return it or collect it before going on; its result and its failure are otherwise lost`);
    if (engine) for (const line of facts.asyncCallbacks) errors.push(`${file}:${line}: keep this callback synchronous, it is called without waiting; read what it needs before, or hold the workflow while reading it`);
    for (const line of facts.exclusiveTests) errors.push(`${file}:${line}: remove the exclusive test selection before handoff`);
  }
  return [...errors, ...layerBoundaries(files)].sort();
}

