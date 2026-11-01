// Compile Petrina's standalone engine binary (`petrina-engine`) for desktop bundling and release staging.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EMBEDDED_ACP_TARGETS } from "@petrina/agent-runtime";
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

export function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function writeSha256Sums(dir: string, fileNames?: readonly string[]): string {
  const names = (
    fileNames
      ? [...fileNames]
      : readdirSync(dir).filter((name) => name !== "SHA256SUMS.txt" && statSync(join(dir, name)).isFile())
  ).sort();
  const lines = names.map((name) => `${sha256File(join(dir, name))}  ${name}`);
  const checksumsPath = join(dir, "SHA256SUMS.txt");
  writeFileSync(checksumsPath, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  return checksumsPath;
}

export function engineReleaseArchiveName(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const cleanVersion = version.trim().replace(/^v/, "") || "0.1.0";
  const ext = platform === "win32" ? "zip" : "tar.gz";
  return `petrina-engine-${cleanVersion}-${platform}-${arch}.${ext}`;
}

export interface PackageEngineReleaseOptions {
  readonly bundleDir: string;
  readonly releaseDir: string;
  readonly version: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

export interface PackagedEngineRelease {
  readonly archivePath: string;
  readonly checksumsPath: string;
}

export async function packageEngineRelease(options: PackageEngineReleaseOptions): Promise<PackagedEngineRelease> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  mkdirSync(options.releaseDir, { recursive: true });
  const archiveName = engineReleaseArchiveName(options.version, platform, arch);
  const archivePath = join(options.releaseDir, archiveName);
  rmSync(archivePath, { force: true });

  const entries = readdirSync(options.bundleDir)
    .filter((name) => !name.startsWith("."))
    .sort();
  if (!entries.length) {
    throw new Error(`Cannot package empty engine bundle directory: ${options.bundleDir}`);
  }
  const tarArgs =
    platform === "win32"
      ? ["tar", "-a", "-cf", archivePath, "-C", options.bundleDir, ...entries]
      : ["tar", "-czf", archivePath, "-C", options.bundleDir, ...entries];
  const proc = Bun.spawn(tarArgs, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (code !== 0 || !existsSync(archivePath)) {
    throw new Error(`Failed to package engine release archive (exit ${code}): ${stderr}`);
  }
  const checksumsPath = writeSha256Sums(options.releaseDir);
  return { archivePath, checksumsPath };
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
        "--external",
        "@anthropic-ai/claude-agent-sdk-*",
        "--external",
        "@openai/codex*",
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

async function verifyEmbeddedAcpTranslators(binaryPath: string, tempRoot: string): Promise<void> {
  const isolatedEnv = {
    PATH: "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
    TMPDIR: tempRoot,
    TMP: tempRoot,
    TEMP: tempRoot,
    HOME: tempRoot,
    USERPROFILE: tempRoot,
  };

  const cliVersionRun = Bun.spawn([binaryPath, "--version"], {
    cwd: tempRoot,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: isolatedEnv,
  });
  const [cliCode, cliStdout, cliStderr] = await Promise.all([
    cliVersionRun.exited,
    new Response(cliVersionRun.stdout).text(),
    new Response(cliVersionRun.stderr).text(),
  ]);
  if (cliCode !== 0 || !cliStdout.trim().startsWith("petrina ")) {
    throw new Error(`Compiled petrina --version failed (exit ${cliCode}): ${cliStderr || cliStdout}`);
  }

  for (const { subcommand } of EMBEDDED_ACP_TARGETS) {
    const versionRun = Bun.spawn([binaryPath, subcommand, "--version"], {
      cwd: tempRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: isolatedEnv,
    });
    const [code, stdout, stderr] = await Promise.all([
      versionRun.exited,
      new Response(versionRun.stdout).text(),
      new Response(versionRun.stderr).text(),
    ]);
    if (code !== 0 || !stdout.trim()) {
      throw new Error(`Embedded ${subcommand} --version failed (exit ${code}): ${stderr || stdout}`);
    }
  }

  for (const { subcommand, cli: cliName } of EMBEDDED_ACP_TARGETS) {
    const missingCliRun = Bun.spawn([binaryPath, subcommand], {
      cwd: tempRoot,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
      env: isolatedEnv,
    });
    const [code, stdout, stderr] = await Promise.all([
      missingCliRun.exited,
      new Response(missingCliRun.stdout).text(),
      new Response(missingCliRun.stderr).text(),
    ]);
    const combined = `${stdout}\n${stderr}`;
    if (code === 0 || !combined.includes(`no \`${cliName}\` on PATH`)) {
      throw new Error(
        `Embedded ${subcommand} did not require installed \`${cliName}\` on PATH (exit ${code}): ${combined}`,
      );
    }
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

    await verifyEmbeddedAcpTranslators(promoted.current.entrypoint, tempRoot);

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

function defaultDesktopVersion(): string {
  const pkgPath = resolve(import.meta.dir, "../../../apps/desktop/package.json");
  const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
  return parsed.version ?? "0.1.0";
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

export async function runBuildEngineCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  const checksumsOnlyDir = flagValue(args, "--checksums-only");
  if (checksumsOnlyDir) {
    const checksumsPath = writeSha256Sums(resolve(checksumsOnlyDir));
    console.log(`Wrote SHA-256 checksums: ${checksumsPath}`);
    return;
  }

  const outDir = flagValue(args, "--out");
  const releaseDir = flagValue(args, "--package-release");
  const version = flagValue(args, "--version") ?? defaultDesktopVersion();
  const verify = args.includes("--verify");

  const built = await buildCompiledEngine(outDir ? { outDir } : {});
  console.log(`Built standalone engine binary: ${built.binaryPath}`);
  if (verify) {
    await verifyCompiledEngine(built.outDir);
    const embeddedNames = EMBEDDED_ACP_TARGETS.map((target) => target.name).join("/");
    console.log(
      `Verified standalone engine binary boot, embedded ${embeddedNames} ACP translators, /api/health, ReleaseStore staging, and cooperative shutdown.`,
    );
  }
  if (releaseDir) {
    const packaged = await packageEngineRelease({
      bundleDir: built.outDir,
      releaseDir: resolve(releaseDir),
      version,
    });
    console.log(`Packaged standalone engine release: ${packaged.archivePath} (${packaged.checksumsPath})`);
  }
}

if (import.meta.main) await runBuildEngineCli();
