import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { processFolderSnapshot } from "@petrina/platform/process-directory-snapshots";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { connectBrowser } from "../../../src/browser-connection.js";
import {
  findHeadlessChromiumExecutable,
  NO_HEADLESS_BROWSER_MESSAGE,
  type BrowserResolutionProbe,
} from "../../../src/browser-executable.js";

const root = tempDir("petrina-browser-executable-");
afterAll(() => removeDir(root));

function syntheticProbe(
  files: readonly string[],
  dirs: Readonly<Record<string, readonly string[]>>,
  overrides: BrowserResolutionProbe = {},
): BrowserResolutionProbe {
  const fileSet = new Set(files);
  return {
    env: {},
    playwrightChromiumPath: () => undefined,
    which: () => null,
    exists: (candidate) => fileSet.has(candidate),
    readDir: (dirPath) => dirs[dirPath] ?? [],
    ...overrides,
  };
}

describe("Headless Chromium executable resolution", () => {
  it("prefers Playwright's exact Chromium path when installed on disk", () => {
    const pwBinary = "/cache/ms-playwright/chromium-1247/chrome-linux64/chrome";
    const systemChrome = "/opt/google/chrome/chrome";
    const resolved = findHeadlessChromiumExecutable(
      syntheticProbe([pwBinary, systemChrome], {}, {
        platform: "linux",
        arch: "x64",
        home: "/home/alice",
        playwrightChromiumPath: () => pwBinary,
      }),
    );
    expect(resolved).toBe(pwBinary);
  });

  it("finds the newest cached Playwright Chromium revision across macOS, Linux and Windows when compiled", () => {
    const macNew =
      "/Users/alice/Library/Caches/ms-playwright/chromium-1247/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
    const macOld =
      "/Users/alice/Library/Caches/ms-playwright/chromium-1180/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
    expect(
      findHeadlessChromiumExecutable(
        syntheticProbe(
          [macOld, macNew, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
          { "/Users/alice/Library/Caches/ms-playwright": ["chromium-1180", "chromium-1247"] },
          { platform: "darwin", arch: "arm64", home: "/Users/alice" },
        ),
      ),
    ).toBe(macNew);

    const winCached = "C:\\Users\\alice\\AppData\\Local\\ms-playwright\\chromium-1247\\chrome-win64\\chrome.exe";
    expect(
      findHeadlessChromiumExecutable(
        syntheticProbe(
          [winCached, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"],
          { "C:\\Users\\alice\\AppData\\Local\\ms-playwright": ["chromium-1247"] },
          {
            platform: "win32",
            arch: "x64",
            home: "C:\\Users\\alice",
            env: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
          },
        ),
      ),
    ).toBe(winCached);

    const linuxCached = "/home/alice/.cache/ms-playwright/chromium-1247/chrome-linux-arm64/chrome";
    expect(
      findHeadlessChromiumExecutable(
        syntheticProbe(
          [linuxCached, "/usr/bin/chromium"],
          { "/home/alice/.cache/ms-playwright": ["chromium-1247"] },
          { platform: "linux", arch: "arm64", home: "/home/alice" },
        ),
      ),
    ).toBe(linuxCached);
  });

  it("falls back to installed Google Chrome, Chromium, Microsoft Edge or Brave on macOS, Linux and Windows", () => {
    const macSystemChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    expect(
      findHeadlessChromiumExecutable(
        syntheticProbe([macSystemChrome], {}, { platform: "darwin", arch: "arm64", home: "/Users/alice" }),
      ),
    ).toBe(macSystemChrome);

    const macUserEdge = "/Users/alice/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    expect(
      findHeadlessChromiumExecutable(
        syntheticProbe([macUserEdge], {}, { platform: "darwin", arch: "arm64", home: "/Users/alice" }),
      ),
    ).toBe(macUserEdge);

    const linuxSnapChromium = "/snap/bin/chromium";
    expect(
      findHeadlessChromiumExecutable(
        syntheticProbe([linuxSnapChromium], {}, {
          platform: "linux",
          arch: "x64",
          home: "/home/alice",
          which: (name) => (name === "chromium" ? linuxSnapChromium : null),
        }),
      ),
    ).toBe(linuxSnapChromium);

    const winEdge = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    expect(
      findHeadlessChromiumExecutable(
        syntheticProbe([winEdge], {}, {
          platform: "win32",
          arch: "x64",
          home: "C:\\Users\\alice",
          env: {
            LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
            PROGRAMFILES: "C:\\Program Files",
            "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
          },
        }),
      ),
    ).toBe(winEdge);

    expect(
      findHeadlessChromiumExecutable(
        syntheticProbe([], {}, { platform: "darwin", arch: "arm64", home: "/Users/alice" }),
      ),
    ).toBeUndefined();
  });

  it("matches only isolated session system-browser processes and ignores personal interactive browsers", () => {
    const sessionDir = "/Users/alice/.petrina/b/petrina-browser-9a8b7c";
    const psOutput = [
      "  501   100 S    /Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "  502   501 S    /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=renderer",
      `  910   900 S    /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless --user-data-dir=${sessionDir}/playwright_chromiumdev_profile-abc --no-startup-window`,
      `  911   910 S    /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app/Contents/MacOS/Google Chrome Helper --type=gpu-process --user-data-dir=${sessionDir}/playwright_chromiumdev_profile-abc`,
    ].join("\n");

    const snapshot = processFolderSnapshot(psOutput, sessionDir);
    expect(snapshot.pids).toEqual([910, 911]);
  });

  it("keeps MCP tool discovery healthy without an installed browser and reports plain-language guidance only on page use", async () => {
    const captureDir = mkdtempSync(join(root, "no-browser-"));
    const browser = await connectBrowser(
      captureDir,
      syntheticProbe([], {}, { platform: "linux", arch: "x64", home: "/home/alice" }),
    );
    try {
      const initResponse = await browser.fetch(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2024-11-05",
              capabilities: {},
              clientInfo: { name: "test-agent", version: "1" },
            },
          }),
        }),
      );
      expect(initResponse.status).toBe(200);
      const sessionId = initResponse.headers.get("mcp-session-id");
      expect(sessionId).toBeTruthy();

      const listResponse = await browser.fetch(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            "mcp-session-id": sessionId!,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        }),
      );
      expect(listResponse.status).toBe(200);
      const listPayload = (await listResponse.json()) as { result: { tools: { name: string }[] } };
      expect(listPayload.result.tools.map((tool) => tool.name)).toContain("browser_navigate");

      const callResponse = await browser.fetch(
        new Request("http://127.0.0.1/mcp", {
          method: "POST",
          headers: {
            "mcp-session-id": sessionId!,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: { name: "browser_navigate", arguments: { url: "about:blank" } },
          }),
        }),
      );
      expect(callResponse.status).toBe(200);
      const callPayload = (await callResponse.json()) as {
        result: { isError?: boolean; content: { type: string; text: string }[] };
      };
      expect(callPayload.result.isError).toBe(true);
      expect(callPayload.result.content[0]?.text).toBe(NO_HEADLESS_BROWSER_MESSAGE);
    } finally {
      await browser.close();
    }
  });
});
