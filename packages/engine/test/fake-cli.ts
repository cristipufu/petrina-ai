// The agent's own app (Claude Code or Codex) for take-over tests: what the launcher opens in the
// terminal. It notes how it was started, adds a turn to the conversation the way the real app does
// (in the fake agent's conversation files), stays open while the hold file exists, and changes the
// working copy the way dir/cli.json says: some files committed by hand, some left unsaved.
//
// bun fake-cli.ts <dir> <the tool's arguments...>
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

export interface CliScript {
  /** Stay open while this file exists. */
  hold?: string;
  /** The test worker that owns this fake terminal session. The fake exits if the suite is interrupted. */
  ownerPid?: number;
  /** Files to commit, one commit each, as the coordinator would by hand. */
  commit?: Record<string, string>;
  /** Files to leave changed but not committed. */
  write?: Record<string, string>;
}

const [dir, ...args] = process.argv.slice(2);
// Asked for its help, as Petrina does to learn the name of Claude Code's ask-before-acting mode.
if (args[0] === "--help") {
  console.log(existsSync(join(dir!, "old-help")) ? '--permission-mode <mode> (choices: "acceptEdits", "bypassPermissions", "default", "plan")' : '--permission-mode <mode> (choices: "acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan")');
  process.exit(0);
}
const script: CliScript = existsSync(join(dir!, "cli.json")) ? JSON.parse(readFileSync(join(dir!, "cli.json"), "utf8")) : {};
appendFileSync(join(dir!, "cli.jsonl"), `${JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env) })}\n`);
writeFileSync(join(dir!, "cli-started"), String(Date.now()));

const at = args.indexOf("--resume") >= 0 ? args.indexOf("--resume") : args.indexOf("resume");
const session = args[at + 1];
const file = join(dir!, "conversations", `${session}.json`);
if (session && existsSync(file)) {
  const conversation = JSON.parse(readFileSync(file, "utf8"));
  conversation.history.push({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Typed in the terminal: make it blue" } });
  conversation.terminal = (conversation.terminal ?? 0) + 1;
  writeFileSync(file, JSON.stringify(conversation));
}

while (script.hold && existsSync(script.hold)) {
  if (script.ownerPid !== undefined) {
    try {
      process.kill(script.ownerPid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
    }
  }
  await Bun.sleep(50);
}
const git = (...rest: string[]) => execFileSync("git", rest, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
for (const [name, text] of Object.entries(script.commit ?? {})) {
  writeFileSync(join(process.cwd(), name), text);
  git("add", name);
  git("commit", "--quiet", "-m", `By hand: ${name}`);
}
for (const [name, text] of Object.entries(script.write ?? {})) writeFileSync(join(process.cwd(), name), text);
writeFileSync(join(dir!, "cli-done"), String(Date.now()));
