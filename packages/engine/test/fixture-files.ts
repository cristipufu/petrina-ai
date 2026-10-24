// Native filesystem differences belong here, not in each workflow fixture.
import { realpathSync, symlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface FixtureFiles {
  /** The native spelling, including expanded Windows short names and resolved aliases. */
  canonical(path: string): string;
  /** A directory alias. Windows junctions do not require Developer Mode's symlink permission. */
  directoryLink(target: string, path: string): void;
  /** An actual file symlink, including relative chains and missing targets. Requires native symlink support. */
  fileLink(target: string, path: string): void;
}

export const fixtureFiles: FixtureFiles = {
  canonical: (path) => realpathSync.native(path),
  directoryLink(target, path) {
    if (process.platform === "win32") symlinkSync(resolve(dirname(path), target), path, "junction");
    else symlinkSync(target, path, "dir");
  },
  fileLink: (target, path) => symlinkSync(target, path, "file"),
};
