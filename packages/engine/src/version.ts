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

/** The keys where a TOML version file states the product's own version. */
const OWN_TOML_VERSIONS: readonly (readonly string[])[] = [["package", "version"], ["project", "version"], ["workspace", "package", "version"], ["tool", "poetry", "version"]];

/**
 * Whether a version file's change sets the version and nothing else, so no dependency, script or setting can
 * ride along in a release's version commit unreviewed. JSON and TOML: the same document once the product's own
 * version fields are put back, and those say `version`. Cargo.lock: only local packages (no registry source)
 * move, from `from` (the previous release's version) to `version`. Plain version files: exactly the version.
 */
export function onlyVersionChanged(path: string, before: string | undefined, after: string | undefined, version: string, from?: string): boolean {
  if (before === undefined || after === undefined) return false;
  const name = path.split("/").at(-1) ?? "";
  if (name === "VERSION" || name === "version.txt") return after.trim() === version;
  const parse = name.endsWith(".json") ? (text: string) => JSON.parse(text) as unknown : (text: string) => Bun.TOML.parse(text) as unknown;
  let old: Record<string, unknown>;
  let now: Record<string, unknown>;
  try {
    old = parse(before) as Record<string, unknown>;
    now = parse(after) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (!old || !now || typeof old !== "object" || typeof now !== "object") return false;
  if (name === "Cargo.lock") return lockOnlyBumps(old, now, version, from);
  const keys: readonly (readonly string[])[] = name.endsWith(".json") ? [["version"], ...(name === "package-lock.json" ? [["packages", "", "version"]] : [])] : OWN_TOML_VERSIONS;
  const changed = keys.map((key) => [get(old, key), get(now, key)] as const).filter(([was, is]) => was !== is);
  if (changed.some(([, is]) => is !== version)) return false;
  return JSON.stringify(cleared(old, keys)) === JSON.stringify(cleared(now, keys));
}

/** Cargo.lock: the same packages, and only local ones (no registry source) change, only their version, from `from` to `version`. */
function lockOnlyBumps(old: Record<string, unknown>, now: Record<string, unknown>, version: string, from: string | undefined): boolean {
  if (from === undefined) return false;
  const was = Array.isArray(old.package) ? (old.package as Record<string, unknown>[]) : [];
  const is = Array.isArray(now.package) ? (now.package as Record<string, unknown>[]) : [];
  if (was.length !== is.length || JSON.stringify({ ...old, package: [] }) !== JSON.stringify({ ...now, package: [] })) return false;
  return was.every((entry, index) => {
    const next = is[index]!;
    if (JSON.stringify(entry) === JSON.stringify(next)) return true;
    const local = entry.source === undefined && next.source === undefined;
    return local && entry.version === from && next.version === version && JSON.stringify({ ...entry, version: "" }) === JSON.stringify({ ...next, version: "" });
  });
}

function get(doc: unknown, key: readonly string[]): unknown {
  return key.reduce<unknown>((at, part) => (at && typeof at === "object" ? (at as Record<string, unknown>)[part] : undefined), doc);
}

/** A copy with the given version keys emptied, where they exist. */
function cleared(doc: Record<string, unknown>, keys: readonly (readonly string[])[]): unknown {
  const copy = JSON.parse(JSON.stringify(doc)) as Record<string, unknown>;
  for (const key of keys) {
    const parent = get(copy, key.slice(0, -1));
    if (parent && typeof parent === "object" && key.at(-1)! in parent) (parent as Record<string, unknown>)[key.at(-1)!] = "";
  }
  return copy;
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
