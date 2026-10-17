// Release versions: the next one, and what a product's main version files say. Pure functions.

export type Bump = "patch" | "minor" | "major";

/** The files a release's version change may touch, at any depth (a monorepo's packages have their own). What may change in them is checked line by line. */
const VERSION_FILES = new Set(["package.json", "package-lock.json", "Cargo.toml", "Cargo.lock", "pyproject.toml", "tauri.conf.json", "VERSION", "version.txt"]);

/**
 * The product's main version files, at their usual places: the only ones Petrina reads and checks.
 * Every one that exists and states a version must say the release's version. Subfolders, lock files
 * and other files are the reviewers' to check.
 */
export const MAIN_VERSION_FILES: readonly string[] = ["package.json", "Cargo.toml", "tauri.conf.json", "src-tauri/tauri.conf.json"];

const SEMVER = /^(v?)(\d+)\.(\d+)\.(\d+)$/;

export function isVersionFile(path: string): boolean {
  return VERSION_FILES.has(path.split("/").at(-1) ?? "");
}

/** A line that states a version and nothing else, as TOML and lock files write it. */
const VERSION_LINE = /^\s*version\s*=\s*"([^"]*)"\s*$/;

/**
 * Whether a version file's change sets the version and nothing else, so no dependency, script or setting can
 * ride along in a release's version commit unreviewed. JSON: the same document once its version fields are
 * put back. TOML and lock files: only lines that state a version changed, each from `from` (the previous
 * release's version, when there is one) to `version`. Plain version files: exactly the version.
 */
export function onlyVersionChanged(path: string, before: string | undefined, after: string | undefined, version: string, from?: string): boolean {
  if (before === undefined || after === undefined) return false;
  const name = path.split("/").at(-1) ?? "";
  if (name === "VERSION" || name === "version.txt") return after.trim() === version;
  if (name.endsWith(".json")) {
    let old: unknown;
    let now: unknown;
    try {
      old = JSON.parse(before);
      now = JSON.parse(after);
    } catch {
      return false;
    }
    const versions = (doc: unknown): unknown[] => {
      const root = doc as { version?: unknown; packages?: Record<string, { version?: unknown }> } | null;
      return [root?.version, ...(name === "package-lock.json" ? [root?.packages?.[""]?.version] : [])];
    };
    const reset = (doc: unknown): string => {
      const copy = JSON.parse(JSON.stringify(doc)) as { version?: unknown; packages?: Record<string, { version?: unknown }> } | null;
      if (copy && typeof copy === "object" && "version" in copy) copy.version = "";
      if (name === "package-lock.json" && copy?.packages?.[""] && "version" in copy.packages[""]) copy.packages[""].version = "";
      return JSON.stringify(copy);
    };
    const changed = versions(now).filter((value, index) => value !== versions(old)[index]);
    return reset(old) === reset(now) && changed.every((value) => value === version);
  }
  const old = before.split("\n");
  const now = after.split("\n");
  if (old.length !== now.length) return false;
  return old.every((line, index) => {
    if (line === now[index]) return true;
    const was = VERSION_LINE.exec(line)?.[1];
    const is = VERSION_LINE.exec(now[index]!)?.[1];
    // In a lock file, only the product's own entries move: from the version it had to the new one.
    const own = !name.endsWith(".lock") || from === undefined || was === from;
    return was !== undefined && is === version && own;
  });
}

/** A release tag or version number Petrina can count up from, e.g. v1.2.3 or 1.2.3. */
export function parseVersion(text: string): { prefix: string; version: string; parts: [number, number, number] } | undefined {
  const match = SEMVER.exec(text.trim());
  if (!match) return undefined;
  const parts: [number, number, number] = [Number(match[2]), Number(match[3]), Number(match[4])];
  return { prefix: match[1]!, version: parts.join("."), parts };
}

/** The next release after `latest`, keeping its tag style. */
export function nextVersion(latest: string, bump: Bump): { version: string; tag: string } | undefined {
  const parsed = parseVersion(latest);
  if (!parsed) return undefined;
  const [major, minor, patch] = parsed.parts;
  const version = bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  return { version, tag: `${parsed.prefix}${version}` };
}

/**
 * What a main version file says. `none`: it states no version of its own (a JSON file with no version
 * field or one taken from another file, a Cargo workspace with neither a package nor a shared version).
 * `unreadable`: anything Petrina cannot read, a package's missing version included, which stops a release.
 */
export type Declared = { version: string } | "none" | "unreadable";

export function declaredVersion(path: string, text: string): Declared {
  const name = path.split("/").at(-1) ?? "";
  if (name.endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return "unreadable";
    }
    if (!parsed || typeof parsed !== "object" || !("version" in parsed)) return "none";
    const version = (parsed as { version?: unknown }).version;
    // Tauri can take its version from another file ("../package.json"), which is checked itself.
    if (name === "tauri.conf.json" && typeof version === "string" && version.endsWith(".json")) return "none";
    return typeof version === "string" && parseVersion(version) && !parseVersion(version)!.prefix ? { version } : "unreadable";
  }
  if (name === "Cargo.toml") {
    // Read as TOML, so every way of writing it counts: quoted keys, dotted keys, inline tables.
    let parsed: Record<string, unknown>;
    try {
      parsed = Bun.TOML.parse(text) as Record<string, unknown>;
    } catch {
      return "unreadable";
    }
    const found: Declared[] = [];
    const shared = tableOf(parsed.workspace, "package");
    if (shared === null) return "unreadable";
    if (shared && "version" in shared) found.push(plainVersion(shared.version));
    // [project] is Cargo's old name for [package].
    for (const key of ["package", "project"]) {
      if (!(key in parsed)) continue;
      const table = tableOf(parsed, key);
      if (!table) return "unreadable";
      const own = table.version;
      // version.workspace = true: the package takes the workspace's version, which must be here to read.
      const inherited = own !== null && typeof own === "object" && !Array.isArray(own) && Object.keys(own).length === 1 && (own as { workspace?: unknown }).workspace === true;
      found.push(inherited ? (shared && "version" in shared ? plainVersion(shared.version) : "unreadable") : plainVersion(own));
    }
    if (found.includes("unreadable")) return "unreadable";
    const versions = new Set(found.map((entry) => (entry as { version: string }).version));
    if (versions.size > 1) return "unreadable";
    // No package and no shared version: a workspace whose crates each have their own.
    return found[0] ?? "none";
  }
  return "none";
}

/** A version like 1.2.3, or unreadable. */
function plainVersion(value: unknown): Declared {
  return typeof value === "string" && parseVersion(value) && !parseVersion(value)!.prefix ? { version: value } : "unreadable";
}

/** `parent[key]` as a table: undefined when there is none, null when it is something else. */
function tableOf(parent: unknown, key: string): Record<string, unknown> | undefined | null {
  if (parent === undefined) return undefined;
  if (parent === null || typeof parent !== "object" || Array.isArray(parent)) return null;
  const value = (parent as Record<string, unknown>)[key];
  if (value === undefined) return undefined;
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
