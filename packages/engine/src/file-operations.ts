// Portable storage effects. Owners choose and validate paths before asking for an effect.
import { copyFile, rm } from "node:fs/promises";

export interface FileOperations {
  copyFile(source: string, destination: string): Promise<void>;
  /** Remove an owned tree, including an already absent one. Never follows directory links. */
  removeTree(path: string): Promise<void>;
}

export const localFiles: FileOperations = {
  copyFile: (source, destination) => copyFile(source, destination),
  removeTree: path => rm(path, { recursive: true, force: true }),
};
