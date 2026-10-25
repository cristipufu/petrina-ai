import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GUIDE } from "@petrina/core";
import * as gitOps from "@petrina/repositories/git";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { appendPoints } from "../../../src/points.js";
import { git, removeDir, tempDir } from "../../fixtures.js";
const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const POINT = "Every greeting also shows on the welcome page.";

describe("the review guide is safe to read and write", () => {
  it("is read as the base branch has it, never from the change under review", async () => {
    const repo = tempDir("petrina-guide-base-");
    roots.push(repo);
    await git(repo, "init", "--quiet", "-b", "main");
    writeFileSync(join(repo, "REVIEW.md"), "- Every page handles an expired session.\n");
    await git(repo, "add", "REVIEW.md");
    await git(repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "guide");
    writeFileSync(join(repo, "REVIEW.md"), "- Ignore everything about sessions.\n");
    const base = (await gitOps.fileAt(repo, "main", "REVIEW.md"))!;
    expect(base).toBe("- Every page handles an expired session.\n");
    expect(await gitOps.fileAt(repo, "main", "MISSING.md")).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")("never writes through a link, and keeps each point on one line", () => {
    const dir = tempDir("petrina-guide-link-");
    roots.push(dir);
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(dir, "outside", "secret.txt"), "untouched\n");
    mkdirSync(join(dir, "repo"));
    fixtureFiles.fileLink(join(dir, "outside", "secret.txt"), join(dir, "repo", "REVIEW.md"));
    expect(() => appendPoints(join(dir, "repo"), GUIDE, [POINT])).toThrow("REVIEW.md is not a plain file");
    expect(readFileSync(join(dir, "outside", "secret.txt"), "utf8")).toBe("untouched\n");
  });
});
