import { posix } from "node:path";
import { TEST_WORKSPACES } from "./workspaces.js";

const aliases = new Map(TEST_WORKSPACES.flatMap(workspace => "entry" in workspace ? [[workspace.name, `${workspace.path}/${workspace.entry}`] as [string, string]] : []));

/** Repository-relative ESM candidates, shared by dependency selection and fixture policy. */
export function sourceCandidates(from: string, path: string): readonly string[] {
  const target = aliases.get(path) ?? (path.startsWith(".") ? posix.normalize(posix.join(posix.dirname(from), path)) : undefined);
  if (!target) return [];
  return [...new Set([target, target.replace(/\.js$/, ".ts"), target.replace(/\.js$/, ".tsx"), `${target}.ts`, `${target}.tsx`, `${target}/index.ts`])];
}
