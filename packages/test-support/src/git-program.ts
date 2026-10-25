import { quoteGitShellWord } from "./git-shell-word.js";
export { quoteGitShellWord } from "./git-shell-word.js";
import { chmodSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A real program invoked through Git's own shell/hook boundary, never a workflow substitute. */
export interface GitProgram {
  readonly command: string;
  marks(): string[];
  clear(): void;
  writeHook(file: string): void;
}


/** Format literal arguments for Git's shell boundary; native Windows paths accept forward slashes. */
export function gitCommand(argv: readonly (string | { path: string })[]): string {
  return argv.map(word => quoteGitShellWord(typeof word === "string" ? word : word.path.replaceAll("\\", "/"))).join(" ");
}

/** A Git-invoked script, using the shell supplied by Git on Windows as well as Unix. */
export function writeGitProgram(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

/** Git for Windows supplies the same shell boundary; native paths there also accept forward slashes. */
export function plantedGitProgram(folder: string, name: string): GitProgram {
  const marks = join(folder, "marks"), marker = join(marks, name), script = join(folder, `${name}.ts`);
  mkdirSync(marks, { recursive: true });
  writeFileSync(script, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\nprocess.exit(1);\n`);
  const command = gitCommand([{ path: process.execPath }, { path: script }]);
  return {
    command,
    marks: () => readdirSync(marks).sort(),
    clear: () => rmSync(marker, { force: true }),
    writeHook(file) {
      writeGitProgram(file, `exec ${command} "$@"`);
    },
  };
}
