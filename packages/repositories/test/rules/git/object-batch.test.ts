import { expect, it } from "bun:test";
import { parseObjectBatch, treeEntries, treeNames } from "../../../src/object-format.js";

const id = "a".repeat(40);
const frame = (body: Uint8Array) => Buffer.concat([Buffer.from(`${id} blob ${body.length}\n`), body, Buffer.from("\n")]);

it("parses object sizes as bytes and keeps missing newline names separate from later answers", () => {
  const body = Buffer.from([0, 255, 195, 169, 10, 0]);
  const requests = ["HEAD:missing\nname", "HEAD:bytes", "HEAD:empty"];
  const bytes = Buffer.concat([Buffer.from(`${requests[0]} missing\n`), frame(body), frame(Buffer.alloc(0))]);
  const result = parseObjectBatch(bytes, requests);
  expect(result[0]).toBeUndefined();
  expect(result[1]).toEqual({ id, type: "blob", body });
  expect(result[2]!.body).toEqual(Buffer.alloc(0));
});

it("rejects incomplete, ambiguous, malformed and extra batch answers", () => {
  for (const bytes of [Buffer.from(`${id} blob 3\nx\n`), Buffer.from(`${id} blob -1\n\n`),
    Buffer.from("HEAD ambiguous\n"), Buffer.from("some-other-ref missing\n"),
    Buffer.concat([Buffer.from(`${id} blo`), Buffer.from([0xe2]), Buffer.from(" 0\n\n")]),
    Buffer.from(`${id} blob 9007199254740992\n`), Buffer.concat([frame(Buffer.from("x")), Buffer.from("extra")]),
    frame(Buffer.from("x")).subarray(0, -1)]) {
    expect(() => parseObjectBatch(bytes, ["HEAD"])).toThrow("could not be read");
  }
  expect(() => treeNames({ id, type: "tree", body: Buffer.from("100644 name\0short") })).toThrow("could not be read");
  const badMode = Buffer.concat([Buffer.from([0xb1]), Buffer.from("00644 name\0"), Buffer.alloc(20)]);
  expect(() => treeNames({ id, type: "tree", body: badMode })).toThrow("could not be read");
});

it("keeps tree modes, raw names and format-sized object ids separate", () => {
  for (const size of [20, 32]) {
    const name = Buffer.from([0xff, 10, 195, 169]), objectId = Buffer.alloc(size, 0xab);
    const tree = { id: "a".repeat(size * 2), type: "tree" as const,
      body: Buffer.concat([Buffer.from("100700 "), name, Buffer.from([0]), objectId,
        Buffer.from("040000 directory\0"), Buffer.alloc(size, 0xcd)]) };
    expect(treeEntries(tree)).toEqual([
      { mode: 0o100700, name, id: "ab".repeat(size) },
      { mode: 0o40000, name: Buffer.from("directory"), id: "cd".repeat(size) },
    ]);
    expect(treeNames(tree)).toEqual([name.toString("utf8"), "directory"]);
    expect(() => treeEntries({ ...tree, body: tree.body.subarray(0, -1) })).toThrow("could not be read");
  }
});
