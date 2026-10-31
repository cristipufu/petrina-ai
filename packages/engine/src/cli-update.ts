// Standalone `petrina update` command: downloads and SHA-256-verifies the latest published CLI binary.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCompiledBinary } from "@petrina/platform/compiled-runtime";

export const DEFAULT_RELEASE_BASE_URL = "https://github.com/cristipufu/petrina-ai/releases/latest/download";

export function cliReleaseAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  if (platform === "darwin" && arch === "arm64") return "petrina-cli-macos-arm64";
  if (platform === "darwin" && arch === "x64") return "petrina-cli-macos-x64";
  if (platform === "linux" && arch === "x64") return "petrina-cli-linux-x86_64";
  if (platform === "win32" && arch === "x64") return "petrina-cli-windows-x64.exe";
  throw new Error(`No prebuilt standalone petrina CLI release is published for ${platform}/${arch}.`);
}

export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!match) continue;
    sums.set(match[2]!.trim(), match[1]!.toLowerCase());
  }
  return sums;
}

function sha256Buffer(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isInsideDesktopBundle(resolvedTarget: string): boolean {
  const normalized = resolvedTarget.replaceAll("\\", "/");
  return normalized.includes(".app/Contents/");
}

export interface CliUpdateOptions {
  readonly execPath?: string;
  readonly metaDir?: string;
  readonly baseUrl?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
}

export async function updateStandaloneCli(options: CliUpdateOptions = {}): Promise<void> {
  const metaDir = options.metaDir ?? import.meta.dir;
  if (!isCompiledBinary(metaDir)) {
    throw new Error(
      "This copy of Petrina runs from source. Pull the latest repository changes instead of running `petrina update`.",
    );
  }
  const rawExecPath = options.execPath ?? process.execPath;
  const targetPath = existsSync(rawExecPath) ? realpathSync(rawExecPath) : rawExecPath;
  if (isInsideDesktopBundle(targetPath)) {
    throw new Error(
      "This `petrina` command is bundled inside Petrina.app and updates automatically with the Petrina desktop app.",
    );
  }
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const assetName = cliReleaseAssetName(platform, arch);
  const baseUrl = (
    options.baseUrl ??
    process.env.PETRINA_RELEASE_BASE_URL ??
    DEFAULT_RELEASE_BASE_URL
  ).replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? console.log;

  const sumsResponse = await fetchImpl(`${baseUrl}/SHA256SUMS.txt`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!sumsResponse.ok) {
    throw new Error(`Could not fetch release checksums (HTTP ${sumsResponse.status}).`);
  }
  const sums = parseSha256Sums(await sumsResponse.text());
  const expectedHash = sums.get(assetName);
  if (!expectedHash) {
    throw new Error(`Release checksums do not list ${assetName}.`);
  }

  if (existsSync(targetPath)) {
    const currentHash = sha256Buffer(readFileSync(targetPath));
    if (currentHash === expectedHash) {
      log("petrina is already up to date.");
      return;
    }
  }

  const binaryResponse = await fetchImpl(`${baseUrl}/${assetName}`, {
    signal: AbortSignal.timeout(180_000),
  });
  if (!binaryResponse.ok) {
    throw new Error(`Could not download ${assetName} (HTTP ${binaryResponse.status}).`);
  }
  const downloaded = new Uint8Array(await binaryResponse.arrayBuffer());
  const actualHash = sha256Buffer(downloaded);
  if (actualHash !== expectedHash) {
    throw new Error("Downloaded update failed SHA-256 verification; kept the existing petrina binary.");
  }

  const dir = dirname(targetPath);
  const stagingPath = join(dir, `.petrina-update-${process.pid}-${Date.now()}`);
  const backupPath = `${targetPath}.old`;
  try {
    writeFileSync(stagingPath, downloaded);
    if (platform !== "win32") chmodSync(stagingPath, 0o755);
    if (platform === "win32" && existsSync(targetPath)) {
      rmSync(backupPath, { force: true });
      renameSync(targetPath, backupPath);
      try {
        renameSync(stagingPath, targetPath);
      } catch (swapError) {
        if (!existsSync(targetPath) && existsSync(backupPath)) {
          renameSync(backupPath, targetPath);
        }
        throw swapError;
      }
      try {
        rmSync(backupPath, { force: true });
      } catch {
        // Running executable backup on Windows is cleaned up on next update.
      }
    } else {
      renameSync(stagingPath, targetPath);
    }
    log("Updated petrina to the latest release.");
  } finally {
    rmSync(stagingPath, { force: true });
  }
}
