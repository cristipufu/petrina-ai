import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  compiledExecutableDir,
  findBunRuntime,
  findJsRuntime,
  isCompiledBinary,
} from "@petrina/platform/compiled-runtime";
import type { ToolAdapter } from "./tool-adapter.js";

let cachedSourceRequire: NodeRequire | undefined;

function getSourceRequire(): NodeRequire {
  cachedSourceRequire ??= createRequire(import.meta.url);
  return cachedSourceRequire;
}

export function resolveAdapterEntry(
  entry: string,
  execPath: string = process.execPath,
  metaDir: string = import.meta.dir,
): string {
  if (isCompiledBinary(metaDir)) {
    try {
      const adjacentRequire = createRequire(pathToFileURL(join(compiledExecutableDir(execPath), "package.json")).href);
      return adjacentRequire.resolve(entry);
    } catch {
      // Fall through to embedded/global resolution so missing tools surface standard module-not-found.
    }
  }
  return getSourceRequire().resolve(entry);
}

export function adapterEntry(adapter: ToolAdapter): string {
  if (!adapter.entry) throw new Error(`${adapter.name} is started by its own command`);
  return resolveAdapterEntry(adapter.entry);
}

export function adapterLaunchCommand(
  adapter: ToolAdapter,
  execPath: string = process.execPath,
  metaDir: string = import.meta.dir,
): string[] {
  if (adapter.command) return [...adapter.command];
  if (adapter.internalSubcommand) {
    if (isCompiledBinary(metaDir)) {
      return [execPath, adapter.internalSubcommand];
    }
    if (adapter.entry) resolveAdapterEntry(adapter.entry, execPath, metaDir);
    if (!adapter.internalSourceFile) {
      throw new Error(`Missing internal source module for ${adapter.internalSubcommand}`);
    }
    return [findBunRuntime(execPath, metaDir), join(metaDir, adapter.internalSourceFile)];
  }
  return [findJsRuntime(execPath, metaDir), resolveAdapterEntry(adapter.entry ?? "", execPath, metaDir)];
}
