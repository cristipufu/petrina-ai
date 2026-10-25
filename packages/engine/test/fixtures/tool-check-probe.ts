// A fresh command runner for each private home. At most this process and one stand-in run at once.
// No installed Git, Node.js, Apple tools or GitHub account is consulted.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkNode } from "../../src/setup.js";
import { checkGh, checkGit } from "@petrina/repositories/tool-readiness";
import { run } from "@petrina/repositories/git";

const [root, limitText] = process.argv.slice(2);
if (!root || !limitText) throw new Error("A private folder and check deadline are required");
const limit = Number(limitText);
const tools = join(root, "developer-tools");
mkdirSync(join(tools, "usr", "bin"), { recursive: true });
writeFileSync(join(tools, "usr", "bin", "git"), "stand-in");
const spawn = Bun.spawn;
const children: ReturnType<typeof Bun.spawn>[] = [];
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await Promise.all(children.map(child => child.exited));
  process.exit(1);
}
// Losing the owning test closes stdin, even if its finally block cannot run.
process.stdin.resume();
process.stdin.on("end", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
const deadline = setTimeout(() => void stop(), limit * 8);
// Only the two Apple commands are replaced. All preparation and spawning still use the real runner.
Bun.spawn = ((cmd: string[], options: Parameters<typeof Bun.spawn>[1]) => {
  if (children.some(child => child.exitCode === null && child.signalCode === null)) throw new Error("Probe process cap exceeded");
  const replacement = cmd[0] === "/usr/bin/xcode-select" ? [process.execPath, "-e", `console.log(${JSON.stringify(tools)})`]
    : cmd[0] === "/usr/bin/git" ? [process.execPath, "--version"] : cmd;
  const child = spawn(replacement, options);
  children.push(child);
  return child;
}) as typeof Bun.spawn;
try {
  const raw = await run([process.execPath, "--version"], root, undefined, { timeoutMs: limit });
  const git = await checkGit(() => process.execPath, "linux", { timeoutMs: limit });
  const macGit = await checkGit(() => "/usr/bin/git", "darwin", { timeoutMs: limit });
  const node = await checkNode(() => process.execPath, limit);
  const gh = await checkGh([process.execPath, "-e", 'console.log("Logged in to github.com account fixture-user")', "--"], limit);
  console.log(JSON.stringify({ raw, git, macGit, node, gh }));
} finally {
  Bun.spawn = spawn;
  clearTimeout(deadline);
  process.stdin.pause();
  await Promise.all(children.map(child => child.exited));
}
