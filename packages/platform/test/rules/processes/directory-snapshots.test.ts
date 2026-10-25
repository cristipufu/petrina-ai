import { expect, it } from "bun:test";
import { namesProcessFolder, processFolderSnapshot } from "../../../src/process-directory-snapshots.js";

it("retains all completed process states while naming only the exact scoped folder boundaries", () => {
  const root = "/private/fixture-session";
  const listed = `41 1 S browser ${root}/user-data\n42 1 Z helper\n43 1 S browser ${root}-other\n44 1 S browser ${root}\n`;
  const snapshot = processFolderSnapshot(listed, root);
  expect(snapshot.pids).toEqual([41, 44]);
  expect([...snapshot.states]).toEqual([[41, "running"], [42, "finished"], [43, "running"], [44, "running"]]);
  expect(snapshot.commands).toHaveLength(2);
});

it("keeps the first matching state for duplicate rows and unknown for absent state columns", () => {
  const snapshot = processFolderSnapshot("41 1 Z command /owned\n41 1 S later /owned\n42 1\n", "/owned");
  expect(snapshot.pids).toEqual([41, 41]);
  expect(snapshot.states.get(41)).toBe("finished");
  expect(snapshot.states.get(42)).toBe("unknown");
  expect(snapshot.states.has(43)).toBe(false);
});

it("matches a path argument or child path while rejecting prefix neighbours", () => {
  for (const directory of ["/owned folder", "C:\\owned folder"])
    for (const suffix of ["", " ", "/profile"])
      expect(namesProcessFolder(`browser ${directory}${suffix}`, directory)).toBe(true);
  expect(namesProcessFolder("browser /owned-neighbour", "/owned")).toBe(false);
});
