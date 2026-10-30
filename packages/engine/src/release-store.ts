import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

export type ReleaseKind = "binary" | "bun";

export interface ReleasePointer {
  readonly version: string;
  readonly entrypoint: string;
  readonly kind: ReleaseKind;
  readonly promotedAt: number;
}

export interface StagedRelease {
  readonly version: string;
  readonly entrypoint: string;
  readonly kind: ReleaseKind;
  readonly stagedAt: number;
}

export interface ReleaseCatalogView {
  readonly current: ReleasePointer | null;
  readonly previous: ReleasePointer | null;
  readonly versions: readonly StagedRelease[];
}

interface StagedManifest {
  readonly version: string;
  readonly relativeEntrypoint: string;
  readonly kind: ReleaseKind;
  readonly stagedAt: number;
}

const VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const DIRECTORY_ENTRYPOINT_CANDIDATES = [
  "petrina-engine",
  "petrina-engine.exe",
  "cli.ts",
  "cli.js",
  "cli.mjs",
  "index.ts",
  "index.js",
] as const;

export function validateReleaseVersion(version: string): string {
  const trimmed = version.trim();
  if (!VERSION_PATTERN.test(trimmed) || trimmed.includes("..")) {
    throw new Error(
      "Engine release version must be 1–80 characters of letters, digits, dots, underscores, or hyphens, without '..'.",
    );
  }
  return trimmed;
}

function inferReleaseKind(filePath: string): ReleaseKind {
  return /\.(?:[cm]?ts|[cm]?js)$/i.test(filePath) ? "bun" : "binary";
}

