import { afterAll, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RepoOrientation } from "@petrina/repositories/navigation";
import { git } from "@petrina/test-support/commands";
import { makeProduct } from "@petrina/test-support/repositories";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
it("reuses navigation for one committed tree and refreshes it when that tree changes", async () => {
  const root = tempDir("petrina-repo-navigation-"); roots.push(root);
  const path = await makeProduct(root), product = { id: "p", name: "Product", repo: "local/p", path, defaultBranch: "main", tone: "blue" as const };
  const navigation = new RepoOrientation();
  const first = await navigation.read(product);
  expect(first!.body).toContain("Navigation only");
  expect(await navigation.read(product)).toBe(first);
  writeFileSync(join(path, "package.json"), JSON.stringify({ scripts: { test: "new-test-command" } }));
  expect(await navigation.read(product)).toBe(first);
  await git(path, "add", "."); await git(path, "commit", "-qm", "Record the new package");
  const changed = await navigation.read(product);
  expect(changed).not.toBe(first);
  expect(changed!.body).toContain("new-test-command");
});
