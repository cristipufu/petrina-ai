// Compile Petrina's standalone engine binary (`petrina-engine`) for desktop bundling and release staging.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ShellMessage } from "./launch.js";
import { ReleaseStore } from "./release-store.js";

export function engineBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "petrina-engine.exe" : "petrina-engine";
}

export function codexWrapperName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "codex-background.cmd" : "codex-background";
}

export function writeCodexWrapper(dir: string, platform: NodeJS.Platform = process.platform): string {
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, codexWrapperName(platform));
  if (platform === "win32") {
    writeFileSync(filePath, '@echo off\r\n"%~dp0petrina-engine.exe" __internal-codex-background %*\r\n', "utf8");
  } else {
    writeFileSync(
      filePath,
      '#!/bin/sh\nDIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec "$DIR/petrina-engine" __internal-codex-background "$@"\n',
      "utf8",
    );
    chmodSync(filePath, 0o755);
  }
  return filePath;
}

export interface BuildCompiledEngineOptions {
  readonly outDir?: string;
  readonly entrypoint?: string;
  readonly platform?: NodeJS.Platform;
}

export interface BuiltEngineArtifacts {
  readonly outDir: string;
  readonly binaryPath: string;
  readonly wrapperPath: string;
}

export async function buildCompiledEngine(options: BuildCompiledEngineOptions = {}): Promise<BuiltEngineArtifacts> {
  const repoRoot = resolve(import.meta.dir, "../../..");
  const platform = options.platform ?? process.platform;
  const entrypoint = resolve(options.entrypoint ?? join(import.meta.dir, "cli.ts"));
  const outDir = resolve(options.outDir ?? join(repoRoot, "apps/desktop/src-tauri/resources/engine"));
  mkdirSync(outDir, { recursive: true });
  const binaryPath = join(outDir, engineBinaryName(platform));

  const compileWorkDir = mkdtempSync(join(tmpdir(), "petrina-bun-compile-"));
  let code: number;
  let stdout: string;
  let stderr: string;
  try {
    const proc = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        "--external",
        "chromium-bidi/*",
        "--external",
        "electron",
        entrypoint,
        "--outfile",
        binaryPath,
      ],
      {
        cwd: compileWorkDir,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        windowsHide: true,
      },
    );
    [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
  } finally {
    rmSync(compileWorkDir, { recursive: true, force: true });
  }
  if (code !== 0 || !existsSync(binaryPath)) {
    throw new Error(`bun build --compile failed (exit ${code}):\n${stderr || stdout}`);
  }
  if (platform !== "win32") chmodSync(binaryPath, 0o755);
  const wrapperPath = writeCodexWrapper(outDir, platform);
  return { outDir, binaryPath, wrapperPath };
}

async function readFirstJsonLine(stream: ReadableStream<Uint8Array>, timeoutMs: number): Promise<ShellMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const deadline = setTimeout(() => {
    void reader.cancel("Timed out waiting for compiled engine ready handshake");
  }, timeoutMs);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffered += decoder.decode(value, { stream: !done });
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        return JSON.parse(line) as ShellMessage;
      }
      if (done) throw new Error(`Compiled engine exited before sending handshake (output: ${buffered})`);
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
}

export async function verifyCompiledEngine(outDir: string): Promise<void> {
  const tempRoot = mkdtempSync(join(tmpdir(), "petrina-compiled-verify-"));
  try {
    const home = join(tempRoot, "home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const gitconfig = join(tempRoot, "gitconfig");
    writeFileSync(gitconfig, "", "utf8");

    const store = new ReleaseStore(home);
    const staged = store.stage("0.1.0-verify", outDir);
    if (staged.kind !== "binary") {
      throw new Error(`Expected staged compiled release kind 'binary', got '${staged.kind}'.`);
    }
    const promoted = store.promote("0.1.0-verify");
    if (promoted.current.kind !== "binary") {
      throw new Error(`Expected promoted compiled release kind 'binary', got '${promoted.current.kind}'.`);
    }

    const command = store.commandFor(promoted.current, ["app"]);
    const child = Bun.spawn(command, {
      cwd: tempRoot,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
        TMPDIR: tempRoot,
        TMP: tempRoot,
        TEMP: tempRoot,
        HOME: home,
        USERPROFILE: home,
        PETRINA_HOME: home,
        XDG_CONFIG_HOME: join(tempRoot, "xdg"),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: gitconfig,
      },
    });
    try {
      const handshake = await readFirstJsonLine(child.stdout, 15_000);
      if (handshake.type !== "ready" || !handshake.owned) {
        throw new Error(`Unexpected compiled engine handshake: ${JSON.stringify(handshake)}`);
      }
      const api = handshake.url.replace(/^ws:/, "http:").replace(/\/ws$/, "");
      const healthRes = await fetch(`${api}/api/health`, {
        headers: { authorization: `Bearer ${handshake.token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (!healthRes.ok) {
        throw new Error(`Compiled engine /api/health returned HTTP ${healthRes.status}`);
      }
      const health = (await healthRes.json()) as { ok?: unknown; pid?: unknown };
      if (health.ok !== true || health.pid !== child.pid) {
        throw new Error(`Unexpected compiled engine /api/health payload: ${JSON.stringify(health)}`);
      }
      child.stdin.end();
      const exitCode = await Promise.race([
        child.exited,
        Bun.sleep(10_000).then(() => -1),
      ]);
      if (exitCode !== 0) {
        const stderr = await new Response(child.stderr).text().catch(() => "");
        throw new Error(`Compiled engine did not exit cleanly after stdin EOF (code ${exitCode}): ${stderr}`);
      }
    } finally {
      try {
        child.stdin.end();
      } catch {
        // Already closed.
      }
      if (child.exitCode === null) child.kill();
      await child.exited.catch(() => undefined);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function runBuildEngineCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const outFlag = args.indexOf("--out");
  const outDir = outFlag >= 0 ? args[outFlag + 1] : undefined;
  const verify = args.includes("--verify");
  const built = await buildCompiledEngine(outDir ? { outDir } : {});
  console.log(`Built standalone engine binary: ${built.binaryPath}`);
  if (verify) {
    await verifyCompiledEngine(built.outDir);
    console.log("Verified standalone engine binary boot, /api/health, ReleaseStore staging, and cooperative shutdown.");
  }
}

if (import.meta.main) await runBuildEngineCli();
