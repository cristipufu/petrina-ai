import { posix } from "node:path";

const aliases = new Map([["@petrina/core", "packages/core/src/index.ts"], ["@petrina/engine", "packages/engine/src/index.ts"]]);

/** Repository-relative ESM candidates, shared by dependency selection and fixture policy. */
export function sourceCandidates(from: string, path: string): readonly string[] {
  const target = aliases.get(path) ?? (path.startsWith(".") ? posix.normalize(posix.join(posix.dirname(from), path)) : undefined);
  if (!target) return [];
  return [...new Set([target, target.replace(/\.js$/, ".ts"), target.replace(/\.js$/, ".tsx"), `${target}.ts`, `${target}.tsx`, `${target}/index.ts`])];
}
