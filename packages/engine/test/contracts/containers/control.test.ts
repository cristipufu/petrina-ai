import { afterAll, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createProcessLease, type ProcessLease } from "@petrina/test-support/process-lease";
import { rejectionOf } from "@petrina/test-support/rejections";
import { SLOW } from "@petrina/test-support/slow";
import type { ContainerTarget } from "../../../src/container-control.js";
import { nativeContainerControl, OWNER_LABEL, RUN_LABEL } from "../../../src/extra-container.js";
import { scriptedContainerControl } from "../../fixtures/container-inspection.js";
import { engineCaseFixtures } from "../../fixtures/engine-cases.js";

const cases = engineCaseFixtures();
afterAll(() => cases.close());
const target: ContainerTarget = { endpoint: "unix:///private-fake-service", owner: "private-owner", runId: "control", name: "petrina-extra-control" };
const calls = (folder: string) => readFileSync(join(folder, "calls"), "utf8").trim().split("\n").map(line => JSON.parse(line));

it("matches native owned-service filtering, refusal and removal with explicit service controls", () => cases.use("petrina-container-control-", async owner => {
  for (const state of ["ready", "offline", "cleanup-off", "removal-pending"] as const) {
    owner.check();
    const native = join(owner.root, state, "native"), scripted = join(owner.root, state, "scripted");
    for (const folder of [native, scripted]) {
      mkdirSync(join(folder, "containers"), { recursive: true });
      // These are supplied service entries, not execution evidence or persisted validation receipts.
      const entry = (name: string, labels: string[]) => writeFileSync(join(folder, "containers", name), JSON.stringify({ labels }));
      entry(target.name, [`${OWNER_LABEL}=${target.owner}`, `${RUN_LABEL}=${target.runId}`]);
      entry("another-owner", [`${OWNER_LABEL}=another`, `${RUN_LABEL}=${target.runId}`]);
      entry("another-run", [`${OWNER_LABEL}=${target.owner}`, `${RUN_LABEL}=another`]);
      entry("unpublished.tmp", [`${OWNER_LABEL}=${target.owner}`, `${RUN_LABEL}=${target.runId}`]);
      if (state !== "ready") writeFileSync(join(folder, state), "Supplied service state");
    }
    const controls = [nativeContainerControl([process.execPath, join(import.meta.dir, "../../fake-extra-container.ts"), native], join(native, "config")),
      scriptedContainerControl(scripted, () => target.owner)];
    for (const [control, folder] of [[controls[0]!, native], [controls[1]!, scripted]] as const) {
      if (state === "offline" || state === "cleanup-off") {
        expect(await rejectionOf(control.list(target, 4_000 * SLOW))).toBeInstanceOf(Error);
        expect(await rejectionOf(control.stop(target, 4_000 * SLOW))).toBeInstanceOf(Error);
        expect(await rejectionOf(control.remove(target, 4_000 * SLOW))).toBeInstanceOf(Error);
        expect(existsSync(join(folder, "containers", target.name))).toBe(true);
      } else {
        expect(await control.list(target, 4_000 * SLOW)).toEqual([target.name]);
        await control.stop(target, 4_000 * SLOW);
        if (state === "removal-pending") {
          expect(await control.list(target, 4_000 * SLOW)).toEqual([target.name]);
          expect(String(await rejectionOf(control.remove(target, 4_000 * SLOW)))).toContain("Removal already in progress");
          expect(await control.list(target, 4_000 * SLOW)).toEqual([target.name]);
          expect(existsSync(join(folder, "removal-observed"))).toBe(true);
          writeFileSync(join(folder, "finish-removal"), "Supplied service removal completes");
        } else {
          expect(await control.list(target, 4_000 * SLOW)).toEqual([]);
          await control.remove(target, 4_000 * SLOW);
          expect(existsSync(join(folder, "containers", "another-owner"))).toBe(true);
          expect(existsSync(join(folder, "containers", "another-run"))).toBe(true);
        }
        expect(await control.list(target, 4_000 * SLOW)).toEqual([]);
        expect(existsSync(join(folder, "containers", target.name))).toBe(false);
      }
    }
    expect(calls(scripted)).toEqual(calls(native));
    const before = readFileSync(join(scripted, "calls"), "utf8");
    for (const change of [{ endpoint: "unix:///another-service" }, { owner: "another-owner" }, { runId: "another-run" }, { name: "another-name" }]) {
      expect(String(await rejectionOf(controls[1]!.list({ ...target, ...change }, 4_000 * SLOW)))).toContain("another service or owner");
      expect(String(await rejectionOf(controls[1]!.stop({ ...target, ...change }, 4_000 * SLOW)))).toContain("another service or owner");
      expect(String(await rejectionOf(controls[1]!.remove({ ...target, ...change }, 4_000 * SLOW)))).toContain("another service or owner");
    }
    expect(readFileSync(join(scripted, "calls"), "utf8")).toBe(before);
  }
}));

