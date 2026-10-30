import { afterAll, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ValidationRecord } from "@petrina/orchestrator";
import { commitVersion, isClean } from "@petrina/repositories/git";
import { localFiles } from "@petrina/platform/file-operations";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { expectRejection } from "@petrina/test-support/rejections";
import { makeProduct } from "../../fixtures.js";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";
import { preparedValidationSnapshots } from "../../fixtures/validation-snapshots.js";
import { ExtraContainer } from "../../../src/extra-container.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());

it("supplies the exact saved version in private request copies and rejects another owner before copying", async () => {
  const late = await cases.use("petrina-validation-copy-", async owner => {
    const source = fixtureFiles.canonical(await makeProduct(owner.root)); owner.check();
    const data = join(owner.root, "data"), version = await commitVersion(source); owner.check();
    const copies = await preparedValidationSnapshots(owner, source, data, () => "product"); owner.check();
    const request = (id: string): ValidationRecord => ({ id, requestId: id, taskId: "task", productId: "product", productName: "Private product",
      repository: "private", source, name: "Copy input", reason: "Saved-copy calibration", image: "unused", argv: ["unused"],
      commit: version.head!, tree: version.tree!, versionNote: "Saved version only", workingEdits: false,
      host: { system: process.platform, arch: process.arch }, containerName: "unused", owner: "fixture",
      snapshot: join(data, "extra-snapshots", id), state: "queued", queuedAt: 0, queueOrder: 1 });
    writeFileSync(join(source, "working-edit.txt"), "An unsaved source edit\n");
    const native = request("native"), first = request("first"), second = request("second");
    const original = structuredClone([native, first, second]);
    await new ExtraContainer({ dataDir: data, files: localFiles, options: {} }).snapshot(native); owner.check();
    await copies.snapshot(first); owner.check(); await copies.snapshot(second); owner.check();
    for (const record of [native, first, second]) {
      expect(await commitVersion(record.snapshot)).toEqual(version);
      expect(await isClean(record.snapshot)).toBe(true);
      expect(existsSync(join(record.snapshot, "working-edit.txt"))).toBe(false);
      expect(readFileSync(join(record.snapshot, "README.md"))).toEqual(readFileSync(join(source, "README.md")));
    }
    expect([native, first, second]).toEqual(original);
    writeFileSync(join(first.snapshot, "private.txt"), "Only the first request\n");
    writeFileSync(join(first.snapshot, ".git", "private-metadata"), "Only the first request\n");
    expect(existsSync(join(second.snapshot, "private.txt"))).toBe(false);
    expect(existsSync(join(second.snapshot, ".git", "private-metadata"))).toBe(false);
    expect(existsSync(join(source, "private.txt"))).toBe(false);
    for (const changed of [{ productId: "another" }, { source: second.snapshot }, { commit: "0".repeat(version.head!.length) },
      { tree: "0".repeat(version.tree!.length) }, { snapshot: join(owner.root, "outside") }]) {
      const wrong = { ...request("wrong"), ...changed };
      await expectRejection(copies.snapshot(wrong), "another request, owner or version");
      expect(existsSync(wrong.snapshot)).toBe(false);
    }
    await expectRejection(copies.snapshot(first), "own empty destination");
    return () => copies.snapshot(request("late"));
  });
  await expectRejection(late(), "Engine case is closing");
});
