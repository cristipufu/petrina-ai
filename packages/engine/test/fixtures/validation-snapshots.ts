import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { commitVersion, isClean } from "@petrina/repositories/git";
import type { ValidationRunEffects } from "@petrina/orchestrator";
import type { EngineCaseOwner } from "./engine-cases.js";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { readWorktreeCommit } from "./shared-preparation.js";

type PreparedSnapshots = Pick<ValidationRunEffects, "snapshot"> & { readonly version: { readonly head: string; readonly tree: string } };

/** An explicit saved-copy input for queue/persistence cases; no command or completion evidence is supplied. */
export async function preparedValidationSnapshots(owner: EngineCaseOwner, source: string, data: string,
  product: () => string | undefined): Promise<PreparedSnapshots> {
  owner.check();
  source = fixtureFiles.canonical(source);
  const baseline = join(owner.root, "validation-saved-input");
  await cp(source, baseline, { recursive: true, force: false, errorOnExist: true }); owner.check();
  const fast = readWorktreeCommit(baseline);
  const version = fast ? { head: fast.commit, tree: fast.tree } : await commitVersion(baseline); owner.check();
  if (!version.head || !version.tree || (!fast && !await isClean(baseline))) throw new Error("The supplied validation copy has no clean committed version");
  owner.check();
  return {
    version: Object.freeze({ head: version.head, tree: version.tree }),
    async snapshot(record) {
      const { id, productId, source: requestedSource, commit, tree, snapshot } = record;
      const active = () => {
        owner.check();
        if (!/^[a-zA-Z0-9-]+$/.test(id) || !product() || productId !== product() || requestedSource !== source
          || commit !== version.head || tree !== version.tree || snapshot !== join(data, "extra-snapshots", id)
          || record.id !== id || record.productId !== productId || record.source !== requestedSource
          || record.commit !== commit || record.tree !== tree || record.snapshot !== snapshot)
          throw new Error("The supplied validation copy received another request, owner or version");
      };
      active();
      if (existsSync(snapshot)) throw new Error("The supplied validation copy must have its own empty destination");
      await mkdir(join(data, "extra-snapshots"), { recursive: true }); active();
      await cp(baseline, snapshot, { recursive: true, force: false, errorOnExist: true }); active();
    },
  };
}