it("keeps control argv, private environment, output decoding and refusals at the native boundary", () => cases.use("petrina-container-control-", async owner => {
  const journal = join(owner.root, "transport.jsonl"), reply = join(owner.root, "reply.json"), cli = join(owner.root, "control.ts");
  writeFileSync(cli, `import { appendFileSync, readFileSync } from 'node:fs';
const [journal, reply, ...args] = process.argv.slice(2);
appendFileSync(journal, JSON.stringify({ args, env: process.env }) + '\\n');
const result = JSON.parse(readFileSync(reply, 'utf8'));
process.stdout.write(result.text); if (result.error) process.stderr.write(result.error); process.exitCode = result.code ?? 0;
`);
  const config = join(owner.root, "config ; private"), selected = { ...target, endpoint: "unix:///private;endpoint", name: "name ; $(unused)" };
  const control = nativeContainerControl([process.execPath, cli, journal, reply], config);
  const answer = (text: string, code = 0, error = "") => writeFileSync(reply, JSON.stringify({ text, code, error }));
  answer("  first\nsecond\tthird  \n");
  expect(await control.list(selected, 4_000 * SLOW)).toEqual(["first", "second", "third"]);
  answer(""); await control.stop(selected, 4_000 * SLOW); await control.remove(selected, 4_000 * SLOW);
  const observed = readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const prefix = ["--config", config, "--host", selected.endpoint];
  expect(observed.map(entry => entry.args)).toEqual([
    [...prefix, "ps", "--all", "--filter", `label=${OWNER_LABEL}=${selected.owner}`, "--filter", `label=${RUN_LABEL}=${selected.runId}`, "--format", "{{.Names}}"],
    [...prefix, "stop", "--timeout", "2", selected.name], [...prefix, "rm", "--force", selected.name],
  ]);
  for (const entry of observed) {
    expect(entry.env.HOME).toBe(process.env.HOME);
    expect(entry.env.DOCKER_CONFIG).toBeUndefined(); expect(entry.env.DOCKER_CONTEXT).toBeUndefined(); expect(entry.env.DOCKER_HOST).toBeUndefined();
    expect(entry.env.GIT_CONFIG_GLOBAL).toBeUndefined(); expect(entry.env.PETRINA_HOME).toBeUndefined();
  }
  answer("", 23, "Private control refusal");
  for (const operation of ["list", "stop", "remove"] as const)
    expect(String(await rejectionOf(control[operation](selected, 4_000 * SLOW)))).toContain("Private control refusal");
  const absent = nativeContainerControl([join(owner.root, "absent-tool")], config);
  expect(await rejectionOf(absent.list(target, 4_000 * SLOW))).toBeInstanceOf(Error);
}));

it("enforces each native control deadline and confirms its actual process ended before releasing the owner", () => cases.use("petrina-container-deadline-", async owner => {
  let lease: ProcessLease | undefined;
  const children: Bun.Subprocess[] = [];
  owner.onStop(async () => { await lease?.close(); await Promise.all(children.map(child => child.exited)); });
  lease = await createProcessLease();
  try { owner.check(); } catch (error) { await lease.close(); throw error; }
  const cli = join(owner.root, "held-control.ts"), mark = join(owner.root, "entered");
  writeFileSync(cli, lease.program(`require('node:fs').writeFileSync(${JSON.stringify(mark)}, String(process.pid)); setInterval(() => {}, 1000); await new Promise(() => {});`));
  const spawn = Bun.spawn;
  const watch = spyOn(Bun, "spawn"); owner.onStop(() => watch.mockRestore());
  watch.mockImplementation(((...args: Parameters<typeof Bun.spawn>) => {
    const child = Reflect.apply(spawn, Bun, args) as Bun.Subprocess;
    const input: unknown = args[0];
    const argv = Array.isArray(input) ? input : input && typeof input === "object" && "cmd" in input ? input.cmd : undefined;
    if (Array.isArray(argv) && argv.includes(cli)) children.push(child);
    return child;
  }) as typeof Bun.spawn);
  const control = nativeContainerControl([process.execPath, cli], join(owner.root, "config"));
  for (const operation of ["list", "stop", "remove"] as const) {
    owner.check(); rmSync(mark, { force: true });
    expect(await rejectionOf(control[operation](target, 1_000 * SLOW))).toBeInstanceOf(Error);
    const child = children.at(-1)!;
    expect(readFileSync(mark, "utf8")).toBe(String(child.pid));
    await child.exited;
    expect(child.signalCode !== null || child.exitCode !== 0).toBe(true);
  }
  expect(children).toHaveLength(3);
  watch.mockRestore();
}));
