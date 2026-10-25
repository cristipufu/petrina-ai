const MARK = "__petrina_env__";

/** The PATH line between the markers of `env` output. */
export function pathFromEnv(output: string): string | undefined {
  // Whole marker lines only: an interactive dash exports `_=__petrina_env__`, which must not count.
  const lines = output.split("\n").map((entry) => entry.replace(/\r$/, ""));
  const start = lines.indexOf(MARK);
  const end = lines.lastIndexOf(MARK);
  if (start < 0 || end <= start) return undefined;
  const line = lines.slice(start + 1, end).find((entry) => entry.startsWith("PATH="));
  const value = line?.slice("PATH=".length).trim();
  return value ? value : undefined;
}

/** The shell's PATH first, then anything only the current one has. */
export function mergePath(preferred: string | undefined, current: string | undefined, separator: string): string {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const entry of [...(preferred ?? "").split(separator), ...(current ?? "").split(separator)]) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    merged.push(entry);
  }
  return merged.join(separator);
}
