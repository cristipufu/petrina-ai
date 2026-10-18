// Petrina runs this suite with git settings that turn origin pushes off. The tests' own git
// commands still have to reach the repositories they create.
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "./support.js";

describe("git commands while Petrina runs the suite", () => {
  it("can push to origin when the check environment disables those pushes", () => {
    const root = mkdtempSync(join(tmpdir(), "petrina-check-git-"));
    const support = join(import.meta.dir, "support.ts");
    const script = `
      const { git } = await import(${JSON.stringify(support)});
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const root = process.env.PETRINA_GIT_PROBE;
      const remote = join(root, "origin.git");
      const repo = join(root, "repo");
      mkdirSync(repo, { recursive: true });
      git(root, "init", "-q", "--bare", "-b", "main", remote);
      git(repo, "init", "-q", "-b", "main");
      git(repo, "config", "user.email", "t@example.com");
      git(repo, "config", "user.name", "Test");
      writeFileSync(join(repo, "README.md"), "hi\\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "init");
      git(repo, "remote", "add", "origin", remote);
      git(repo, "push", "-q", "origin", "main");
    `;
    try {
      const result = Bun.spawnSync([process.execPath, "-e", script], {
        env: {
          ...process.env,
          PETRINA_GIT_PROBE: root,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "remote.origin.pushurl",
          GIT_CONFIG_VALUE_0: "petrina-push-disabled://only-petrina-publishes",
          GIT_SSH_COMMAND: "petrina-ssh-disabled",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      removeDir(root);
    }
  });
});
