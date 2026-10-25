import { clone } from "../../fixtures/discovery.js";
import { fixtureFiles } from "@petrina/test-support/fixture-files";
import { describe, afterAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codeFolders, findClones } from "@petrina/repositories/discovery";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";

const temp = tempDir("petrina-setup-contract-");
afterAll(() => removeDir(temp));
let made = 0;
const fresh = (name: string) => join(temp, `${name}-${++made}`);

describe("The clone finder", () => {
it("finds only GitHub clones, two levels deep, newest first, reading files and running nothing", async () => {
    const home = fresh("home");
    const marker = join(temp, "ran-something");
    const now = Date.now();
    clone(join(home, "code", "shop"), "git@github.com:acme/shop.git", now - 1000, `\tfsmonitor = touch ${marker}\n`);
    clone(join(home, "code", "acme", "blog"), "https://github.com/acme/blog.git", now);
    clone(join(home, "Projects", "old"), "https://github.com/acme/old", now - 100_000);
    clone(join(home, "code", "elsewhere"), "https://gitlab.com/acme/elsewhere.git", now);
    clone(join(home, "code", "a", "b", "too-deep"), "https://github.com/acme/deep.git", now);
    // A worktree has a .git file, not a folder: not a clone of its own.
    mkdirSync(join(home, "code", "worktree"), { recursive: true });
    writeFileSync(join(home, "code", "worktree", ".git"), "gitdir: /somewhere/else\n");
    // A link out of the code folders is never followed.
    const outside = fresh("outside");
    clone(join(outside, "secret"), "https://github.com/acme/secret.git", now);
    fixtureFiles.directoryLink(join(outside, "secret"), join(home, "code", "linked"));
    fixtureFiles.directoryLink(outside, join(home, "code", "linked-folder"));

    const found = await findClones({ home });
    expect(found.map((entry) => entry.repo)).toEqual(["acme/blog", "acme/shop", "acme/old"]);
    expect(found[1]!.path).toBe(join(home, "code", "shop"));
    // Nothing ran inside the clones: git would have run the fsmonitor setting.
    expect(existsSync(marker)).toBe(false);

    // Nor a link on the way to a code folder: Documents in Documents/GitHub, source in source/repos.
    const documents = fresh("documents-elsewhere");
    clone(join(documents, "GitHub", "private"), "https://github.com/acme/private.git", now);
    fixtureFiles.directoryLink(documents, join(home, "Documents"));
    const source = fresh("source-elsewhere");
    clone(join(source, "repos", "hidden"), "https://github.com/acme/hidden.git", now);
    fixtureFiles.directoryLink(source, join(home, "source"));
    expect((await findClones({ home, platform: "linux" })).map((entry) => entry.repo)).toEqual(["acme/blog", "acme/shop", "acme/old"]);
    expect((await findClones({ home, platform: "win32" })).map((entry) => entry.repo)).toEqual(["acme/blog", "acme/shop", "acme/old"]);

    for (let index = 0; index < 8; index += 1) clone(join(home, "repos", `r${index}`), `https://github.com/acme/r${index}`, now + index);
    expect(await findClones({ home })).toHaveLength(6);
    expect((await findClones({ home, skip: (path) => path.endsWith("r7") }))[0]!.repo).toBe("acme/r6");
  });
});

describe("The clone finder", () => {
it("stays out of the folders a Mac guards with a permission window", async () => {
    const home = fresh("home");
    clone(join(home, "Documents", "GitHub", "site"), "https://github.com/acme/site.git", Date.now());
    expect(codeFolders("darwin")).not.toContain(join("Documents", "GitHub"));
    expect((await findClones({ home, platform: "darwin" })).map((entry) => entry.repo)).toEqual([]);
    expect((await findClones({ home, platform: "linux" })).map((entry) => entry.repo)).toEqual(["acme/site"]);
  });
});

describe("The clone finder", () => {
it("does not follow a shortcut in a clone's history folder", async () => {
    const home = fresh("home");
    const now = Date.now();
    const olderAt = now - 50_000;
    const middleAt = now - 10_000;
    clone(join(home, "code", "older"), "https://github.com/acme/older.git", olderAt);
    clone(join(home, "code", "middle"), "https://github.com/acme/middle.git", middleAt);
    clone(join(home, "code", "newer"), "https://github.com/acme/newer.git", now);
    const outside = fresh("outside-history");
    mkdirSync(outside, { recursive: true });
    const head = join(outside, "HEAD");
    writeFileSync(head, "ref: refs/heads/main\n");
    const future = new Date(now + 100_000);
    utimesSync(head, future, future);
    // The history folder itself points outside the code folders.
    fixtureFiles.directoryLink(outside, join(home, "code", "older", ".git", "logs"));
    // A file shortcut inside a real history folder points at the same outside file.
    mkdirSync(join(home, "code", "middle", ".git", "logs"), { recursive: true });
    fixtureFiles.fileLink(head, join(home, "code", "middle", ".git", "logs", "HEAD"));
    // Adding those shortcuts touches the clone's own folder date; put it back, so only a followed link could reorder.
    const olderWhen = new Date(olderAt);
    utimesSync(join(home, "code", "older", ".git"), olderWhen, olderWhen);
    utimesSync(join(home, "code", "older", ".git", "HEAD"), olderWhen, olderWhen);
    const middleWhen = new Date(middleAt);
    utimesSync(join(home, "code", "middle", ".git"), middleWhen, middleWhen);
    utimesSync(join(home, "code", "middle", ".git", "HEAD"), middleWhen, middleWhen);

    expect((await findClones({ home })).map((entry) => entry.repo)).toEqual(["acme/newer", "acme/middle", "acme/older"]);
  });
});
