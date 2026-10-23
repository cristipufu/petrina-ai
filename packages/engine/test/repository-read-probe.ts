// A fresh command runner for each private home, with at most one command child at a time.
import { canSee } from "../src/github.js";
import { fileAt } from "../src/git.js";

const [root, limitText] = process.argv.slice(2);
if (!root || !limitText) throw new Error("A private repository and deadline are required");
const limit = Number(limitText);
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
// A lost test owner closes stdin even when its cleanup cannot run.
process.stdin.resume();
process.stdin.on("end", () => void stop());
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
const deadline = setTimeout(() => void stop(), limit * 8);
Bun.spawn = ((cmd: string[], options: Parameters<typeof Bun.spawn>[1]) => {
  if (children.some(child => child.exitCode === null && child.signalCode === null)) throw new Error("Probe process cap exceeded");
  const child = spawn(cmd, options);
  children.push(child);
  return child;
}) as typeof Bun.spawn;
try {
  const lookup = await canSee("example/project", [process.execPath, "-e", 'console.log("example/project")', "--"]);
  let savedFile;
  try { savedFile = { ok: true, text: await fileAt(root, "HEAD", "README.md", limit) }; }
  catch (error) {
    if (!(error instanceof Error)) throw error;
    savedFile = { ok: false, message: error.message, cause: error.cause };
  }
  console.log(JSON.stringify({ lookup, savedFile, started: children.length }));
} finally {
  Bun.spawn = spawn;
  clearTimeout(deadline);
  process.stdin.pause();
  await Promise.all(children.map(child => child.exited));
}
