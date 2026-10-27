import { engineCaseFixtures, type EngineCaseOwner } from "../../fixtures/engine-cases.js";
import { extraActors } from "../../extra-fixtures.js";
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as childProcess from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beginAgentStep, type ExtraValidation } from "@petrina/core";
import { Engine, writeFixtureEngineOptions, type EngineOptions } from "../../engine.js";
import { git, makeProduct, waitFor } from "../../fixtures.js";
import { Coordination } from "../../../src/coordination.js";
import { executionFor } from "@petrina/orchestrator";
import { containerCommand, OWNER_LABEL, RUN_LABEL } from "../../../src/extra-container.js";
const cases = engineCaseFixtures();
afterAll(() => cases.close());


const image = process.env.PETRINA_CONTAINER_IMAGE;

async function prepareFixture(owner: EngineCaseOwner, timeoutMs = 20_000) {
  if (!image) throw new Error("Set PETRINA_CONTAINER_IMAGE to a prepared local Linux image with Git and sh (and su for the ownership control).");
  const root = owner.root;
  const actors = await extraActors(owner);
  owner.check();
  const data = join(root, "data");
  const settings: EngineOptions = { agentCommand: () => { throw new Error("Extra-validation controls must not start agents"); }, awakeObserver: () => {}, checkTimeoutMs: timeoutMs, extraCleanupEveryMs: 60_000 };
  const engine = owner.open(data, settings); engine.setPoolPaused(true);
  const product = await makeProduct(root);
  owner.check();
  const productId = await engine.addProduct(product);
  const task = engine.task(engine.addTask({ productId, title: "Tiny local container control", backlog: true }))!;
  task.held = true;
  const work = executionFor(task).work;
  work.worktree = engine.s.products.find(product => product.id === productId)!.path;
  work.savedVersion = { commit: await git(work.worktree!, "rev-parse", "HEAD"), tree: await git(work.worktree!, "rev-parse", "HEAD^{tree}") };
  beginAgentStep(task, "tester", "sol-high", Date.now(), engine.s.roles, undefined, work);
  engine.raise(task, "delivery", "Waiting for required platform validation", false);
  const coordination = new Coordination(engine);
  const trace = (stage: string, current = engine) => console.log("Native extra-validation control: " + JSON.stringify({ stage,
    runs: current.s.extraValidations?.map(run => ({ requestId: run.requestId, state: run.state, result: run.result, cleanup: run.cleanupDetail,
      clientPid: run.clientPid, platform: run.container && `${run.container.os}/${run.container.arch}`, image: run.container?.imageId })),
    places: current.checkQueue.running, waiting: current.checkQueue.waiting, active: current.extraValidations.active }));
  let last = "";
  const unsubscribe = engine.subscribe(() => {
    const state = JSON.stringify(engine.s.extraValidations?.map(run => [run.state, run.result, run.cleanupDetail]));
    if (state !== last) { last = state; trace("ownership changed"); }
  });
  owner.onStop(unsubscribe);
  const container = engine.extraValidations["container"];
  const inspect = container["labelled"].bind(container);
  container["labelled"] = async (record, timeout) => {
    const started = Date.now();
    try { return await inspect(record, timeout); }
    catch (error) {
      console.log("Native extra-validation container inspection failed: " + JSON.stringify({ requestId: record.requestId, ms: Date.now() - started, error: String(error) }));
      throw error;
    }
  };
  const submit = async (requestId: string, argv: string[]) => {
    const reply = await coordination.call("validation.run", { taskId: task.id, requestId, name: "Tiny real container control", reason: "Verify owned workload behavior", image, argv });
    expect(reply.outcome).toBe("pending");
    return reply.validation as ExtraValidation;
  };
  const finished = async (record: ExtraValidation, current = engine) => {
    await waitFor(() => current.extraValidations.get(record.requestId)?.outcome === "completed", "real container cleanup", 30_000);
    return current.extraValidations.get(record.requestId)!.validation as ExtraValidation;
  };
  const labelled = (record: ExtraValidation, current = engine) => {
    const saved = current.extraValidations.get(record.requestId)?.validation as ExtraValidation | undefined;
    const container = saved?.id === record.id ? saved.container : record.container;
    if (!container) throw new Error("The native control has no container service recorded for this exact run.");
    return containerCommand(["docker", "--host", container.endpoint,
      "ps", "--all", "--filter", `label=${OWNER_LABEL}=${record.owner}`, "--filter", `label=${RUN_LABEL}=${record.id}`, "--format", "{{.Names}}"], 4_000);
  };
  const running = (record: ExtraValidation) => waitFor(async () => {
    const entry = engine.s.extraValidations?.find(entry => entry.id === record.id);
    return entry?.container && (await labelled(record)).includes(record.containerName);
  }, "actual owned container", 15_000);
  const stoppedWithoutHold = async (record: ExtraValidation, current = engine) => {
    await waitFor(() => current.s.extraValidations?.some(run => run.id === record.id && run.state === "held")
      || current.extraValidations.get(record.requestId)?.outcome === "completed", "native stop attempt to settle", 30_000);
    expect(current.s.extraValidations?.some(run => run.id === record.id && run.state === "held")).toBe(false);
    expect(current.events.log.collect({}, 0, 100).events.some(event => event.kind === "extra.held")).toBe(false);
  };
  return { root, data, settings, engine, actors, work, task, coordination, submit, finished, labelled, running, trace, stoppedWithoutHold };
}

