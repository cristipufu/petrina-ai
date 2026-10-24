import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { childState } from "@petrina/platform/process-tree";
import { EngineProcess, removeDir, tempDir } from "./support.js";
import { rejectionOf } from "@petrina/test-support/rejections";

const root = tempDir("petrina-engine-process-");
const children = new Set<EngineProcess["proc"]>();
afterAll(async () => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.allSettled([...children].map(child => child.exited));
  removeDir(root);
});
const home = () => join(root, crypto.randomUUID());
const onProcess = (child: EngineProcess["proc"]) => { children.add(child); };
const hello = { type: "ready", owned: true, url: "http://localhost/🧩-café", token: "fixture-only" } as const;
const program = (text: string) => ["-e", text];

async function failed(promise: Promise<unknown>): Promise<Error> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

it("drains a full stderr pipe before startup, decodes split Unicode and retains the exact error output", async () => {
  const errors = "fixture diagnostic\n".repeat(20_000);
  const engine = await EngineProcess.start(home(), program(`
    await new Promise(resolve => process.stderr.write("fixture diagnostic\\n".repeat(20_000), resolve));
    const bytes = Buffer.from(${JSON.stringify(JSON.stringify(hello) + "\n")});
    const middle = bytes.indexOf(Buffer.from("🧩")) + 1;
    await new Promise(resolve => process.stdout.write(bytes.subarray(0, middle), resolve));
    await new Promise(resolve => process.stdout.write(bytes.subarray(middle), resolve));
    await Bun.stdin.text();
  `), { onProcess });
  expect(engine.hello).toEqual(hello);
  await engine.quit();
  expect(await engine.errors()).toBe(errors);
  expect(await childState(engine.proc.pid)).toBe("ended");
});

it("owns and stops a silent startup when its answer deadline expires", async () => {
  let child: EngineProcess["proc"] | undefined;
  const error = await failed(EngineProcess.start(home(), program("setInterval(() => {}, 1000)"), {
    startupTimeoutMs: 50, onProcess: proc => { onProcess(proc); child = proc; },
  }));
  expect(error.message).toContain("no startup answer within 50ms");
  expect(child).toBeDefined();
  expect(child!.signalCode ?? child!.exitCode).not.toBeNull();
  expect(await childState(child!.pid)).toBe("ended");
});

it("stops a process that publishes malformed startup output while keeping its diagnostics", async () => {
  let child: EngineProcess["proc"] | undefined;
  const error = await failed(EngineProcess.start(home(), program('console.error("invalid fixture handshake"); console.log("not-json"); await Bun.stdin.text();'), {
    onProcess: proc => { onProcess(proc); child = proc; },
  }));
  expect(error.message).toContain("JSON");
  expect(error.message).toContain("invalid fixture handshake");
  expect(child!.signalCode ?? child!.exitCode).not.toBeNull();
  expect(await childState(child!.pid)).toBe("ended");
});

it("records early startup exit code and diagnostics instead of waiting for a reply", async () => {
  const error = await failed(EngineProcess.start(home(), program('console.error("fixture setup is unavailable"); process.exit(7);'), { onProcess }));
  expect(error.message).toContain("exited with code 7 without a startup answer");
  expect(error.message).toContain("fixture setup is unavailable");
});

it("accepts a complete final startup line without a newline", async () => {
  const engine = await EngineProcess.start(home(), program(`process.stdout.write(${JSON.stringify(JSON.stringify(hello))});`), { onProcess });
  expect(engine.hello).toEqual(hello);
  expect(await engine.exited(10_000)).toBe(0);
});

it("stops its owned child when the startup observer throws", async () => {
  let child: EngineProcess["proc"] | undefined;
  const error = await failed(EngineProcess.start(home(), program("await Bun.stdin.text();"), {
    onProcess: proc => { onProcess(proc); child = proc; throw new Error("Observer failed"); },
  }));
  expect(error.message).toContain("Observer failed");
  expect(child!.signalCode ?? child!.exitCode).not.toBeNull();
  expect(await childState(child!.pid)).toBe("ended");
});

it("stops an engine that misses a requested exit deadline, with the existing command cleanup", async () => {
  const engine = await EngineProcess.start(home(), program(`console.log(${JSON.stringify(JSON.stringify(hello))}); await Bun.stdin.text();`), { onProcess });
  const error = await failed(engine.exited(50));
  expect(error.message).toContain("did not stop within 0.05 seconds");
  expect(engine.proc.signalCode ?? engine.proc.exitCode).not.toBeNull();
  expect(await childState(engine.proc.pid)).toBe("ended");
});
