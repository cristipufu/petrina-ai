import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { credentialedDelivery } from "../../fixtures/security-delivery.js";
import { git } from "../../support.js";
import { securityWorlds } from "../../fixtures/security.js";
import { quoteGitShellWord, writeGitProgram } from "@petrina/test-support/git-program";

const { world, close } = securityWorlds();
afterAll(close);
describe.skipIf(process.platform === "win32")("Petrina's credentialed git steps trust none of the repository's own settings", () => {
for (const mode of ["pull-request", "release"] as const) {
    it(`fetches and publishes a ${mode} over the SSH address saved when the product was added, not wherever origin points now`, async () => {
      const saved = "git@github.com:acme/demo.git";
      await world(`saved-${mode}-controller's copy`, async ({ world: w }) => {
      const evil = join(w.dir, "evil.git");
      await git(w.dir, "init", "-q", "--bare", "-b", "main", evil);
      // The coordinator's own SSH setup: an ssh that serves the folder standing in for GitHub and notes what it was asked for.
      const asked = join(w.dir, "ssh result's log");
      const ssh = join(w.dir, "ssh peer's program.sh");
      writeGitProgram(
        ssh,
        `[ "$1" = "-G" ] && exit 1\nfor arg; do host="$cmd"; cmd="$arg"; done\necho "$host $cmd" >> ${quoteGitShellWord(asked)}\ncase "$cmd" in\n  git-upload-pack*) exec git-upload-pack ${quoteGitShellWord(w.remote)} ;;\n  git-receive-pack*) exec git-receive-pack ${quoteGitShellWord(w.remote)} ;;\nesac\nexit 1`,
      );

      const beforeSsh = process.env.GIT_SSH_COMMAND;
      const observed = await credentialedDelivery({ kind: "ssh", mode, world: { dir: w.dir, clone: w.clone, remote: w.remote, data: w.data }, evil, ssh });
      expect(observed.registeredAddress).toBe(saved);
      const { task, tested } = observed;
      expect(task.error).toBeUndefined();
      expect(task.state).toBe(mode === "pull-request" ? "pr-open" : "done");
      if (tested === undefined) throw new Error("The native delivery returned no tested commit");
      expect(observed.deliveredRef).toBe(tested);
      expect(observed.evilRefs).toBe("");
      // Every actual fetch and push reached the saved SSH address, and both happened.
      const calls = readFileSync(asked, "utf8").trim().split("\n");
      expect([...new Set(calls)].sort()).toEqual(["git@github.com git-receive-pack 'acme/demo.git'", "git@github.com git-upload-pack 'acme/demo.git'"]);
      expect(process.env.GIT_SSH_COMMAND).toBe(beforeSsh);
      }, { address: saved });
    });
  }

});
