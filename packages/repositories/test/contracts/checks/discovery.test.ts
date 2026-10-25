import { describe as originalDescribe } from "bun:test";
import { afterAll, expect, it } from "bun:test";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { detectChecks, checksFingerprint } from "../../../src/check-discovery.js";
import { tempDir, removeDir } from "@petrina/test-support/fixtures";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const root = (prefix: string) => { const dir = tempDir(prefix); roots.push(dir); return dir; };
originalDescribe("a product's checks", () => {
it("suggests the checks a repository declares, whatever its stack", () => {
    const js = root("petrina-checks-js-");
    writeFileSync(join(js, "package.json"), JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "vitest run", build: "vite build", dev: "vite" } }));
    writeFileSync(join(js, "bun.lock"), "");
    expect(detectChecks(js)).toEqual([
      { name: "Type check", argv: ["bun", "run", "typecheck"] },
      { name: "Tests", argv: ["bun", "run", "test"] },
      { name: "Build", argv: ["bun", "run", "build"] },
    ]);

    const placeholder = root("petrina-checks-npm-");
    writeFileSync(join(placeholder, "package.json"), JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(detectChecks(placeholder)).toEqual([]);

    const rust = root("petrina-checks-rust-");
    writeFileSync(join(rust, "Cargo.toml"), "[package]\nname = \"x\"\n");
    expect(detectChecks(rust)).toEqual([{ name: "Rust tests", argv: ["cargo", "test"] }]);
  });
});

originalDescribe("a product's checks", () => {
it("notices when the CI or build files change, and only then", () => {
    const dir = root("petrina-checks-print-");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
    const first = checksFingerprint(dir);
    writeFileSync(join(dir, "README.md"), "# Hello");
    expect(checksFingerprint(dir)).toBe(first);
    mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(dir, ".github", "workflows", "ci.yml"), "jobs: {}");
    expect(checksFingerprint(dir)).not.toBe(first);
  });
});