function fixture<T>(owner: EngineCaseOwner, body: (fixture: Awaited<ReturnType<typeof prepareFixture>>) => Promise<T>, timeoutMs = 20_000): Promise<T> {
  return owner.prepare(async () => { const value = await prepareFixture(owner, timeoutMs); owner.check(); return body(value); });
}

describe.skipIf(!process.env.PETRINA_CONTAINER_CHECK || process.platform === "win32")("opt-in local Linux container controls", () => {
  const execute = childProcess.execFile;
  let restoreCommands = () => {};
  beforeAll(() => {
    const commands = spyOn(childProcess, "execFile");
    restoreCommands = () => commands.mockRestore();
    commands.mockImplementation(((...args: unknown[]) => {
      const argv = args[1];
      const callback = args.at(-1);
      if (Array.isArray(argv) && (argv.includes("stop") || argv.includes("rm")) && typeof callback === "function") {
        const started = Date.now();
        args[args.length - 1] = (...result: unknown[]) => {
          console.log("Native extra-validation removal response: " + JSON.stringify({ operation: argv.includes("stop") ? "stop" : "rm", ms: Date.now() - started, error: result[0] && String(result[0]), stdout: result[1], stderr: result[2] }));
          return callback(...result);
        };
      }
      return Reflect.apply(execute, childProcess, args);
    }) as typeof childProcess.execFile);
  });
  afterAll(() => restoreCommands());

  it("reads the exact standalone Git copy, refuses writes and clones it under a different user", async () => {
    return cases.use("petrina-native-extra-", owner => fixture(owner, async f => {
    try {
      const { commit, tree } = f.work.savedVersion!;
      const script = `test "$(git rev-parse HEAD)" = '${commit}'
test "$(git rev-parse HEAD^{tree})" = '${tree}'
test -z "$(git status --porcelain)"
test "$(git rev-list --count HEAD)" = 1
if touch /petrina/must-not-write 2>/dev/null; then exit 8; fi
git clone --quiet --no-hardlinks /petrina /tmp/writable
test "$(git -C /tmp/writable rev-parse HEAD)" = '${commit}'
test "$(git -C /tmp/writable rev-parse HEAD^{tree})" = '${tree}'
su -s /bin/sh nobody -c 'git -C /petrina rev-parse HEAD && git clone --quiet --no-hardlinks /petrina /tmp/other-user && git -C /tmp/other-user rev-parse HEAD^{tree}'
# OrbStack maps bind-mount ownership to the reader. Its container-local copy has real ownership.
su -s /bin/sh nobody -c 'test "$(id -u)" != "$(stat -c %u /tmp/writable)" && git -c safe.directory=/tmp/writable -C /tmp/writable rev-parse HEAD && git -c safe.directory=/tmp/writable -C /tmp/writable rev-parse HEAD^{tree}'
echo snapshot-control-passed`;
      const record = await f.submit("real-git", ["sh", "-ec", script]);
      f.engine.setPoolPaused(false);
      const result = await f.finished(record);
      expect({ result: result.result, diagnostic: result.run?.output }).toEqual({ result: "passed", diagnostic: expect.stringContaining("snapshot-control-passed") });
      expect(result.run!.output).toContain("snapshot-control-passed");
      expect(result.run!.output).toContain(tree);
      expect(existsSync(record.snapshot)).toBe(false);
      expect(await containerCommand(["docker", "--host", result.container!.endpoint, "ps", "--all", "--filter", `label=${RUN_LABEL}=${record.id}`, "--format", "{{.Names}}"], 4_000)).toBe("");
    } finally { await owner.stop(f.engine); }

  }));
});

  for (const timeout of [false, true]) it(`${timeout ? "a short deadline" : "cancelling"} removes the actual workload before handing off capacity`, async () => {
    return cases.use("petrina-native-extra-", owner => fixture(owner, async f => {
    let releasePlace: (() => void) | undefined;
    try {
      const record = await f.submit(timeout ? "real-timeout" : "real-cancel", ["sh", "-ec", "echo workload-started; exec sleep 300"]);
      f.engine.setPoolPaused(false); await f.running(record);
      f.trace("workload running; waiting for capacity handoff");
      const pending = f.engine.checkQueue.acquire(new AbortController().signal).then(async release => {
        releasePlace = release;
        const copyPresent = existsSync(record.snapshot);
        return { release, copyPresent, containers: await f.labelled(record) };
      });
      void pending.catch(() => {}); // The awaited handoff retains inspection errors.
      expect(f.engine.checkQueue.running).toBe(1); expect(f.engine.checkQueue.waiting).toBe(1);
      if (!timeout) f.engine.cancel(f.task.id);
      await f.stoppedWithoutHold(record);
      const handoff = await pending;
      expect(handoff.copyPresent).toBe(false); expect(handoff.containers).toBe("");
      const result = await f.finished(record);
      expect(result.result).toBe(timeout ? "did not finish" : "stopped");
      expect(existsSync(record.snapshot)).toBe(false);
      expect(await containerCommand(["docker", "--host", result.container!.endpoint, "ps", "--all", "--filter", `label=${RUN_LABEL}=${record.id}`, "--format", "{{.Names}}"], 4_000)).toBe("");
      handoff.release();
    } finally { releasePlace?.(); await owner.stop(f.engine); }

  }, timeout ? 2_000 : 20_000));
});

  it("recovers an actual container after an abrupt engine stop, without forwarding configured proxy credentials", async () => {
    return cases.use("petrina-native-extra-", owner => fixture(owner, async f => {
    let child: ReturnType<typeof f.actors.capture>["process"] | undefined;
    let captured: ReturnType<typeof f.actors.capture> | undefined;
    let replacement: Engine | undefined;
    let releasePlace: (() => void) | undefined;
    try {
      const record = await f.submit("real-crash", ["sh", "-ec", "test -z \"${HTTP_PROXY:-}${http_proxy:-}${HTTPS_PROXY:-}${https_proxy:-}\"; echo workload-started; exec sleep 300"]);
      await owner.stop(f.engine);
      const settings = join(f.root, "settings.json"); writeFixtureEngineOptions(settings, f.settings);
      const config = join(f.root, "client-config"); mkdirSync(config);
      writeFileSync(join(config, "config.json"), JSON.stringify({ proxies: { default: { httpProxy: "http://fake-user:fixture-only@invalid.example:9", httpsProxy: "http://fake-user:fixture-only@invalid.example:9" } } }));
      const contexts = JSON.parse(await containerCommand(["docker", "context", "inspect"], 4_000, true));
      const endpoint = contexts[0].Endpoints.docker.Host;
      captured = f.actors.capture(() => Bun.spawn([process.execPath, f.actors.actor("extra-crash-engine.ts"), f.data, settings],
        { env: { ...process.env, DOCKER_CONFIG: config, DOCKER_HOST: endpoint, DOCKER_CONTEXT: "" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
      child = captured.process;
      await waitFor(async () => (await containerCommand(["docker", "--host", endpoint, "ps", "--filter", `label=${RUN_LABEL}=${record.id}`, "--format", "{{.Names}}"], 4_000)).includes(record.containerName), "real workload after private proxy control", 15_000, { during: captured.drained });
      child.kill("SIGKILL"); await child.exited; await captured!.drained;
      f.trace("crashed engine ended; starting recovery");
      replacement = owner.open(f.data, f.settings);
      const current = replacement;
      const pending = current.checkQueue.acquire(new AbortController().signal, true).then(async release => {
        releasePlace = release;
        const copyPresent = existsSync(record.snapshot);
        return { release, copyPresent, containers: await f.labelled(record, current) };
      });
      void pending.catch(() => {}); // The awaited handoff retains inspection errors.
      expect(current.checkQueue.running).toBe(1); expect(current.checkQueue.waiting).toBe(1);
      await replacement.extraValidations.ready;
      f.trace("startup recovery settled; waiting for capacity handoff", replacement);
      await f.stoppedWithoutHold(record, replacement);
      const handoff = await pending;
      expect(handoff.copyPresent).toBe(false); expect(handoff.containers).toBe("");
      const result = await f.finished(record, replacement);
      expect(result.result).toBe("stopped");
      expect(existsSync(record.snapshot)).toBe(false);
      expect(await containerCommand(["docker", "--host", endpoint, "ps", "--all", "--filter", `label=${RUN_LABEL}=${record.id}`, "--format", "{{.Names}}"], 4_000)).toBe("");
      const log = await new Coordination(replacement).call("validation.log", { requestId: record.requestId });
      expect(log.text).toContain("workload-started"); expect(log.text).not.toContain("fixture-only");
      handoff.release();
    } finally {
      releasePlace?.();
      child?.kill("SIGKILL"); if (child) { await child.exited; await captured!.drained; }
      await (replacement ? owner.stop(replacement) : undefined); await owner.stop(f.engine);
    }

  }));
});
});
