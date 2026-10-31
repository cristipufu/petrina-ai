import { readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { isCompiledBinary } from "@petrina/platform/compiled-runtime";

export const NO_HEADLESS_BROWSER_MESSAGE =
  "No Chromium-based browser (such as Google Chrome, Microsoft Edge, Chromium or Brave) is installed on this machine.";

export interface BrowserResolutionProbe {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly home?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (filePath: string) => boolean;
  readonly readDir?: (dirPath: string) => readonly string[];
  readonly which?: (program: string) => string | null;
  readonly playwrightChromiumPath?: () => string | undefined;
}

function defaultExists(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function defaultReadDir(dirPath: string): readonly string[] {
  try {
    return readdirSync(dirPath);
  } catch {
    return [];
  }
}

function defaultPlaywrightChromiumPath(): string | undefined {
  if (isCompiledBinary()) return undefined;
  try {
    const runtimeRequire = createRequire(import.meta.url);
    const mcpRequire = createRequire(runtimeRequire.resolve("@playwright/mcp/package.json"));
    const { chromium } = mcpRequire("playwright-core") as { chromium: { executablePath(): string } };
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === "win32" ? win32.join(...parts) : posix.join(...parts);
}

function playwrightCacheRoot(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  const override = env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (override && override !== "0") return override;
  if (platform === "darwin") return posix.join(home, "Library", "Caches", "ms-playwright");
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim() || win32.join(home, "AppData", "Local");
    return win32.join(localAppData, "ms-playwright");
  }
  const xdgCache = env.XDG_CACHE_HOME?.trim() || posix.join(home, ".cache");
  return posix.join(xdgCache, "ms-playwright");
}

function playwrightRelativeCandidates(platform: NodeJS.Platform, arch: string): readonly (readonly string[])[] {
  if (platform === "darwin") {
    const folders = arch === "arm64" ? ["chrome-mac-arm64", "chrome-mac-x64"] : ["chrome-mac-x64", "chrome-mac-arm64"];
    return [
      ...folders.flatMap((folder) => [
        [folder, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"],
        [folder, "Chromium.app", "Contents", "MacOS", "Chromium"],
      ]),
      ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
    ];
  }
  if (platform === "win32") {
    return [
      ["chrome-win64", "chrome.exe"],
      ["chrome-win", "chrome.exe"],
    ];
  }
  const folders =
    arch === "arm64"
      ? ["chrome-linux-arm64", "chrome-linux64", "chrome-linux"]
      : ["chrome-linux64", "chrome-linux-arm64", "chrome-linux"];
  return folders.map((folder) => [folder, "chrome"]);
}

function findCachedPlaywrightChromium(
  platform: NodeJS.Platform,
  arch: string,
  home: string,
  env: NodeJS.ProcessEnv,
  exists: (filePath: string) => boolean,
  readDir: (dirPath: string) => readonly string[],
): string | undefined {
  const cacheRoot = playwrightCacheRoot(platform, home, env);
  const revisions = readDir(cacheRoot)
    .filter((entry) => /^chromium-\d+$/.test(entry))
    .sort((a, b) => Number(b.slice("chromium-".length)) - Number(a.slice("chromium-".length)));
  const candidates = playwrightRelativeCandidates(platform, arch);
  for (const revision of revisions) {
    for (const rel of candidates) {
      const candidate = joinFor(platform, cacheRoot, revision, ...rel);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}

const MACOS_BUNDLES: readonly (readonly string[])[] = [
  ["Google Chrome.app", "Contents", "MacOS", "Google Chrome"],
  ["Chromium.app", "Contents", "MacOS", "Chromium"],
  ["Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"],
  ["Brave Browser.app", "Contents", "MacOS", "Brave Browser"],
  ["Google Chrome Beta.app", "Contents", "MacOS", "Google Chrome Beta"],
  ["Google Chrome Canary.app", "Contents", "MacOS", "Google Chrome Canary"],
  ["Microsoft Edge Beta.app", "Contents", "MacOS", "Microsoft Edge Beta"],
];

const WINDOWS_SUFFIXES: readonly (readonly string[])[] = [
  ["Google", "Chrome", "Application", "chrome.exe"],
  ["Chromium", "Application", "chrome.exe"],
  ["Microsoft", "Edge", "Application", "msedge.exe"],
  ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
  ["Google", "Chrome Beta", "Application", "chrome.exe"],
  ["Microsoft", "Edge Beta", "Application", "msedge.exe"],
];

const LINUX_COMMANDS = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "microsoft-edge-stable",
  "brave-browser",
  "brave",
] as const;

const LINUX_PATHS = [
  "/opt/google/chrome/chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/opt/microsoft/msedge/msedge",
  "/usr/bin/microsoft-edge",
  "/opt/brave.com/brave/brave",
  "/usr/bin/brave-browser",
] as const;

/**
 * Resolve an executable Chromium-family browser for isolated headless automation.
 * Prefers Playwright's cached Chromium when present on disk, then falls back to any
 * Chromium-based browser installed on the user's machine (Chrome, Chromium, Edge or Brave).
 */
export function findHeadlessChromiumExecutable(probe: BrowserResolutionProbe = {}): string | undefined {
  const platform = probe.platform ?? process.platform;
  const arch = probe.arch ?? process.arch;
  const env = probe.env ?? process.env;
  const home = probe.home ?? homedir();
  const exists = probe.exists ?? defaultExists;
  const readDir = probe.readDir ?? defaultReadDir;
  const which = probe.which ?? ((program: string) => Bun.which(program, { PATH: env.PATH ?? "" }));

  const exactPlaywright = (
    probe.playwrightChromiumPath !== undefined ? probe.playwrightChromiumPath : defaultPlaywrightChromiumPath
  )();
  if (exactPlaywright && exists(exactPlaywright)) return exactPlaywright;

  const cachedPlaywright = findCachedPlaywrightChromium(platform, arch, home, env, exists, readDir);
  if (cachedPlaywright) return cachedPlaywright;

  const fromWhich = (names: readonly string[]): string | undefined => {
    for (const name of names) {
      const resolved = which(name);
      if (resolved && exists(resolved)) return resolved;
    }
    return undefined;
  };

  if (platform === "darwin") {
    for (const appRoot of ["/Applications", posix.join(home, "Applications")]) {
      for (const bundle of MACOS_BUNDLES) {
        const candidate = posix.join(appRoot, ...bundle);
        if (exists(candidate)) return candidate;
      }
    }
    return fromWhich(["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]);
  }

  if (platform === "win32") {
    const roots = [
      ...new Set(
        [
          env.LOCALAPPDATA?.trim(),
          env.PROGRAMFILES?.trim(),
          env["PROGRAMFILES(X86)"]?.trim(),
          win32.join(home, "AppData", "Local"),
          "C:\\Program Files",
          "C:\\Program Files (x86)",
        ].filter((value): value is string => Boolean(value)),
      ),
    ];
    for (const root of roots) {
      for (const suffix of WINDOWS_SUFFIXES) {
        const candidate = win32.join(root, ...suffix);
        if (exists(candidate)) return candidate;
      }
    }
    return fromWhich(["chrome", "chrome.exe", "msedge", "msedge.exe", "chromium", "brave"]);
  }

  const onPath = fromWhich(LINUX_COMMANDS);
  if (onPath) return onPath;
  for (const candidate of LINUX_PATHS) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}
