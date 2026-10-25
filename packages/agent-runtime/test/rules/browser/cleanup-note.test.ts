import { expect, it } from "bun:test";
import { CLEANUP_NOTE, cleanupNote } from "../../../src/browser-cleanup.js";

it("keeps a cleanup note to one bounded line of fixed words, counts and process numbers", () => {
  const states = ["absent", "running", "finished", "unknown"] as const;
  const processes = Array.from({ length: 40 }, (_, index) => ({ pid: 1_000 + index, state: states[index % 4]!, sources: ["early", "folder"] }));
  const note = cleanupNote(CLEANUP_NOTE, [["stage", "closed-within-wait"], ["helper", "/Users/someone/private folder\nhttps://example.test/?token=secret"]], processes);
  expect(note).toStartWith(`${CLEANUP_NOTE} stage=closed-within-wait helper=`);
  for (const text of ["\n", "/", "?", "=secret", " folder"]) expect(note.slice(CLEANUP_NOTE.length)).not.toContain(text);
  expect(note).toContain("processes=40 shown=16 omitted=24 owned=");
  const shown = note.split(" owned=")[1]!.split(",");
  // Processes still present come first: ten running, then the first six finished.
  expect(shown.map((entry) => entry.split(":")[1])).toEqual([...Array(10).fill("running"), ...Array(6).fill("finished")]);
  expect(shown[0]).toBe("1001:running:early+folder");
  // However long its entries, the line stays within 4 KiB and counts what it leaves out.
  const long = cleanupNote(CLEANUP_NOTE, [["stage", "startup-recovery"]], processes.map((entry) => ({ ...entry, sources: ["x".repeat(400)] })));
  expect(Buffer.byteLength(long)).toBeLessThanOrEqual(4096);
  const [, total, kept, omitted] = /processes=(\d+) shown=(\d+) omitted=(\d+)/.exec(long)!.map(Number);
  expect(total).toBe(40);
  expect(kept).toBeLessThan(16);
  expect(kept! + omitted!).toBe(40);
  expect(long.split(" owned=")[1]!.split(",")).toHaveLength(kept!);
});
