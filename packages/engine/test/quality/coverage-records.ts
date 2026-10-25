import { isAbsolute, relative, resolve } from "node:path";

export function coveredFiles(lcov: string, workspace: string, root: string): string[] {
  const files = new Set<string>();
  for (const entry of lcov.split("end_of_record")) {
    const source = entry.match(/^SF:(.+)$/m)?.[1]?.trim();
    if (!source || ![...entry.matchAll(/^DA:\d+,(\d+)/gm)].some(match => Number(match[1]) > 0)) continue;
    files.add(relative(root, isAbsolute(source) ? source : resolve(root, workspace, source)).replaceAll("\\", "/"));
  }
  return [...files].sort();
}
