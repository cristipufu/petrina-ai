import { expect, it } from "bun:test";
import { parseProcessGroupMembers } from "../../../src/process-group-snapshots.js";

it("parses POSIX group identity and preserves a spaced command", () => {
  expect(parseProcessGroupMembers(" 712345 712345 Ss Fri Oct  2 08:00:00 2026 /a folder/docker --name owned image\n")).toEqual([
    { pid: 712345, group: 712345, state: "running", birthIdentity: "Fri Oct 2 08:00:00 2026", command: "/a folder/docker --name owned image" },
  ]);
});

it("reports defunct members semantically without exposing native state letters", () => {
  expect(parseProcessGroupMembers("712345 712345 Z+ Fri Oct 23 08:00:00 2026 dead client\n712346 712345 T helper\n")).toEqual([
    { pid: 712345, group: 712345, state: "defunct", birthIdentity: "Fri Oct 23 08:00:00 2026", command: "dead client" },
    { pid: 712346, group: 712345, state: "running", command: "helper" },
  ]);
});

it("retains missing-identity uncertainty and ignores malformed rows", () => {
  expect(parseProcessGroupMembers("712345 712345 S\n712346 712345 S helper\nmalformed\n712347 712345\n")).toEqual([
    { pid: 712345, group: 712345, state: "running", command: "" },
    { pid: 712346, group: 712345, state: "running", command: "helper" },
  ]);
  expect(parseProcessGroupMembers("")).toEqual([]);
});
