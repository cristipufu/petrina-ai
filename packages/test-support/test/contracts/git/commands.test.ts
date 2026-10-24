import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitAt, git, gitWith, runGit } from "../../../src/commands.js";
import { removeDir, tempDir } from "../../../src/fixtures.js";
import { makeProduct } from "../../../src/repositories.js";
import { testGitEnv } from "../../../src/test-git-env.js";
import { failureOf } from "../../fixtures/command-failure.js";

const unix = process.platform !== "win32";
const root = tempDir("petrina-private-git-");
afterAll(() => removeDir(root));

describe("Git in the tests' private environment", () => {
  it("returns trimmed or exact output, passes input and fails a non-zero exit with everything Git said", async () => {
    const clone = await makeProduct(join(root, "git"));
    expect(await git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await gitWith({ cwd: clone, raw: true }, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main\n");
    const blob = await gitWith({ cwd: clone, input: "stored from input\n" }, "hash-object", "-w", "--stdin");
    expect(await git(clone, "cat-file", "blob", blob)).toBe("stored from input");
    const failure = await failureOf(git(clone, "rev-parse", "--verify", "no-such-ref"));
    expect(failure.reason).toBe("exit");
    expect(failure.code).toBe(128);
    expect(failure.message).toContain(`git rev-parse --verify no-such-ref failed (128) in ${clone}`);
    expect(failure.message).toContain("fatal: Needed a single revision");
    expect((await runGit(["rev-parse", "--verify", "--quiet", "no-such-ref"], { cwd: clone })).code).toBe(1);
  });

  it("names a missing ref absent only when Git confirms it, and fails every other answer", async () => {
    const clone = await makeProduct(join(root, "refs"));
    const origin = join(root, "refs", "origin.git");
    expect(await commitAt(origin, "refs/heads/main")).toBe(await git(clone, "rev-parse", "HEAD"));
    expect(await commitAt(origin, "refs/heads/no-such-branch")).toBeUndefined();
    const broken = await failureOf(commitAt(join(root, "not-a-repository"), "refs/heads/main"));
    expect(broken.reason).toBe("exit");
    expect(broken.message).toContain("not a git repository");
  });

  it.skipIf(!unix)("fails a lookup whose Git never finishes instead of naming the ref absent", async () => {
    const origin = join(root, "refs", "origin.git");
    const stub = join(root, "stuck-git");
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "git"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    const late = await failureOf(commitAt(origin, "refs/heads/no-such-branch", { env: { ...testGitEnv(), PATH: `${stub}:${process.env.PATH}` }, timeoutMs: 300 }));
    expect(late.reason).toBe("timeout");
    expect(late.cleanup).toBe("confirmed");
  });
});