function writeAtomicJson(targetPath: string, parentDir: string, payload: unknown): void {
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const tempPath = join(
    parentDir,
    `.tmp-${basename(targetPath)}-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  const encoded = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const fd = openSync(tempPath, "w", 0o600);
  try {
    writeSync(fd, encoded);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tempPath, targetPath);
}

function isInsideDirectory(childPath: string, parentDir: string): boolean {
  const resolvedParent = resolve(parentDir);
  const resolvedChild = resolve(childPath);
  const rel = relative(resolvedParent, resolvedChild);
  return Boolean(rel) && !rel.startsWith("..") && !rel.includes(`..${sep}`);
}

export class ReleaseStore {
  readonly releasesDir: string;
  readonly versionsDir: string;
  readonly currentPath: string;
  readonly previousPath: string;

  constructor(readonly home: string) {
    this.releasesDir = join(home, "releases");
    this.versionsDir = join(this.releasesDir, "versions");
    this.currentPath = join(this.releasesDir, "current");
    this.previousPath = join(this.releasesDir, "previous");
  }

  hasVersion(version: string): boolean {
    return this.readVersion(version) !== null;
  }

  readVersion(version: string): StagedRelease | null {
    let clean: string;
    try {
      clean = validateReleaseVersion(version);
    } catch {
      return null;
    }
    const dir = join(this.versionsDir, clean);
    const manifestPath = join(dir, "release.json");
    if (!existsSync(manifestPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<StagedManifest>;
      if (
        parsed.version !== clean
        || typeof parsed.relativeEntrypoint !== "string"
        || !parsed.relativeEntrypoint
        || (parsed.kind !== "binary" && parsed.kind !== "bun")
        || typeof parsed.stagedAt !== "number"
      ) {
        return null;
      }
      const entrypoint = resolve(dir, parsed.relativeEntrypoint);
      if (!isInsideDirectory(entrypoint, dir) || !existsSync(entrypoint) || !statSync(entrypoint).isFile()) {
        return null;
      }
      return {
        version: clean,
        entrypoint,
        kind: parsed.kind,
        stagedAt: parsed.stagedAt,
      };
    } catch {
      return null;
    }
  }

  stage(version: string, sourcePath: string): StagedRelease {
    const clean = validateReleaseVersion(version);
    const resolvedSource = resolve(sourcePath);
    if (!existsSync(resolvedSource)) {
      throw new Error(`Engine release source does not exist: ${sourcePath}`);
    }
    const targetDir = join(this.versionsDir, clean);
    if (existsSync(targetDir)) {
      throw new Error(`Engine release version ${clean} is already staged. Choose a new version identifier.`);
    }

    mkdirSync(this.versionsDir, { recursive: true, mode: 0o700 });
    const stagingDir = join(
      this.releasesDir,
      `.staging-${clean}-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });

    try {
      const sourceStat = statSync(resolvedSource);
      let relativeEntrypoint: string;
      if (sourceStat.isFile()) {
        relativeEntrypoint = basename(resolvedSource);
        if (relativeEntrypoint === "release.json") {
          relativeEntrypoint = "engine-entry.js";
        }
        const destFile = join(stagingDir, relativeEntrypoint);
        cpSync(resolvedSource, destFile);
        chmodSync(destFile, sourceStat.mode);
      } else if (sourceStat.isDirectory()) {
        for (const entry of readdirSync(resolvedSource)) {
          if (entry === "release.json") continue;
          cpSync(join(resolvedSource, entry), join(stagingDir, entry), { recursive: true });
        }
        const found = DIRECTORY_ENTRYPOINT_CANDIDATES.find((candidate) => {
          const candidatePath = join(stagingDir, candidate);
          return existsSync(candidatePath) && statSync(candidatePath).isFile();
        });
        if (!found) {
          throw new Error(
            `Staged directory for ${clean} does not contain a recognized engine entrypoint (${DIRECTORY_ENTRYPOINT_CANDIDATES.join(", ")}).`,
          );
        }
        relativeEntrypoint = found;
      } else {
        throw new Error(`Engine release source must be a file or directory: ${sourcePath}`);
      }

      const kind = inferReleaseKind(relativeEntrypoint);
      const stagedAt = Date.now();
      const manifest: StagedManifest = {
        version: clean,
        relativeEntrypoint,
        kind,
        stagedAt,
      };
      writeAtomicJson(join(stagingDir, "release.json"), stagingDir, manifest);
      renameSync(stagingDir, targetDir);
      return {
        version: clean,
        entrypoint: resolve(targetDir, relativeEntrypoint),
        kind,
        stagedAt,
      };
    } catch (error) {
      rmSync(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  private readPointerFile(pointerPath: string): ReleasePointer | null {
    if (!existsSync(pointerPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(pointerPath, "utf8")) as Partial<ReleasePointer>;
      if (
        typeof parsed.version !== "string"
        || typeof parsed.entrypoint !== "string"
        || (parsed.kind !== "binary" && parsed.kind !== "bun")
        || typeof parsed.promotedAt !== "number"
      ) {
        return null;
      }
      const clean = validateReleaseVersion(parsed.version);
      const entrypoint = resolve(parsed.entrypoint);
      if (
        !isInsideDirectory(entrypoint, this.versionsDir)
        || !existsSync(entrypoint)
        || !statSync(entrypoint).isFile()
      ) {
        return null;
      }
      return {
        version: clean,
        entrypoint,
        kind: parsed.kind,
        promotedAt: parsed.promotedAt,
      };
    } catch {
      return null;
    }
  }

  readCurrent(): ReleasePointer | null {
    return this.readPointerFile(this.currentPath);
  }

  readPrevious(): ReleasePointer | null {
    return this.readPointerFile(this.previousPath);
  }

  list(): ReleaseCatalogView {
    const versions: StagedRelease[] = [];
    if (existsSync(this.versionsDir)) {
      for (const name of readdirSync(this.versionsDir).sort()) {
        const staged = this.readVersion(name);
        if (staged) versions.push(staged);
      }
    }
    return {
      current: this.readCurrent(),
      previous: this.readPrevious(),
      versions,
    };
  }

  promote(version: string): { current: ReleasePointer; previous: ReleasePointer | null } {
    const staged = this.readVersion(version);
    if (!staged) {
      throw new Error(`Engine release version ${version} is not staged.`);
    }
    const oldCurrent = this.readCurrent();
    let previous = this.readPrevious();
    if (oldCurrent && oldCurrent.version !== staged.version) {
      previous = oldCurrent;
      writeAtomicJson(this.previousPath, this.releasesDir, previous);
    }
    const nextCurrent: ReleasePointer = {
      version: staged.version,
      entrypoint: staged.entrypoint,
      kind: staged.kind,
      promotedAt: Date.now(),
    };
    writeAtomicJson(this.currentPath, this.releasesDir, nextCurrent);
    return { current: nextCurrent, previous };
  }

  rollback(): { current: ReleasePointer; rolledBackFrom: string | null } {
    const previous = this.readPrevious();
    if (!previous) {
      throw new Error("No previous engine release is available to roll back to.");
    }
    const oldCurrent = this.readCurrent();
    const restored: ReleasePointer = {
      version: previous.version,
      entrypoint: previous.entrypoint,
      kind: previous.kind,
      promotedAt: Date.now(),
    };
    writeAtomicJson(this.currentPath, this.releasesDir, restored);
    return { current: restored, rolledBackFrom: oldCurrent?.version ?? null };
  }

  commandFor(pointer: ReleasePointer, args: readonly string[], bunExecutable = process.execPath): string[] {
    return pointer.kind === "bun"
      ? [bunExecutable, pointer.entrypoint, ...args]
      : [pointer.entrypoint, ...args];
  }
}
