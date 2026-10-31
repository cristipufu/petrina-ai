import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testEnvironment, TEST_GIT_IDENTITY } from "@petrina/test-support/environment";
import { gitWith } from "../../../src/commands.js";
import { removeDir, tempDir } from "../../../src/fixtures.js";

const root = tempDir("petrina-environment-");
afterAll(() => removeDir(root));

it("starts workers with private settings and no inherited accounts, Git overrides or agent configuration", async () => {
  const folder = join(root, "private"); mkdirSync(folder);
  const own = testEnvironment(folder, join(root, "browsers"), {
    PATH: process.env.PATH, SystemRoot: "native-system-root", HOME: join(root, "developer"),
    GH_TOKEN: "private", OPENAI_API_KEY: "private", ARBITRARY_SECRET: "private", SSH_AUTH_SOCK: "private",
    GIT_CONFIG_GLOBAL: "private", GIT_CONFIG_SYSTEM: "private", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "remote.origin.pushurl",
    GIT_CONFIG_VALUE_0: "blocked", GIT_CONFIG_PARAMETERS: "private", GIT_DIR: "private", GIT_AUTHOR_NAME: "Developer",
    CODEX_HOME: "private", CODEX_CONFIG: "private", CLAUDE_CONFIG_DIR: "private", GEMINI_HOME: "private", NODE_OPTIONS: "private",
    FORCE_COLOR: "1", COLORTERM: "truecolor",
    PETRINA_FIXTURE_RUN: "controlled", PETRINA_TEST_EXAMPLE: "controlled", CI: "true",
  });
  expect(own.HOME).toBe(join(folder, "home"));
  expect(own.USERPROFILE).toBe(own.HOME);
  expect(own.PATH).toBe(process.env.PATH);
  expect(own.SystemRoot).toBe("native-system-root");
  expect(own.PETRINA_FIXTURE_RUN).toBe("controlled");
  expect(own.PETRINA_TEST_EXAMPLE).toBe("controlled");
  expect(own.NO_COLOR).toBe("1");
  for (const key of ["GH_TOKEN", "OPENAI_API_KEY", "ARBITRARY_SECRET", "SSH_AUTH_SOCK", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_DIR", "GIT_AUTHOR_NAME", "CODEX_HOME", "CODEX_CONFIG", "CLAUDE_CONFIG_DIR", "GEMINI_HOME", "NODE_OPTIONS", "FORCE_COLOR", "COLORTERM"]) expect(own[key], key).toBeUndefined();
  const config = readFileSync(own.GIT_CONFIG_GLOBAL!, "utf8");
  expect(config).toContain(TEST_GIT_IDENTITY.email);
  expect(readFileSync(own.GIT_CONFIG_SYSTEM!, "utf8")).toBe("");
  // The resulting Git process sees only the fixture identity, even outside a repository.
  expect(await gitWith({ cwd: folder, env: { ...own, SystemRoot: process.env.SystemRoot } }, "config", "--global", "user.name")).toBe(TEST_GIT_IDENTITY.name);
  expect(await gitWith({ cwd: folder, env: { ...own, SystemRoot: process.env.SystemRoot } }, "config", "--global", "gc.auto")).toBe("0");
  expect(await gitWith({ cwd: folder, env: { ...own, SystemRoot: process.env.SystemRoot } }, "config", "--global", "maintenance.auto")).toBe("false");
});

it("shares only provisioned browser binaries while nested homes and settings remain private", () => {
  const developer = join(root, "browser-developer"), cache = process.platform === "darwin" ? join(developer, "Library", "Caches")
    : process.platform === "win32" ? join(developer, "AppData", "Local") : join(developer, ".cache");
  const binaries = join(cache, "ms-playwright"); mkdirSync(binaries, { recursive: true });
  writeFileSync(join(binaries, "installed-build"), "provisioned");
  writeFileSync(join(developer, "account.json"), "private account");
  const first = join(root, "first-home"), second = join(root, "second-home");
  mkdirSync(first); mkdirSync(second);
  const one = testEnvironment(first, join(root, "browser-one"), { HOME: developer, LOCALAPPDATA: cache, XDG_CACHE_HOME: cache });
  const two = testEnvironment(second, join(root, "browser-two"), one);
  expect(one.HOME).not.toBe(two.HOME);
  expect(one.GIT_CONFIG_GLOBAL).not.toBe(two.GIT_CONFIG_GLOBAL);
  expect(one.PETRINA_TEST_REPOSITORY_SEEDS).toBe(join(first, "repository-seeds"));
  expect(two.PETRINA_TEST_REPOSITORY_SEEDS).toBe(join(second, "repository-seeds"));
  expect(readFileSync(join(two.PETRINA_TEST_REPOSITORY_SEEDS!, "global.gitconfig"), "utf8")).toBe(readFileSync(two.GIT_CONFIG_GLOBAL!, "utf8"));
  expect(existsSync(join(one.HOME!, "account.json"))).toBe(false);
  expect(existsSync(join(two.HOME!, "account.json"))).toBe(false);
  const ownCache = process.platform === "darwin" ? join(two.HOME!, "Library", "Caches") : process.platform === "win32" ? two.LOCALAPPDATA! : two.XDG_CACHE_HOME!;
  expect(realpathSync.native(join(ownCache, "ms-playwright"))).toBe(realpathSync.native(binaries));
  removeDir(first); removeDir(second);
  expect(readFileSync(join(binaries, "installed-build"), "utf8")).toBe("provisioned");
});
