import { afterEach } from "bun:test";
import { engineProcessCases } from "../../support.js";
import { expect, it } from "bun:test";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { childState } from "@petrina/platform/process-tree";
import { type EngineProcess, HARNESS, tempDir } from "../../support.js";
import { rejectionOf } from "@petrina/test-support/rejections";

const cases = engineProcessCases();
afterEach(() => cases.close());

const onProcess = (child: EngineProcess["proc"]) => { void child.exited.catch(() => undefined); };
const hello = { type: "ready", owned: true, url: "http://localhost/🧩-café", token: "fixture-only" } as const;
const program = (text: string) => ["-e", text];

async function failed(promise: Promise<unknown>): Promise<Error> {
  const error = await rejectionOf(promise);
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

it("refuses an unmanaged app-mode harness before opening an Engine or GitHub helper", async () => {
  const root = tempDir("petrina-engine-process-");
  return cases.use(root, async owners => {
    const home = join(root, "home");
    let child: EngineProcess["proc"] | undefined;
    const error = await failed(owners.app(home, [HARNESS, home, root], { onProcess: proc => { onProcess(proc); child = proc; } }));
    expect(error.message).toContain("needs an owned GitHub program");
    expect(existsSync(join(home, "engine.json"))).toBe(false);
    expect(owners.harnessStarts()).toEqual([]);
    expect(child).toBeDefined();
    expect(await childState(child!.pid)).toBe("ended");
  });
});

it("drains a full stderr pipe before startup, decodes split Unicode and retains the exact error output", async () => {
  const root = tempDir("petrina-engine-process-");
  return cases.use(root, async owners => {
  const home = () => join(root, crypto.randomUUID());
  const errors = "fixture diagnostic\n".repeat(20_000);
  const engine = await owners.app(home(), program(`
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
});

it("owns and stops a silent startup when its answer deadline expires", async () => {
  const root = tempDir("petrina-engine-process-");
  return cases.use(root, async owners => {
  const home = () => join(root, crypto.randomUUID());
  let child: EngineProcess["proc"] | undefined;
  const error = await failed(owners.app(home(), program("setInterval(() => {}, 1000)"), {
    startupTimeoutMs: 50, onProcess: proc => { onProcess(proc); child = proc; },
  }));
  expect(error.message).toContain("no startup answer within 50ms");
  expect(child).toBeDefined();
  expect(child!.signalCode ?? child!.exitCode).not.toBeNull();
  expect(await childState(child!.pid)).toBe("ended");

  });
});

it("stops a process that publishes malformed startup output while keeping its diagnostics", async () => {
  const root = tempDir("petrina-engine-process-");
  return cases.use(root, async owners => {
  const home = () => join(root, crypto.randomUUID());
  let child: EngineProcess["proc"] | undefined;
  const error = await failed(owners.app(home(), program('console.error("invalid fixture handshake"); console.log("not-json"); await Bun.stdin.text();'), {
    onProcess: proc => { onProcess(proc); child = proc; },
  }));
  expect(error.message).toContain("JSON");
  expect(error.message).toContain("invalid fixture handshake");
  expect(child!.signalCode ?? child!.exitCode).not.toBeNull();
  expect(await childState(child!.pid)).toBe("ended");

  });
});

it("records early startup exit code and diagnostics instead of waiting for a reply", async () => {
  const root = tempDir("petrina-engine-process-");
  return cases.use(root, async owners => {
  const home = () => join(root, crypto.randomUUID());
  const error = await failed(owners.app(home(), program('console.error("fixture setup is unavailable"); process.exit(7);'), { onProcess }));
  expect(error.message).toContain("exited with code 7 without a startup answer");
  expect(error.message).toContain("fixture setup is unavailable");

  });
});

it("accepts a complete final startup line without a newline", async () => {
  const root = tempDir("petrina-engine-process-");
  return cases.use(root, async owners => {
  const home = () => join(root, crypto.randomUUID());
  const engine = await owners.app(home(), program(`process.stdout.write(${JSON.stringify(JSON.stringify(hello))});`), { onProcess });
  expect(engine.hello).toEqual(hello);
  expect(await engine.exited(10_000)).toBe(0);

  });
});

it("stops its owned child when the startup observer throws", async () => {
  const root = tempDir("petrina-engine-process-");
  return cases.use(root, async owners => {
  const home = () => join(root, crypto.randomUUID());
  let child: EngineProcess["proc"] | undefined;
  const error = await failed(owners.app(home(), program("await Bun.stdin.text();"), {
    onProcess: proc => { onProcess(proc); child = proc; throw new Error("Observer failed"); },
  }));
  expect(error.message).toContain("Observer failed");
  expect(child!.signalCode ?? child!.exitCode).not.toBeNull();
  expect(await childState(child!.pid)).toBe("ended");

  });
});

it("stops an engine that misses a requested exit deadline, with the existing command cleanup", async () => {
  const root = tempDir("petrina-engine-process-");
  return cases.use(root, async owners => {
  const home = () => join(root, crypto.randomUUID());
  const engine = await owners.app(home(), program(`console.log(${JSON.stringify(JSON.stringify(hello))}); await Bun.stdin.text();`), { onProcess });
  const error = await failed(engine.exited(50));
  expect(error.message).toContain("did not stop within 0.05 seconds");
  expect(engine.proc.signalCode ?? engine.proc.exitCode).not.toBeNull();
  expect(await childState(engine.proc.pid)).toBe("ended");

  });
});
