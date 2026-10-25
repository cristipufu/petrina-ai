import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeDir } from "@petrina/test-support/fixtures";
import { runCommand } from "@petrina/test-support/commands";

describe("git commands while Petrina runs the suite", () => {
it("can push to origin when the check environment disables those pushes", async () => {
    const root = mkdtempSync(join(tmpdir(), "petrina-check-git-"));
    const support = import.meta.resolve("@petrina/test-support/commands");
    const script = `
      const { git } = await import(${JSON.stringify(support)});
      const { mkdirSync, writeFileSync } = await import("node:fs");
      const { join } = await import("node:path");
      const root = process.env.PETRINA_GIT_PROBE;
      const remote = join(root, "origin.git");
      const repo = join(root, "repo");
      mkdirSync(repo, { recursive: true });
      await git(root, "init", "-q", "--bare", "-b", "main", remote);
      await git(repo, "init", "-q", "-b", "main");
      await git(repo, "config", "user.email", "t@example.com");
      await git(repo, "config", "user.name", "Test");
      writeFileSync(join(repo, "README.md"), "hi\\n");
      await git(repo, "add", ".");
      await git(repo, "commit", "-q", "-m", "init");
      await git(repo, "remote", "add", "origin", remote);
      await git(repo, "push", "-q", "origin", "main");
    `;
    try {
      const result = await runCommand([process.execPath, "-e", script], {
        env: {
          ...process.env,
          PETRINA_GIT_PROBE: root,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "remote.origin.pushurl",
          GIT_CONFIG_VALUE_0: "petrina-push-disabled://only-petrina-publishes",
          GIT_SSH_COMMAND: "petrina-ssh-disabled",
        },
      });
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      removeDir(root);
    }
  });
});
