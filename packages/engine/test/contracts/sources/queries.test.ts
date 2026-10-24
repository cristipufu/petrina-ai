import { afterAll, expect, it } from "bun:test";
import { sourceQueries } from "../../../src/source-queries.js";
import { removeDir, tempDir } from "../../fixtures.js";
import { expectRejection } from "../../rejections.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const folder = () => { const root = tempDir("source-queries-"); roots.push(root); return root; };
/** An owned protocol peer, not an installed CLI or signed-in account. */
const reply = (data: unknown, code = 0) => [process.execPath, "-e", `console.log(${JSON.stringify(JSON.stringify(data))}); process.exit(${code});`, "--"];

it("uses real Git's branch grammar, including Unicode and option-like invalid input", async () => {
  const queries = sourceQueries(folder(), reply({}));
  for (const name of ["release/été+2", "feature.with-dots"]) expect(await queries.validBranch(name)).toBe(true);
  for (const name of ["--help", "two words", "bad..name", "topic.lock"]) expect(await queries.validBranch(name)).toBe(false);
});

it("decodes a matching repository identity and its default branch", async () => {
  const queries = sourceQueries(folder(), reply({ nameWithOwner: "ACME/Shop", defaultBranchRef: { name: "trunk" } }));
  expect(await queries.repository("acme/shop")).toEqual({ repo: "ACME/Shop", defaultBranch: "trunk" });
});

it("rejects mismatched, incomplete and failed repository replies instead of returning a candidate", async () => {
  const root = folder();
  for (const data of [null, { nameWithOwner: 7 }, { nameWithOwner: "acme/shop", defaultBranchRef: { name: 42 } }, { nameWithOwner: "other/repo", defaultBranchRef: { name: "main" } }, { nameWithOwner: "acme/shop" }]) {
    await expectRejection(sourceQueries(root, reply(data)).repository("acme/shop"), "GitHub did not confirm acme/shop and its default branch");
  }
  await expectRejection(sourceQueries(root, reply({}, 1)).repository("acme/shop"), "Could not check acme/shop on GitHub");
});

it("returns a validated PR working identity and rejects an incomplete reply", async () => {
  const root = folder();
  const data = { number: 7, url: "https://github.com/acme/shop/pull/7", state: "OPEN", title: "Change", body: "Details", headRefName: "topic", headRefOid: "a".repeat(40), headRepository: { nameWithOwner: "contributor/fork" } };
  expect(await sourceQueries(root, reply(data)).pullRequest("acme/shop", 7)).toMatchObject({ number: 7, headRepo: "contributor/fork", branch: "topic", state: "open" });
  await expectRejection(sourceQueries(root, reply({ ...data, headRefName: "" })).pullRequest("acme/shop", 7), "GitHub's details for PR #7 are incomplete");
});
