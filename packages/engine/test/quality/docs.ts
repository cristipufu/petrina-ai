function normalizePosixPath(baseDir: string, relativePath: string): string {
  const joined = baseDir ? `${baseDir}/${relativePath}` : relativePath;
  const parts: string[] = [];
  for (const segment of joined.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (parts.length === 0) return `../${relativePath}`;
      parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join("/");
}

function stripCodeFromMarkdown(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  const cleaned: string[] = [];
  let fence: string | undefined;
  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = /^(```+|~~~+)/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0]!;
      if (!fence) {
        fence = marker;
        cleaned.push("");
        continue;
      }
      if (fence === marker && trimmed.startsWith(marker.repeat(3))) {
        fence = undefined;
        cleaned.push("");
        continue;
      }
    }
    if (fence) {
      cleaned.push("");
      continue;
    }
    cleaned.push(line.replace(/`[^`]*`/g, ""));
  }
  return cleaned;
}

export function extractOperationGroups(operationsSource: string): string[] {
  const groups = new Set<string>();
  const pattern = /\bop\(\s*["'`]([a-z][a-z0-9-]*)\./g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(operationsSource)) !== null) {
    groups.add(match[1]!);
  }
  return [...groups].sort();
}

const EXTERNAL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function docContracts(
  files: ReadonlyMap<string, string>,
  operationNames?: readonly string[],
): string[] {
  const errors: string[] = [];
  const coordination = files.get("docs/coordination.md");
  if (coordination !== undefined) {
    const groups = operationNames
      ? [...new Set(operationNames.map((name) => name.split(".")[0]!))].sort()
      : extractOperationGroups(files.get("packages/engine/src/operations.ts") ?? "");
    for (const group of groups) {
      if (!coordination.includes(`\`${group}\``)) {
        errors.push(
          `docs/coordination.md: missing operation group \`${group}\` from packages/engine/src/operations.ts`,
        );
      }
    }
  }

  const allPaths = [...files.keys()];
  for (const [file, source] of files) {
    const activeDoc =
      file.endsWith(".md")
      && !file.startsWith("docs/archive/")
      && (file.startsWith("docs/") || !file.includes("/"));
    if (!activeDoc) continue;
    const baseDir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
    const lines = stripCodeFromMarkdown(source);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      const linkPattern = /!?\[[^\]]*\]\(([^)]+)\)/g;
      let match: RegExpExecArray | null;
      while ((match = linkPattern.exec(line)) !== null) {
        const rawTarget = match[1]!.trim().replace(/^<|>$/g, "").split(/\s+/)[0] ?? "";
        if (!rawTarget || rawTarget.startsWith("#") || EXTERNAL_SCHEME.test(rawTarget)) continue;
        const pathOnly = rawTarget.split("#")[0]!.split("?")[0]!.trim();
        if (!pathOnly) continue;
        const resolved = pathOnly.startsWith("/")
          ? pathOnly.replace(/^\/+/, "")
          : normalizePosixPath(baseDir, pathOnly);
        const exists =
          files.has(resolved)
          || allPaths.some((candidate) => candidate.startsWith(`${resolved.replace(/\/+$/, "")}/`));
        if (!exists) {
          errors.push(
            `${file}:${index + 1}: broken documentation link '${rawTarget}' (expected '${resolved}' in repository)`,
          );
        }
      }
    }
  }
  return errors.sort();
}
