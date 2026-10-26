import { expect, it } from "bun:test";
import { AGENT_CLEANUP_NOTE, cleanupNote } from "../../../src/browser-cleanup.js";

// The exact five negative note shapes formerly asserted beside native defunct actors.
for (const list of ["unreadable", "late", "throws", "running", "silent"] as const) it(`preserves the agent cleanup diagnostic when the final list is ${list}`, () => {
  const pid = 417;
  const state = ({ unreadable: "unknown", late: "unknown", throws: "unknown", running: "running", silent: "absent" } as const)[list];
  const note = cleanupNote(AGENT_CLEANUP_NOTE, [["stage", "forced"], ["elapsed", "123ms"], ["lists", "read,read"]], [{ pid, state, sources: ["target"] }]);
  expect(note).toMatch(new RegExp(`^${AGENT_CLEANUP_NOTE} stage=forced elapsed=\\d+ms lists=read,read processes=\\d+ shown=\\d+ omitted=0 owned=.*${pid}:${state}:target`));
});
