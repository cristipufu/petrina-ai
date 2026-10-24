import { afterAll, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createProcessLease } from "@petrina/test-support/process-lease";
import { removeDir, tempDir, waitFor } from "@petrina/test-support/fixtures";
import { rejectionOf } from "@petrina/test-support/rejections";

const root = tempDir("petrina-process-lease-");
const children = new Set<Actor>();
const start = (program: string) => {
  const child = Bun.spawn([process.execPath, "-e", program], { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true });
  children.add(child);
  return child;
};
type Actor = ReturnType<typeof start>;
const stopped = async (child: Actor) => {
  await waitFor(() => child.exitCode !== null, "the fixture actor to exit", 5_000);
  return child.exited;
};
const forceStop = async (child: Actor) => { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; };
afterAll(async () => { await Promise.all([...children].map(forceStop)); removeDir(root); });

async function withOwner(work: (owner: Awaited<ReturnType<typeof createProcessLease>>) => Promise<void>): Promise<void> {
  const owner = await createProcessLease();
  try { await work(owner); } finally { await owner.close(); }
}

it("stops an actor after a failure before any child record is captured", () => withOwner(async owner => {
  const ready = join(root, "failed-ready");
  const actor = start(owner.program(`require("node:fs").writeFileSync(${JSON.stringify(ready)}, ""); await new Promise(() => {});`));
  try {
    const failure = await rejectionOf((async () => {
      try {
        await waitFor(() => existsSync(ready), "the actor to wait before release");
        throw new Error("Controlled failure before capture");
      } finally { await owner.close(); }
    })());
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Controlled failure before capture");
    expect(await stopped(actor)).toBe(78);
    await owner.close();
  } finally { try { await owner.close(); } finally { await forceStop(actor); } }
}));

it("refuses an actor started after teardown without executing its body", () => withOwner(async owner => {
  const ran = join(root, "late-body");
  const program = owner.program(`require("node:fs").writeFileSync(${JSON.stringify(ran)}, "");`);
  await owner.close();
  const actor = start(program);
  try {
    expect(await stopped(actor)).toBe(78);
    expect(existsSync(ran)).toBe(false);
  } finally { await forceStop(actor); }
}));

it("keeps concurrent owners independent", () => withOwner(left => withOwner(async right => {
  const ready = [join(root, "left"), join(root, "right")];
  const actors = [left, right].map((owner, index) => start(owner.program(`require("node:fs").writeFileSync(${JSON.stringify(ready[index])}, ""); await new Promise(() => {});`)));
  try {
    await waitFor(() => ready.every(file => existsSync(file)), "both independent actors to start");
    await left.close();
    expect(await stopped(actors[0]!)).toBe(78);
    expect(actors[1]!.exitCode).toBeNull();
    await right.close();
    expect(await stopped(actors[1]!)).toBe(78);
  } finally { await Promise.all([left.close(), right.close()]); await Promise.all(actors.map(forceStop)); }
})));

it("lets a completed actor exit normally while its owner stays open", () => withOwner(async owner => {
  const ran = join(root, "completed-body");
  const actor = start(owner.program(`require("node:fs").writeFileSync(${JSON.stringify(ran)}, "");`));
  try {
    expect(await stopped(actor)).toBe(0);
    expect(existsSync(ran)).toBe(true);
  } finally { await forceStop(actor); }
}));

it("ends an actor when its owner process dies without running teardown", async () => {
  const recipe = join(root, "abandoned-program.json"), ready = join(root, "abandoned-ready");
  const fixture = new URL("../../../src/process-lease.ts", import.meta.url).href;
  const json = new URL("../../../src/fixture-json.ts", import.meta.url).href;
  const owner = start(`const { createProcessLease } = await import(${JSON.stringify(fixture)});
const { writeFixtureJson } = await import(${JSON.stringify(json)});
const lease = await createProcessLease();
writeFixtureJson(${JSON.stringify(recipe)}, { program: lease.program(${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(ready)}, ""); await new Promise(() => {});`)}) });
await new Promise(() => {});`);
  let actor: Actor | undefined;
  try {
    await waitFor(() => existsSync(recipe), "the owner to publish its complete actor recipe");
    actor = start((JSON.parse(readFileSync(recipe, "utf8")) as { program: string }).program);
    await waitFor(() => existsSync(ready), "the actor to connect to its separate owner");
    owner.kill("SIGKILL");
    await owner.exited;
    expect(await stopped(actor)).toBe(78);
  } finally { await forceStop(owner); if (actor) await forceStop(actor); }
});
