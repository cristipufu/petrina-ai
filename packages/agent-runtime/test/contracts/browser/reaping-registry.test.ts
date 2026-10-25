import { afterAll, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { recoverBrowserTemps, CLEANUP_NOTE } from "../../../src/browser.js";
import type { BrowserProcessControl } from "@petrina/platform/browser-processes";
import { expectRejection } from "@petrina/test-support/rejections";
import { tempDir, testBrowserRoot, removeDir } from "@petrina/test-support/fixtures";
const root = tempDir("petrina-browser-registry-controls-");
const browsers = testBrowserRoot();
afterAll(() => { removeDir(root); removeDir(browsers); });
const notePattern = (fields: string) => new RegExp(`^${`${CLEANUP_NOTE} ${fields}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("elapsed=\\?", "elapsed=\\d+ms")}\\n?$`);

for (const { name, shown, ends, failure } of [
  { name: "stopped", shown: ["listed", "", ""], ends: "after the first wait" },
  { name: "still running", shown: ["listed", "listed", "listed"], ends: "never", failure: { wording: "Some of its programs are still running.", note: "folder1=1 folder2=1 folder3=1 confirmed=no reasons=still-running processes=1 shown=1 omitted=0 owned=1234567890:running:folder" } },
  { name: "stops during the final wait after losing its folder name", shown: ["listed", "unmarked", "unmarked"], ends: "during the final wait" },
  { name: "still running after losing its folder name", shown: ["listed", "unmarked", "unmarked"], ends: "never", failure: { wording: "Some of its programs are still running.", note: "folder1=1 folder2=0 folder3=0 confirmed=yes reasons=still-running processes=1 shown=1 omitted=0 owned=1234567890:running:folder" }, changed: true },
  { name: "stopped, confirmed by the final scan after an unreadable one", shown: ["listed", undefined, ""], ends: "after the first wait" },
  { name: "stopped, with no readable scan after it", shown: ["listed", undefined, undefined], ends: "after the first wait", failure: { wording: "Petrina could not read the list of running programs.", note: "folder1=1 folder2=unavailable folder3=unavailable confirmed=no reasons=list-unreadable processes=1 shown=1 omitted=0 owned=1234567890:absent:folder" }, changed: true },
  // An earlier clear scan no longer counts once a later one finds a process.
  { name: "appeared after a clear scan, with no readable scan after it", shown: ["", "listed", undefined], ends: "once killed", failure: { wording: "Petrina could not read the list of running programs.", note: "folder1=0 folder2=1 folder3=unavailable confirmed=no reasons=list-unreadable processes=1 shown=1 omitted=0 owned=1234567890:absent:folder" }, changed: true },
]) it(`checks final browser termination after the first cleanup wait (${name})`, async () => {
  const registry = join(root, `late-browser-stop-${name.replace(/\W+/g, "-")}`);
  const directory = mkdtempSync(join(browsers, "petrina-browser-"));
  mkdirSync(registry);
  writeFileSync(join(registry, "owned.json"), JSON.stringify(directory));
  const pid = 1_234_567_890;
  let scans = 0, killed = false, finalChecks = 0, released = false;
  const notes: string[] = [];
  let time = 0;
  const clock = { now: () => time, pause: async (ms: number) => { time += ms; } };
  const effects: BrowserProcessControl = {
    observer: 1, groups: true,
    descendants: async () => { throw new Error("Unexpected helper tree observation"); },
    descendantsKnown: async () => { throw new Error("Unexpected helper tree retry"); },
    async readFolder() {
      scans++;
      const output = shown[scans - 1];
      return output === undefined ? undefined : { pids: output === "listed" ? [pid] : [], states: new Map(output ? [[pid, "running" as const]] : []) };
    },
    forceKill(pids) { if (pids.includes(pid)) killed = true; },
    exists(target) {
      if (target !== pid) throw new Error("Unexpected ownership query");
      if (ends === "during the final wait" && scans === 2) released ||= ++finalChecks > 1;
      const gone = ends === "after the first wait" ? scans >= 2 : ends === "once killed" ? killed : released;
      return !gone;
    },
  };
  try {
    const recovery = recoverBrowserTemps(registry, browsers, (note) => notes.push(note), effects, clock);
    if (failure) await expectRejection(recovery, `Petrina could not confirm that a background browser from an earlier session stopped. ${failure.wording}`);
    else await recovery;
    expect(scans).toBe(3);
    expect(existsSync(directory)).toBe(!!failure);
    expect(existsSync(registry)).toBe(!!failure);
    {
      expect(notes).toHaveLength(failure ? 1 : 0);
      if (failure) expect(notes[0]).toMatch(notePattern(`stage=startup-recovery elapsed=? helper=not-tracked early=not-taken tree=not-taken ${failure.note}`));
    }
  } finally { removeDir(directory); removeDir(registry); }
});
