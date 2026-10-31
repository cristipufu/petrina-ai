import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultBrowserServerLaunch } from "@petrina/agent-runtime/browser";
import { ADAPTERS, codexWrapperPath } from "@petrina/agent-runtime/tool-catalog";
import { adapterLaunchCommand, GROK_AGENT_COMMAND, OPENCODE_AGENT_COMMAND, resolveAdapterEntry } from "@petrina/agent-runtime/tool-entry";
import {
  compiledExecutableDir,
  findBunRuntime,
  findJsRuntime,
  isCompiledBinary,
} from "@petrina/platform/compiled-runtime";
import {
  codexWrapperName,
  engineBinaryName,
  engineReleaseArchiveName,
  packageEngineRelease,
  sha256File,
  writeCodexWrapper,
  writeSha256Sums,
} from "../../../src/build-engine.js";
import { resolveDefaultUiDir } from "../../../src/cli.js";
import { defaultManagedSpawnCommand } from "../../../src/engine-client.js";
import { ReleaseStore } from "../../../src/release-store.js";
import { transitionFallbackCommand } from "../../../src/release-transition.js";
import { removeDir, tempDir } from "../../support.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) removeDir(root);
});

describe("standalone compiled engine runtime contracts", () => {
  it("detects Bun virtual filesystems across Unix and Windows and resolves external runtimes", () => {
    expect(isCompiledBinary("/workspace/packages/platform/src")).toBe(false);
    expect(isCompiledBinary("C:\\workspace\\packages\\platform\\src")).toBe(false);
    expect(isCompiledBinary("/$bunfs/root")).toBe(true);
    expect(isCompiledBinary("/$bunfs/root/packages/engine/src")).toBe(true);
    expect(isCompiledBinary("B:\\~BUN\\root")).toBe(true);
    expect(isCompiledBinary("C:/~BUN/root/entry")).toBe(true);

    expect(findBunRuntime("/usr/local/bin/bun", "/workspace/src")).toBe("/usr/local/bin/bun");
    expect(findBunRuntime("/Applications/Petrina.app/Contents/Resources/engine/petrina-engine", "/$bunfs/root")).not.toContain(
      "petrina-engine",
    );

    expect(findJsRuntime("/usr/local/bin/bun", "/workspace/src")).toBe("/usr/local/bin/bun");
    expect(findJsRuntime("/Applications/Petrina.app/Contents/Resources/engine/petrina-engine", "/$bunfs/root")).not.toContain(
      "petrina-engine",
    );
  });

  it("switches internal helper launches, UI discovery, and lifecycle respawn commands in compiled mode", () => {
    const root = tempDir("petrina-compiled-paths-");
    roots.push(root);

    const bundleDir = join(root, "resources", "engine");
    mkdirSync(bundleDir, { recursive: true });
    const binaryExec = join(bundleDir, "petrina-engine");
    writeFileSync(binaryExec, "#!/bin/sh\n", "utf8");
    const realBundleDir = compiledExecutableDir(binaryExec);
    const realBinaryExec = join(realBundleDir, "petrina-engine");

    const sourceBrowser = defaultBrowserServerLaunch("/tmp/session", "secret-1", 4242, "/usr/bin/bun", "/repo/packages/agent-runtime/src");
    expect(sourceBrowser).toEqual({
      command: "/usr/bin/bun",
      args: [join("/repo/packages/agent-runtime/src", "browser-server.ts"), "/tmp/session", "secret-1", "4242"],
      cwd: "/repo/packages/agent-runtime/src",
    });

    const compiledBrowser = defaultBrowserServerLaunch("/tmp/session", "secret-1", 4242, realBinaryExec, "/$bunfs/root");
    expect(compiledBrowser).toEqual({
      command: realBinaryExec,
      args: ["__internal-browser-server", "/tmp/session", "secret-1", "4242"],
      cwd: "/tmp/session",
    });

    expect(codexWrapperPath("/usr/bin/bun", "/repo/packages/agent-runtime/src", "darwin")).toBe(
      join("/repo/packages/agent-runtime/src", "codex-background.ts"),
    );
    expect(codexWrapperPath(realBinaryExec, "/$bunfs/root", "darwin")).toBe(join(realBundleDir, "codex-background"));
    expect(codexWrapperPath(realBinaryExec, "B:\\~BUN\\root", "win32")).toBe(join(realBundleDir, "codex-background.cmd"));

    expect(adapterLaunchCommand(ADAPTERS["claude-code"]!, "/usr/bin/bun", "/repo/packages/agent-runtime/src")).toEqual([
      "/usr/bin/bun",
      join("/repo/packages/agent-runtime/src", "claude-acp.ts"),
    ]);
    expect(adapterLaunchCommand(ADAPTERS.codex!, "/usr/bin/bun", "/repo/packages/agent-runtime/src")).toEqual([
      "/usr/bin/bun",
      join("/repo/packages/agent-runtime/src", "codex-acp.ts"),
    ]);
    expect(adapterLaunchCommand(ADAPTERS.antigravity!, "/usr/bin/bun", "/repo/packages/agent-runtime/src")).toEqual([
      "/usr/bin/bun",
      join("/repo/packages/agent-runtime/src", "agy-acp.ts"),
    ]);
    expect(adapterLaunchCommand(ADAPTERS.pi!, "/usr/bin/bun", "/repo/packages/agent-runtime/src")).toEqual([
      "/usr/bin/bun",
      join("/repo/packages/agent-runtime/src", "pi-acp.ts"),
    ]);
    expect(adapterLaunchCommand(ADAPTERS["claude-code"]!, realBinaryExec, "/$bunfs/root")).toEqual([
      realBinaryExec,
      "__internal-claude-acp",
    ]);
    expect(adapterLaunchCommand(ADAPTERS.codex!, realBinaryExec, "B:\\~BUN\\root")).toEqual([
      realBinaryExec,
      "__internal-codex-acp",
    ]);
    expect(adapterLaunchCommand(ADAPTERS.antigravity!, realBinaryExec, "/$bunfs/root")).toEqual([
      realBinaryExec,
      "__internal-agy-acp",
    ]);
    expect(adapterLaunchCommand(ADAPTERS.pi!, realBinaryExec, "/$bunfs/root")).toEqual([
      realBinaryExec,
      "__internal-pi-acp",
    ]);
    expect(adapterLaunchCommand(ADAPTERS.grok!, realBinaryExec, "/$bunfs/root")).toEqual([...GROK_AGENT_COMMAND]);
    expect(adapterLaunchCommand(ADAPTERS.opencode!, realBinaryExec, "/$bunfs/root")).toEqual([...OPENCODE_AGENT_COMMAND]);

    expect(resolveDefaultUiDir("/usr/bin/bun", "/repo/packages/engine/src")).toBe(resolve("/repo/apps/desktop/dist"));
    expect(resolveDefaultUiDir(realBinaryExec, "/$bunfs/root")).toBe(join(realBundleDir, "ui"));

    const siblingUi = resolve(realBundleDir, "../ui");
    mkdirSync(siblingUi, { recursive: true });
    expect(resolveDefaultUiDir(realBinaryExec, "/$bunfs/root")).toBe(siblingUi);

    const adjacentUi = join(realBundleDir, "ui");
    mkdirSync(adjacentUi, { recursive: true });
    expect(resolveDefaultUiDir(realBinaryExec, "/$bunfs/root")).toBe(adjacentUi);

    expect(
      transitionFallbackCommand(["serve"], "/usr/bin/bun", ["/usr/bin/bun", "/repo/packages/engine/src/cli.ts", "serve"], "/repo/src"),
    ).toEqual(["/usr/bin/bun", "/repo/packages/engine/src/cli.ts", "serve"]);
    expect(
      transitionFallbackCommand(["app"], realBinaryExec, ["bun", "/$bunfs/root/petrina-engine", "app"], "/$bunfs/root"),
    ).toEqual([realBinaryExec, "app"]);

    expect(defaultManagedSpawnCommand(undefined, "/usr/bin/bun", "/repo/packages/engine/src")).toEqual([
      "/usr/bin/bun",
      join("/repo/packages/engine/src", "cli.ts"),
      "serve",
      "--managed",
    ]);
    expect(defaultManagedSpawnCommand(undefined, realBinaryExec, "/$bunfs/root")).toEqual([
      realBinaryExec,
      "serve",
      "--managed",
    ]);
    const customManaged = defaultManagedSpawnCommand("/tmp/fixture-cli.ts", realBinaryExec, "/$bunfs/root");
    expect(customManaged.slice(1)).toEqual(["/tmp/fixture-cli.ts", "serve", "--managed"]);
    expect(customManaged[0]).not.toBe(realBinaryExec);
  });

  it("resolves adjacent node_modules adapter entries in compiled mode and stages binary releases in ReleaseStore", () => {
    const root = tempDir("petrina-compiled-release-");
    roots.push(root);

    const bundleDir = join(root, "bundle");
    const home = join(root, "home");
    mkdirSync(bundleDir, { recursive: true });

    expect(engineBinaryName("darwin")).toBe("petrina-engine");
    expect(engineBinaryName("linux")).toBe("petrina-engine");
    expect(engineBinaryName("win32")).toBe("petrina-engine.exe");
    expect(codexWrapperName("darwin")).toBe("codex-background");
    expect(codexWrapperName("win32")).toBe("codex-background.cmd");

    const binaryPath = join(bundleDir, engineBinaryName("darwin"));
    writeFileSync(binaryPath, "#!/bin/sh\necho ready\n", "utf8");
    chmodSync(binaryPath, 0o755);

    const unixWrapper = writeCodexWrapper(bundleDir, "darwin");
    expect(existsSync(unixWrapper)).toBe(true);
    expect(readFileSync(unixWrapper, "utf8")).toContain("__internal-codex-background");
    if (process.platform !== "win32") {
      expect(statSync(unixWrapper).mode & 0o111).toBeGreaterThan(0);
    }

    const winDir = join(root, "win-bundle");
    const winWrapper = writeCodexWrapper(winDir, "win32");
    expect(readFileSync(winWrapper, "utf8")).toContain("petrina-engine.exe\" __internal-codex-background %*");

    const fakePkgDir = join(bundleDir, "node_modules", "@fake-scope", "fake-acp", "dist");
    mkdirSync(fakePkgDir, { recursive: true });
    const fakeEntry = join(fakePkgDir, "index.js");
    writeFileSync(fakeEntry, "export {};\n", "utf8");
    expect(resolveAdapterEntry("@fake-scope/fake-acp/dist/index.js", binaryPath, "/$bunfs/root")).toBe(
      join(compiledExecutableDir(binaryPath), "node_modules", "@fake-scope", "fake-acp", "dist", "index.js"),
    );

    const store = new ReleaseStore(home);
    const staged = store.stage("0.2.0", bundleDir);
    expect(staged.kind).toBe("binary");
    expect(staged.entrypoint).toBe(join(store.versionsDir, "0.2.0", "petrina-engine"));
    expect(existsSync(join(store.versionsDir, "0.2.0", "codex-background"))).toBe(true);

    const promoted = store.promote("0.2.0");
    expect(promoted.current.kind).toBe("binary");
    expect(store.commandFor(promoted.current, ["app"])).toEqual([promoted.current.entrypoint, "app"]);
  });

  it("packages standalone engine release archives and deterministic SHA256SUMS.txt manifests", async () => {
    const root = tempDir("petrina-release-archive-");
    roots.push(root);

    expect(engineReleaseArchiveName("v0.2.1", "darwin", "arm64")).toBe("petrina-engine-0.2.1-darwin-arm64.tar.gz");
    expect(engineReleaseArchiveName("0.2.1", "linux", "x64")).toBe("petrina-engine-0.2.1-linux-x64.tar.gz");
    expect(engineReleaseArchiveName("v0.2.1", "win32", "x64")).toBe("petrina-engine-0.2.1-win32-x64.zip");

    const bundleDir = join(root, "bundle");
    const releaseDir = join(root, "dist-release");
    mkdirSync(bundleDir, { recursive: true });
    const binaryPath = join(bundleDir, engineBinaryName());
    writeFileSync(binaryPath, "standalone-binary-payload\n", "utf8");
    if (process.platform !== "win32") chmodSync(binaryPath, 0o755);
    writeCodexWrapper(bundleDir);

    const packaged = await packageEngineRelease({
      bundleDir,
      releaseDir,
      version: "v0.2.1",
    });
    expect(existsSync(packaged.archivePath)).toBe(true);
    expect(existsSync(packaged.checksumsPath)).toBe(true);

    const archiveDigest = sha256File(packaged.archivePath);
    expect(archiveDigest).toMatch(/^[0-9a-f]{64}$/);
    const checksumsText = readFileSync(packaged.checksumsPath, "utf8");
    expect(checksumsText).toBe(`${archiveDigest}  ${engineReleaseArchiveName("v0.2.1")}\n`);

    writeFileSync(join(releaseDir, "Petrina_0.2.1_aarch64.dmg"), "dmg-payload", "utf8");
    const refreshedPath = writeSha256Sums(releaseDir);
    const refreshedLines = readFileSync(refreshedPath, "utf8").trim().split("\n");
    expect(refreshedLines).toHaveLength(2);
    expect(refreshedLines[0]).toContain("Petrina_0.2.1_aarch64.dmg");
    expect(refreshedLines[1]).toContain(engineReleaseArchiveName("v0.2.1"));
  });
});
