import { afterAll, expect, it, spyOn } from "bun:test";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitWith } from "@petrina/test-support/commands";
import { tempDir } from "@petrina/test-support/fixtures";
import { repositorySeed } from "@petrina/test-support/repositories";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { registerFixtureRoot } from "@petrina/test-support/fixture-retention";
import { CLEANUP_MS } from "@petrina/test-support/commands";
import { SLOW } from "@petrina/test-support/slow";
import { expectRejection } from "@petrina/test-support/rejections";
import { commitAndFile, plainFilesAt, readObjects, treeNames } from "../../../src/object-batch.js";
import { plainFileAt } from "../../../src/git.js";

const root = tempDir("petrina-object-packets-");
registerFixtureRoot(root);
const owner = new FixtureOperations({ label: `Git object packets at ${root}`, stop() {},
  dispose: () => rmSync(root, { recursive: true, force: true }), allowanceMs: CLEANUP_MS * SLOW,
  arm: (expired, ms) => { const timer = setTimeout(expired, ms); return () => clearTimeout(timer); } });
afterAll(() => owner.close());

for (const format of ["sha1", "sha256"] as const) it(`reads a complete ${format} object packet once, preserving bytes and pinned history`, () => owner.run(async () => {
  const folder = join(root, format); mkdirSync(folder);
    const seed = await repositorySeed(undefined, false, format), repo = join(folder, "repo");
    cpSync(seed.clone, repo, { recursive: true });
    const guide = "\ufeff\n# Original rules\r\n \n", name = process.platform === "win32" ? "space ü.txt" : "line\nspace ü.txt";
    const binary = Buffer.concat([Buffer.from([0, 255, 195, 169, 10, 0, 10]), Buffer.alloc(1024 * 1024, 255)]);
    writeFileSync(join(repo, "REVIEW.md"), guide);
    writeFileSync(join(repo, name), binary);
    if (process.platform !== "win32") writeFileSync(join(repo, "carriage\r"), binary);
    mkdirSync(join(repo, "packages"));
    writeFileSync(join(repo, "packages", "empty"), "");
    await git(repo, "add", "."); await git(repo, "commit", "-qm", "Pinned packet");
    const base = await git(repo, "rev-parse", "HEAD"), tree = await git(repo, "rev-parse", "HEAD^{tree}");
    const binaryId = await git(repo, "rev-parse", `${base}:${name}`);
    writeFileSync(join(repo, "REVIEW.md"), "Later rules must not replace the pinned guide\n");
    await git(repo, "add", "."); await git(repo, "update-index", "--chmod=+x", "REVIEW.md");
    await git(repo, "commit", "-qm", "Later rules");
    const head = await git(repo, "rev-parse", "HEAD"), currentTree = await git(repo, "rev-parse", "HEAD^{tree}");
    const spawn = Bun.spawn; let calls = 0;
    const watch = spyOn(Bun, "spawn").mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
      if (args[0][0] === "git" && args[1]?.cwd === repo) calls++;
      return Reflect.apply(spawn, Bun, args);
    }) as typeof Bun.spawn);
    try {
      const [rootTree, document, bytes, missing, empty, directory] = await readObjects(repo,
        [tree, `${base}:REVIEW.md`, binaryId, `${base}:missing-file`, `${base}:packages/empty`, `${base}:packages`]);
      expect(calls).toBe(1);
      expect(rootTree!.id).toBe(tree); expect(treeNames(rootTree!)).toContain(name);
      expect(document!.body.toString("utf8")).toBe(guide);
      expect(bytes!.body).toEqual(binary); expect(missing).toBeUndefined(); expect(empty!.body.length).toBe(0);
      expect(treeNames(directory!)).toEqual(["empty"]);
      expect(await commitAndFile(repo, "HEAD", base, "REVIEW.md")).toEqual({ head, tree: currentTree, text: guide });
      expect(calls).toBe(2);
      expect(await commitAndFile(repo, base, base, "absent")).toEqual({ head: base, tree });
      expect(calls).toBe(3);
      expect(await plainFilesAt(repo, [base, "HEAD", tree, "0".repeat(base.length), directory!.id], "REVIEW.md")).toEqual([
        { mode: "100644", text: guide }, { mode: "100755", text: "Later rules must not replace the pinned guide\n" },
        { mode: "100644", text: guide }, undefined, undefined,
      ]);
      expect(calls).toBe(5);
      expect(await plainFilesAt(repo, ["-bad", "", "HEAD\0other"], "REVIEW.md")).toEqual([undefined, undefined, undefined]);
      expect(await plainFilesAt(repo, [base], "packages/empty")).toEqual([undefined]);
      expect(calls).toBe(5);
    } finally { watch.mockRestore(); }
    const documentId = await git(repo, "rev-parse", `${base}:REVIEW.md`);
    const entries = [["100600", documentId], ["100700", documentId], ["120000", documentId],
      ["40000", tree], ["160000", base], ["100644", "0".repeat(base.length)]] as const;
    const paths = entries.map(([mode, id], index) => {
      const path = join(folder, `root-file-${index}`);
      writeFileSync(path, Buffer.concat([Buffer.from(`${mode} REVIEW.md\0`), Buffer.from(id, "hex")]));
      return path;
    });
    // Deliberately noncanonical modes and a missing blob must reach the readers unchanged.
    const versions = (await gitWith({ cwd: repo, input: paths.join("\n") + "\n" }, "hash-object", "--literally", "-w", "-t", "tree", "--stdin-paths")).split("\n");
    const prior = [];
    for (const version of versions) prior.push(await plainFileAt(repo, version, "REVIEW.md"));
    expect(prior).toEqual([{ mode: "100644", text: guide }, { mode: "100755", text: guide }, undefined, undefined, undefined, undefined]);
    expect(await plainFilesAt(repo, versions, "REVIEW.md")).toEqual(prior);
    const [odd, missing] = await readObjects(repo, [`${base}:${name}`, `${base}:missing\nfile`]);
    expect(odd!.body).toEqual(binary); expect(missing).toBeUndefined();
    if (process.platform !== "win32") expect((await readObjects(repo, [`${base}:carriage\r`]))[0]!.body).toEqual(binary);
    await expectRejection(commitAndFile(repo, "0".repeat(base.length), base, "REVIEW.md"), "committed version");
    await expectRejection(readObjects(join(folder, "absent"), ["HEAD"]), "could not read");
    await expectRejection(readObjects(repo, ["HEAD\0other"]), "Not a Git object request");
}));
