// Antigravity (`agy`) probe cleanup. Petrina uses the coordinator's installed `agy` CLI
// directly without downloading a separate connector or storing separate credentials.
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Remove an init-only readiness/account probe folder after `agy` exits so probes do not clutter
 * `~/.gemini/antigravity-cli/brain/`; real conversations (with `transcript.jsonl`) stay resumable. */
export async function forgetAntigravityProbe(sessionId: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) return;
  const home = env.HOME || env.USERPROFILE || homedir();
  const cliHome = env.ANTIGRAVITY_CLI_HOME || join(env.GEMINI_HOME || join(home, ".gemini"), "antigravity-cli");
  const brainDir = join(cliHome, "brain", sessionId);
  if (!existsSync(brainDir)) return;
  if (existsSync(join(brainDir, ".system_generated", "logs", "transcript.jsonl"))) return;
  await rm(brainDir, { recursive: true, force: true });
}
