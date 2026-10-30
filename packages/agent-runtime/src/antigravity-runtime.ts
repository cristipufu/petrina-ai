// Google's official ACP distribution contains the server and its sibling agent harness.
// Installation is explicit; a tool check never downloads software or opens a sign-in window.
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const ANTIGRAVITY_VERSION = "1.4.1";
const root = () => join(process.env.PETRINA_HOME || join(homedir(), ".petrina"), "tools", "antigravity");
const executable = () => process.platform === "win32" ? "agy_acp_server.exe" : "agy_acp_server.par";

export function antigravityCommand(): readonly string[] {
  const file = join(root(), ANTIGRAVITY_VERSION, executable());
  return [file, ...(process.platform === "linux" ? ["--uid="] : [])];
}

export function antigravityInstalled(): boolean {
  const dir = join(root(), ANTIGRAVITY_VERSION);
  return existsSync(join(dir, executable())) && existsSync(join(dir, process.platform === "win32" ? "localharness_external.exe" : "localharness_external"));
}

/** The pinned server has no session/delete endpoint. Remove only the known probe's
 * conversation files after its harness has exited; agent conversations stay resumable. */
export async function forgetAntigravityProbe(sessionId: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId)) return;
  const dir = join(env.GEMINI_HOME || join(homedir(), ".gemini"), "antigravity-acp", "conversations");
  await Promise.all([".db", ".db-wal", ".db-shm", ".meta"].map(suffix => rm(join(dir, `${sessionId}${suffix}`), { force: true })));
}

/** The pinned native build published by Google in the ACP registry. No third-party wrapper. */
export async function installAntigravity(): Promise<void> {
  if (antigravityInstalled()) return;
  const platform = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform as "darwin" | "linux" | "win32"];
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : undefined;
  if (!platform || !arch) throw new Error("Google does not publish an Antigravity connector for this machine.");
  await mkdir(root(), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(root(), ".install-"));
  try {
    const os = process.platform === "win32" ? "windows" : process.platform;
    const response = await fetch(
      `https://dl.google.com/agy-extensions/releases/${platform}/agy-acp-server-${ANTIGRAVITY_VERSION}-${os}-${arch}.zip`,
      { signal: AbortSignal.timeout(180_000) }
    );
    if (!response.ok) throw new Error(`Google's connector download failed (${response.status}).`);
    const archive = join(staging, "server.zip");
    await Bun.write(archive, response);
    const command = process.platform === "win32" ? ["tar", "-xf", archive, "-C", staging] : ["unzip", "-q", archive, "-d", staging];
    const unpack = Bun.spawn(command, { stdout: "ignore", stderr: "ignore", windowsHide: true });
    if (await unpack.exited !== 0) throw new Error("Could not unpack Google's Antigravity connector.");
    const files = [executable(), process.platform === "win32" ? "localharness_external.exe" : "localharness_external"];
    if (!files.every(file => existsSync(join(staging, file)))) throw new Error("Google's connector download is missing its agent harness.");
    for (const file of files) await chmod(join(staging, file), 0o700);
    await rm(archive);
    // Replace a previously incomplete installation only after a complete download is ready.
    if (antigravityInstalled()) return;
    await rm(join(root(), ANTIGRAVITY_VERSION), { recursive: true, force: true });
    await rename(staging, join(root(), ANTIGRAVITY_VERSION));
  } finally { await rm(staging, { recursive: true, force: true }); }
}
