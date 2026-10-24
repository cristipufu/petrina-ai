import { resolve } from "node:path";
import { localFiles, type FileOperations } from "@petrina/platform/file-operations";

/** Per-fixture storage failures, independent of accounts, privilege and OS permission semantics. */
export class FileFaults {
  private readonly deniedCopies = new Set<string>();
  private readonly deniedRemovals = new Set<string>();
  readonly files: FileOperations = {
    copyFile: async (source, destination) => {
      this.check(this.deniedCopies, source);
      await localFiles.copyFile(source, destination);
    },
    removeTree: async path => {
      this.check(this.deniedRemovals, path);
      await localFiles.removeTree(path);
    },
  };

  blockCopy(source: string): () => void { return this.block(this.deniedCopies, source); }
  blockRemoval(path: string): () => void { return this.block(this.deniedRemovals, path); }

  private block(denied: Set<string>, path: string): () => void {
    const key = resolve(path);
    if (denied.has(key)) throw new Error(`The fixture already blocks ${key}`);
    denied.add(key);
    let released = false;
    return () => { if (!released) { released = true; denied.delete(key); } };
  }

  private check(denied: Set<string>, path: string): void {
    if (denied.has(resolve(path))) throw Object.assign(new Error("The fixture refused this file operation"), { code: "EACCES", path });
  }
}
