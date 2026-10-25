import { describe as originalDescribe } from "vitest";
import { expect, it, vi } from "vitest";
import { ValidationClientCleanup, type ValidationClientProcess } from "../../../src/validation-client.js";

originalDescribe("required extra validation shares the host check queue", () => {
for (const identity of ["saved number", "verified client", "surviving helper", "unknown command"] as const) it(`gives ${identity === "verified client" || identity === "surviving helper" ? `direct advice for a ${identity}` : `safe uncertainty for a ${identity}`}`, async () => {
    const verified = identity === "verified client" || identity === "surviving helper";
    const record = { id: "validation-owned", name: "Owned validation", containerName: "petrina-extra-random", clientPid: undefined as number | undefined, cleanupDetail: undefined as string | undefined };
    const current = { ...record, clientPid: 712345 };
    const command = verified ? `docker run --name ${record.containerName} --label app.petrina.validation-run=${record.id} local:image` : "unrelated-program";
    const start = "Fri Oct 23 08:00:00 2026";
    const before: ValidationClientProcess[] = [{ pid: 712345, group: 712345, state: "running", birthIdentity: start, command },
      { pid: 712346, group: 712345, state: "running", birthIdentity: start, command: "helper" }];
    const read = vi.fn<() => Promise<readonly ValidationClientProcess[] | undefined>>().mockResolvedValue(identity === "unknown command" ? [{ pid: 712345, group: 712345, state: "running", command: "" }] : before);
    let reads = 0;
    if (identity === "surviving helper") read.mockImplementation(async () => reads++ === 0 ? before : [before[1]!]);
    const kill = vi.fn<(group: number) => void>().mockImplementation(() => { throw Object.assign(new Error("Cannot stop client"), { code: "EPERM" }); });
    const observer = new ValidationClientCleanup({ groups: true, read, killGroup: kill });
    try {
      expect(await observer.stop(current)).toBe(false);
      expect(current.cleanupDetail).toContain(identity === "surviving helper" ? "verified local helpers" : verified ? "verified local client" : "may be unrelated");
      if (verified) expect(current.cleanupDetail).not.toContain("restart this computer");
      else { expect(kill).not.toHaveBeenCalled(); expect(current.cleanupDetail).toContain("Do not stop programs based on the saved number"); }
    } finally { read.mockReset(); kill.mockReset(); }
  });
});

originalDescribe("required extra validation shares the host check queue", () => {
for (const identity of ["same helper", "changed start", "changed command", "new member", "missing start", "new observer"] as const) it(`revalidates an observed helper identity: ${identity}`, async () => {
    const record = { id: "validation-owned", name: "Owned validation", containerName: "petrina-extra-random", clientPid: undefined as number | undefined, cleanupDetail: undefined as string | undefined };
    const current = { ...record, clientPid: 712345 };
    const start = "Fri Oct 23 08:00:00 2026";
    const client: ValidationClientProcess = { pid: 712345, group: 712345, state: "running", birthIdentity: start,
      command: `docker run --name ${record.containerName} --label app.petrina.validation-run=${record.id} local:image` };
    const read = vi.fn<() => Promise<readonly ValidationClientProcess[] | undefined>>().mockResolvedValue([client, { pid: 712346, group: 712345, state: "running", birthIdentity: start, command: "helper" }]);
    const kill = vi.fn<(group: number) => void>().mockImplementation(() => { throw Object.assign(new Error("Cannot stop client"), { code: "EPERM" }); });
    const observer = new ValidationClientCleanup({ groups: true, read, killGroup: kill });
    try {
      expect(await observer.stop(current)).toBe(false);
      expect(current.cleanupDetail).toContain("verified local client");
      read.mockResolvedValue([{ pid: identity === "new member" ? 712347 : 712346, group: 712345, state: "running",
        ...(identity === "missing start" ? {} : { birthIdentity: identity === "changed start" ? "Fri Oct 23 08:00:01 2026" : start }),
        command: identity === "changed command" ? "unrelated" : "helper" }]);
      kill.mockClear();
      expect(await (identity === "new observer" ? new ValidationClientCleanup({ groups: true, read, killGroup: kill }) : observer).stop(current)).toBe(false);
      expect(kill).not.toHaveBeenCalled(); // A remembered identity authorizes advice, never a signal.
      expect(current.cleanupDetail).toContain(identity === "same helper" ? "verified local helpers (712346)" : "may be unrelated");
      if (identity === "same helper") expect(current.cleanupDetail).toContain("Stop those owned programs");
      else expect(current.cleanupDetail).toContain("Do not stop programs based on the saved number");
    } finally { read.mockReset(); kill.mockReset(); }
  });
});

originalDescribe("required extra validation shares the host check queue", () => {
it("holds a client first identified by the final lookup even without a saved client number", async () => {
    const record = { id: "validation-owned", name: "Owned validation", containerName: "petrina-extra-random", clientPid: undefined as number | undefined, cleanupDetail: undefined as string | undefined };
    const current = { ...record, clientPid: undefined };
    const identified: ValidationClientProcess[] = [{ pid: 712345, group: 712345, state: "running", birthIdentity: "Fri Oct 23 08:00:00 2026",
      command: `docker run --name ${record.containerName} --label app.petrina.validation-run=${record.id} local:image` }];
    let reads = 0;
    const read = vi.fn<() => Promise<readonly ValidationClientProcess[] | undefined>>().mockImplementation(async () => reads++ === 0 ? [{ pid: 712345, group: 712345, state: "running", command: "" }] : identified);
    const kill = vi.fn<(group: number) => void>().mockImplementation(() => { throw new Error("Unexpected signal from an unidentified first lookup"); });
    const observer = new ValidationClientCleanup({ groups: true, read, killGroup: kill });
    try {
      expect(await observer.stop(current)).toBe(false);
      expect(current.cleanupDetail).toContain("verified local client");
      expect(kill).not.toHaveBeenCalled();
    } finally { read.mockReset(); kill.mockReset(); }
  });
});


it("preserves the owner of a method-backed client observation effect", async () => {
  class Effects {
    groups = true;
    rows: [] = [];
    reads = 0;
    signals = 0;
    async read() { this.reads++; return this.rows; }
    killGroup(_group: number) { this.signals++; }
  }
  const effects = new Effects();
  const cleanup = new ValidationClientCleanup(effects);
  const record = { id: "method-record", name: "method observation", containerName: "method-container" };
  expect(await cleanup.stop(record)).toBe(true);
  expect(effects.reads).toBe(2);
  expect(effects.signals).toBe(0);
});
