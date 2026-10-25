import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commandText } from "../../src/checks.js";

/** A private real check process: caller-controlled outcomes and an invocation log outside Git restoration. */
export function checkCommand(root: string) {
  const file = join(root, "check.ts");
  const log = join(root, "runs.txt");
  // Count actual command invocations outside the working copy, where restoring tracked files cannot hide one.
  // "--sequence=PFFP": the nth actual run passes or fails by its letter; later runs repeat the last one.
  writeFileSync(file, `import { appendFileSync, existsSync, readFileSync } from "node:fs";
const sequence = process.argv.find((arg) => arg.startsWith("--sequence="))?.slice(11);
const earlier = existsSync(process.argv[2]) ? readFileSync(process.argv[2], "utf8").split("\\n").filter((line) => line === "passed" || line === "failed").length : 0;
const ok = sequence ? sequence[Math.min(earlier, sequence.length - 1)] === "P" : process.argv.includes("--pass") || existsSync("welcome.txt");
if (process.argv.includes("--hold")) {
  appendFileSync(process.argv[2], "started\\n");
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
appendFileSync(process.argv[2], ok ? "passed\\n" : "failed\\n");
console.log(ok ? "The welcome page works" : "The welcome page is missing (captured failure)");
process.exit(ok ? 0 : 1);
`);
  return {
    file, log,
    command: (...args: string[]) => commandText([process.execPath, file, log, ...args]),
    runs: () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [],
  };
}
