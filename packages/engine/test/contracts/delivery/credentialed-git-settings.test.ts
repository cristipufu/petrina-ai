import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { plantedGitProgram } from "@petrina/test-support/git-program";
import { credentialedDelivery, plainGitControl } from "../../fixtures/security-delivery.js";
import { ADDRESS, git } from "../../support.js";
import { securityWorlds } from "../../fixtures/security.js";

const { world, close } = securityWorlds();
afterAll(close);
describe.skipIf(process.platform === "win32")("Petrina's credentialed git steps trust none of the repository's own settings", () => {
for (const mode of ["pull-request", "release"] as const) {
    it(`publishes a ${mode} only to the saved address, with no hooks, extra tags or submodules, whatever the remote, push address and hooks now say`, async () => {
      await world(`redirect-${mode}`, async ({ world: w }) => {
      const evil = join(w.dir, "evil.git");
      await git(w.dir, "init", "-q", "--bare", "-b", "main", evil);
      // A submodule whose newest commit is only local; the work being pushed points at it.
      const libOrigin = join(w.dir, "lib.git");
      await git(w.dir, "init", "-q", "--bare", "-b", "main", libOrigin);
      const lib = join(w.dir, "lib");
      await git(w.dir, "init", "-q", "-b", "main", lib);
      await git(lib, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "Library");
      await git(lib, "push", "-q", libOrigin, "main");
      await git(w.clone, "-c", "protocol.file.allow=always", "submodule", "add", "-q", libOrigin, "lib");
      await git(w.clone, "commit", "-q", "-m", "Add the library");
      await git(w.clone, "push", "-q", w.remote, "main");
      await git(join(w.clone, "lib"), "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "Not pushed");
      const unpushed = await git(join(w.clone, "lib"), "rev-parse", "HEAD");
      w.setScript((script) => (script.gitlink = { path: "lib", sha: unpushed }));
      // An extra annotated tag on work that gets pushed.
      await git(w.clone, "tag", "-a", "planted", "-m", "Should never travel", "HEAD");
      // Hooks that run around pushes, checkouts and ref changes: none of Petrina's own git steps may run them.
      // (Commit hooks are the repository's checks, which Petrina runs on purpose, without a login.)
      const hook = plantedGitProgram(w.dir, "hook");
      const hooks = join(w.dir, "hooks");
      mkdirSync(hooks);
      for (const name of ["pre-push", "post-checkout", "reference-transaction", "post-merge"]) {
        hook.writeHook(join(hooks, name));
        hook.writeHook(join(w.clone, ".git", "hooks", name));
      }
      // The coordinator's own settings push tags along and push submodules too.
      const globalConfig = join(w.dir, "global.gitconfig");
      writeFileSync(globalConfig, '[push]\n\tfollowTags = true\n\trecurseSubmodules = on-demand\n[protocol "file"]\n\tallow = always\n');

      const input = { kind: "redirect" as const, mode, world: { dir: w.dir, clone: w.clone, remote: w.remote, data: w.data }, evil, hooks, globalConfig, libOrigin, unpushed };
      const beforeConfig = process.env.GIT_CONFIG_GLOBAL;
      const observed = await credentialedDelivery(input);
      const { task, tested } = observed;
      expect(task.error).toBeUndefined();
      expect(task.state).toBe(mode === "pull-request" ? "pr-open" : "done");
      if (tested === undefined) throw new Error("The native delivery returned no tested commit");
      expect(observed.deliveredRef).toBe(tested);
      expect(observed.evilRefs).toBe("");
      expect(observed.plantedTag).toBeUndefined();
      expect(observed.tags).toBe(mode === "release" ? "refs/tags/v0.1.0" : "");
      expect(hook.marks()).toEqual([]);
      expect(observed.gitlink).toBe(unpushed);
      expect(observed.libraryBefore).toBe(false);
      expect(observed.savedAddress).toBe(ADDRESS);
      // The plain-push control runs after the delivery assertions, in the same explicit private settings.
      expect(await plainGitControl({ ...input, tested })).toBe(true);
      expect(process.env.GIT_CONFIG_GLOBAL).toBe(beforeConfig);
      });
    });
  }

});
