import { engineConstructionBoundaries } from "./engine-construction.js";
import { MAX_PRODUCTION_LINE_WIDTH, productionFormattingViolations } from "./format.js";
import { childFixtureBoundaries, layerBoundaries, packageBoundaries } from "./layers.js";
import { sourceCandidates } from "./source-paths.js";
import { sourceFacts } from "./source.js";
import { isSource, isTest, workspaceOf } from "./test-paths.js";
import { TEST_WORKSPACES } from "./workspaces.js";

export { MAX_PRODUCTION_LINE_WIDTH };
export const MAX_PRODUCTION_LINES = 650;

/** Contravariant Error constructor signature in the test rejection helper (`new (...args: any[]) => Error`). */
const ALLOWED_PRODUCTION_ANY: Readonly<Record<string, number>> = {
  "packages/test-support/src/rejections.ts": 1,
};

const countLines = (source: string): number =>
  source === "" ? 0 : source.replace(/\r?\n$/, "").split(/\r?\n/).length;

const isRustTest = (file: string): boolean =>
  /(?:^|\/)tests\/|(?:^|\/)(?:test_[^/]+|[^/]+[._](?:test|spec)s?|tests|specs)\.rs$/.test(file);

const isRustProduction = (file: string, workspace: string | undefined): boolean =>
  !!workspace
  && !file.includes("/target/")
  && !file.includes("/gen/")
  && (
    file.startsWith(`${workspace}/src/`)
    || file.startsWith(`${workspace}/src-tauri/src/`)
    || file === `${workspace}/src-tauri/build.rs`
  )
  && !isRustTest(file);

