import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "bun:test";
import { expectRejection } from "@petrina/test-support/rejections";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { cliReleaseAssetName, parseSha256Sums, updateStandaloneCli } from "../../../src/cli-update.js";
import { PETRINA_CLI_VERSION, runCli } from "../../../src/cli.js";

const root = tempDir("petrina-cli-update-");
afterAll(() => removeDir(root));

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

describe("standalone petrina CLI version and self-update", () => {
  it("maps supported platforms and parses SHA256SUMS.txt lines", () => {
    expect(cliReleaseAssetName("darwin", "arm64")).toBe("petrina-cli-macos-arm64");
    expect(cliReleaseAssetName("darwin", "x64")).toBe("petrina-cli-macos-x64");
    expect(cliReleaseAssetName("linux", "x64")).toBe("petrina-cli-linux-x86_64");
    expect(cliReleaseAssetName("win32", "x64")).toBe("petrina-cli-windows-x64.exe");
    expect(() => cliReleaseAssetName("freebsd", "x64")).toThrow("No prebuilt standalone petrina CLI release");

    const hashA = "a".repeat(64);
    const hashB = "B".repeat(64);
    const parsed = parseSha256Sums(`${hashA}  petrina-cli-macos-arm64\n${hashB} *petrina-cli-windows-x64.exe\n`);
    expect(parsed.get("petrina-cli-macos-arm64")).toBe(hashA);
    expect(parsed.get("petrina-cli-windows-x64.exe")).toBe(hashB.toLowerCase());
  });

  it("prints petrina --version without contacting an engine", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await runCli(["--version"]);
    } finally {
      console.log = originalLog;
    }
    expect(lines).toEqual([`petrina ${PETRINA_CLI_VERSION}`]);
  });

  it("refuses petrina update from a source checkout or inside a macOS .app bundle", async () => {
    await expectRejection(
      updateStandaloneCli({ metaDir: "/Users/dev/petrina/packages/engine/src" }),
      "runs from source",
    );

    const bundleBinDir = join(root, "Petrina.app", "Contents", "Resources", "engine");
    mkdirSync(bundleBinDir, { recursive: true });
    const bundledBinary = join(bundleBinDir, "petrina-engine");
    writeFileSync(bundledBinary, "bundled-v1", "utf8");

    await expectRejection(
      updateStandaloneCli({
        metaDir: "/$bunfs/root",
        execPath: bundledBinary,
      }),
      "bundled inside Petrina.app",
    );
  });

  it("verifies SHA-256 checksums before replacing the standalone binary and skips downloads when current", async () => {
    const installDir = join(root, "bin");
    mkdirSync(installDir, { recursive: true });
    const binaryPath = join(installDir, "petrina");
    writeFileSync(binaryPath, "binary-v1", "utf8");

    const nextPayload = "binary-v2-verified";
    const nextHash = sha256(nextPayload);
    const asset = "petrina-cli-macos-arm64";
    const sumsBody = `${nextHash}  ${asset}\n`;

    const tamperedFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/SHA256SUMS.txt")) return new Response(sumsBody, { status: 200 });
      return new Response("tampered-payload", { status: 200 });
    }) as typeof fetch;

    await expectRejection(
      updateStandaloneCli({
        metaDir: "/$bunfs/root",
        execPath: binaryPath,
        platform: "darwin",
        arch: "arm64",
        baseUrl: "https://releases.invalid/download",
        fetchImpl: tamperedFetch,
      }),
      "failed SHA-256 verification",
    );
    expect(readFileSync(binaryPath, "utf8")).toBe("binary-v1");

    let downloads = 0;
    const validFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/SHA256SUMS.txt")) return new Response(sumsBody, { status: 200 });
      downloads++;
      return new Response(nextPayload, { status: 200 });
    }) as typeof fetch;

    const logs: string[] = [];
    await updateStandaloneCli({
      metaDir: "/$bunfs/root",
      execPath: binaryPath,
      platform: "darwin",
      arch: "arm64",
      baseUrl: "https://releases.invalid/download",
      fetchImpl: validFetch,
      log: (line) => logs.push(line),
    });
    expect(existsSync(binaryPath)).toBe(true);
    expect(readFileSync(binaryPath, "utf8")).toBe(nextPayload);
    expect(downloads).toBe(1);
    expect(logs).toEqual(["Updated petrina to the latest release."]);

    const repeatLogs: string[] = [];
    await updateStandaloneCli({
      metaDir: "/$bunfs/root",
      execPath: binaryPath,
      platform: "darwin",
      arch: "arm64",
      baseUrl: "https://releases.invalid/download",
      fetchImpl: validFetch,
      log: (line) => repeatLogs.push(line),
    });
    expect(downloads).toBe(1);
    expect(repeatLogs).toEqual(["petrina is already up to date."]);
  });
});
