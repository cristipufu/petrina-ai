import { realpathSync } from "node:fs";
import { dirname } from "node:path";

/**
 * True when running inside a `bun build --compile` standalone executable, where Bun mounts embedded
 * modules under `/$bunfs/...` on Unix or `<Drive>:\~BUN\...` on Windows.
 */
export function isCompiledBinary(metaDir: string = import.meta.dir): boolean {
  return metaDir.startsWith("/$bunfs") || /^[A-Za-z]:[\\/]~BUN(?:[\\/]|$)/i.test(metaDir);
}

/** Directory containing the running executable on disk, resolving symlinks when possible. */
export function compiledExecutableDir(execPath: string = process.execPath): string {
  try {
    return dirname(realpathSync(execPath));
  } catch {
    return dirname(execPath);
  }
}

/**
 * Resolve a `bun` interpreter path. In source mode `process.execPath` is already `bun`; inside a
 * compiled binary `process.execPath` is `petrina-engine`, so fall back to `Bun.which("bun")`.
 */
export function findBunRuntime(execPath: string = process.execPath, metaDir: string = import.meta.dir): string {
  if (!isCompiledBinary(metaDir)) return execPath;
  return Bun.which("bun") ?? "bun";
}

/**
 * Resolve a JavaScript interpreter (`node` or `bun`) capable of running an external `.js` CLI script
 * on disk when executing inside a compiled binary.
 */
export function findJsRuntime(execPath: string = process.execPath, metaDir: string = import.meta.dir): string {
  if (!isCompiledBinary(metaDir)) return execPath;
  return Bun.which("node") ?? Bun.which("bun") ?? "node";
}