export function conventions(files: ReadonlyMap<string, string>): string[] {
  const errors: string[] = [];
  for (const [file, source] of files) {
    if (file.endsWith(".css")) {
      const workspace = workspaceOf(file);
      if (workspace && file.startsWith(`${workspace}/src/`)) {
        const lines = countLines(source);
        if (lines > MAX_PRODUCTION_LINES) {
          errors.push(
            `${file}: ${lines} lines exceeds the ${MAX_PRODUCTION_LINES}-line production stylesheet ceiling; split cohesive surfaces into focused stylesheets`,
          );
        }
      }
      continue;
    }
    if (file.endsWith(".rs")) {
      const workspace = workspaceOf(file);
      if (isRustProduction(file, workspace)) {
        const lines = countLines(source);
        if (lines > MAX_PRODUCTION_LINES) {
          errors.push(
            `${file}: ${lines} lines exceeds the ${MAX_PRODUCTION_LINES}-line production Rust module ceiling; split cohesive responsibilities into focused modules`,
          );
        }
        const rawLines = source.split(/\r?\n/);
        for (let index = 0; index < rawLines.length; index += 1) {
          const line = rawLines[index]!;
          if (line.length > MAX_PRODUCTION_LINE_WIDTH) {
            errors.push(
              `${file}:${index + 1}: line width ${line.length} exceeds ${MAX_PRODUCTION_LINE_WIDTH} characters; wrap long Rust expressions or string literals`,
            );
          }
        }
      }
      continue;
    }
    if (!isSource(file)) continue;
    const workspace = workspaceOf(file);
    const production = !!workspace && file.startsWith(`${workspace}/src/`) && !isTest(file);
    const inTestTree = !!workspace && file.startsWith(`${workspace}/test/`);
    const engine = file.startsWith("packages/engine/test/");
    const native = TEST_WORKSPACES.some(
      (entry) => entry.runner === "bun" && file.startsWith(`${entry.path}/test/`),
    );
    if (!production && !inTestTree && !native && !isTest(file)) continue;

    if (production) {
      const lines = countLines(source);
      if (lines > MAX_PRODUCTION_LINES) {
        errors.push(
          `${file}: ${lines} lines exceeds the ${MAX_PRODUCTION_LINES}-line production module ceiling; split cohesive responsibilities into focused modules`,
        );
      }
      if (!file.endsWith(".d.ts")) {
        let facts;
        try {
          facts = sourceFacts(source, file);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          errors.push(`${file}: cannot parse production source: ${detail}`);
          continue;
        }
        const allowedAny = ALLOWED_PRODUCTION_ANY[file] ?? 0;
        if (facts.anyTypes.length > allowedAny) {
          for (const line of facts.anyTypes.slice(allowedAny)) {
            errors.push(
              `${file}:${line}: avoid 'any' in production source; use 'unknown', concrete domain types, or generic constraints`,
            );
          }
        }
        for (const violation of productionFormattingViolations(source, file)) {
          errors.push(`${file}:${violation.line}: ${violation.reason}`);
        }
      }
      continue;
    }

    let facts;
    try {
      facts = sourceFacts(source, file);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      errors.push(`${file}: cannot parse test source: ${detail}`);
      continue;
    }

    if (!file.endsWith(".d.ts")) {
      for (const line of facts.anyTypes) {
        errors.push(
          `${file}:${line}: avoid 'any' in test source; use 'unknown', concrete domain types, or typed fixture shapes`,
        );
      }
    }

    if (engine) errors.push(...engineConstructionBoundaries(file, facts.engineConstructions));

    const fromProduction = (path: string, ...modules: readonly string[]) =>
      sourceCandidates(file, path).some((candidate) =>
        modules.some((module) => candidate === `packages/engine/src/${module}.ts`),
      );

    if (engine && file !== "packages/engine/test/engine.ts") {
      for (const entry of facts.imports) {
        if (
          entry.runtime
          && fromProduction(entry.path, "engine", "index")
          && entry.names.some((name) => ["Engine", "*", "default"].includes(name))
        ) {
          errors.push(`${file}: import Engine from the isolated test/engine fixture`);
        }
      }
    }

    if (engine && file !== "packages/engine/test/client.ts") {
      for (const entry of facts.imports) {
        if (
          entry.runtime
          && fromProduction(entry.path, "engine-client")
          && entry.names.some((name) => ["EngineClient", "*", "default"].includes(name))
        ) {
          errors.push(`${file}: import EngineClient from test/client so lifecycle starts use the isolated fixture CLI`);
        }
      }
    }

    if (engine && file !== "packages/engine/test/fixtures.ts") {
      for (const entry of facts.imports) {
        if (
          entry.runtime
          && fromProduction(entry.path, "checks")
          && entry.names.some((name) => ["runChecks", "*", "default"].includes(name))
        ) {
          errors.push(`${file}: import runChecks from test/fixtures, which never reads this Mac's power log`);
        }
      }
    }

    if (native) {
      for (const line of facts.promiseMatchers) {
        errors.push(
          `${file}:${line}: await rejectionOf/expectRejection or the ordinary Promise before asserting; do not use Bun's promise matchers`,
        );
      }
      errors.push(...childFixtureBoundaries(file, facts.childPrograms, files));
    }

    for (const line of facts.blockingCalls) {
      errors.push(
        `${file}:${line}: run test programs with runCommand or git from @petrina/test-support/commands; a synchronous child call holds the whole test worker until its exit is reported`,
      );
    }

    for (const { line, name } of facts.unfinished) {
      errors.push(
        `${file}:${line}: await ${name}(…), return it or collect it before going on; its result and its failure are otherwise lost`,
      );
    }
    for (const line of facts.asyncCallbacks) {
      errors.push(
        `${file}:${line}: keep this callback synchronous, it is called without waiting; read what it needs before, or hold the workflow while reading it`,
      );
    }
    if (facts.concurrentTests.length) {
      for (const line of facts.environmentMutations) {
        errors.push(
          `${file}:${line}: concurrent tests cannot change process.env in their worker; pass an environment to the boundary or use an owned child process`,
        );
      }
    }

    for (const line of facts.exclusiveTests) {
      errors.push(`${file}:${line}: remove the exclusive test selection before handoff`);
    }
  }
  return [...errors, ...layerBoundaries(files), ...packageBoundaries(files)].sort();
}
