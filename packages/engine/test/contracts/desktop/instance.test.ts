import { setupWithCleanup } from "@petrina/test-support/setup-with-cleanup";
import { rejectionOf } from "@petrina/test-support/rejections";
import { createProcessLease } from "@petrina/test-support/process-lease";
import { childState } from "@petrina/platform/process-tree";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answers, connectionPath, FolderLock, readConnection, writeConnection } from "../../../src/instance.js";
import { CLI, engineEnv, engineProcessCases, tempDir, waitFor, type EngineProcesses } from "../../support.js";

const cases = engineProcessCases();
afterEach(() => cases.close());

function instanceFixture(root: string, owners: EngineProcesses, cleanups: (() => void | Promise<void>)[]) {
  let count = 0;
  const newHome = () => {
    const home = join(root, `home-${++count}`);
    mkdirSync(home, { recursive: true });
    return home;
  };
  const startProcess = (home: string, args: readonly string[], options?: Parameters<EngineProcesses["app"]>[2]) => owners.app(home, args, options);
  const app = (home: string) => startProcess(home, [CLI, "app"]);
  const leasedStandin = async (home: string) => {
    const lease = await createProcessLease();
    let stopRequested = false;
    const requestStop = () => { const stopping = lease.close(); stopRequested = true; return stopping; };
    const identity = join(home, "leased-cli.pid");
    cleanups.push(async () => {
      await requestStop();
      if (existsSync(identity)) {
        const pid = Number(readFileSync(identity, "utf8"));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("The private CLI wrapper did not record a native process identity");
        await waitFor(async () => await childState(pid) === "ended", "the independently leased CLI to report native ended state", 5_000);
      }
    });
    if (owners.signal.aborted) { await requestStop(); throw new Error("Desktop fixture preparation was stopped"); }
    const cli = join(home, "leased-cli.ts");
    // Record the actual wrapper before its async lease handshake. PID is observation only.
    const record = `const { writeFixtureJson } = await import(${JSON.stringify(import.meta.resolve("@petrina/test-support/fixture-json"))}); writeFixtureJson(${JSON.stringify(identity)}, process.pid);\n`;
    writeFileSync(cli, record + lease.program(`process.argv[1] = ${JSON.stringify(CLI)}; await import(${JSON.stringify(pathToFileURL(CLI).href)}); await new Promise(() => {});`));
    // Preserve the native Windows launcher outside Bun's job, and the actual CLI parser argv.
    const standin = process.platform === "win32" ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dir, "../..", "shell-standin.ps1"), process.execPath, cli] : [process.execPath, join(import.meta.dir, "../..", "shell-standin.ts"), cli];
    return { lease: { program: (body: string) => lease.program(body), close: () => requestStop() }, standin, cli, identity, afterExternalStop: () => stopRequested };
  };
  return { newHome, startProcess, app, leasedStandin, cleanups,
    command: (home: string, args: readonly string[]) => owners.command(home, args),
    nativeCommand: (home: string, argv: readonly string[], env: NodeJS.ProcessEnv, options: Parameters<EngineProcesses["nativeCommand"]>[3]) => owners.nativeCommand(home, argv, env, options),
  };
}

async function instanceCase(body: (fixture: ReturnType<typeof instanceFixture>) => Promise<void>): Promise<void> {
  const root = tempDir("petrina-instance-"), cleanups: (() => void | Promise<void>)[] = [];
  return cases.use(root, async owners => body(instanceFixture(root, owners, cleanups)), { async stopPeers() {
    const pending: Promise<void>[] = [];
    for (const stop of cleanups) {
      try { pending.push(Promise.resolve(stop())); } catch (error) { pending.push(Promise.reject(error)); }
    }
    const settled = await Promise.allSettled(pending);
    const errors = settled.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Desktop fixture peers did not all stop");
  } });
}

describe("one engine per Petrina folder", () => {
  it("is ready on a free port, tells only the shell its key, and writes the connection file for scripts", async () => {
    return instanceCase(async ({ newHome, startProcess }) => {
    const home = newHome();
    const engine = await startProcess(home, [CLI, "app", "--debug-sql"]);
    expect(engine.hello).toMatchObject({ type: "ready", owned: true });
    const connection = readConnection(home)!;
    if (engine.hello.type !== "ready") throw new Error("not ready");
    expect(connection.url).toBe(engine.hello.url);
    expect(connection.token).toBe(engine.hello.token);
    expect(connection.api).not.toContain(":4317");
    // Scripts reach it as before.
    const state = await fetch(`${connection.api}/api/state`, { headers: { authorization: `Bearer ${connection.token}` } });
    expect(state.ok).toBe(true);
    // The parser and app lifecycle are real; no account reader or installed coding tool belongs to this fixture.
    expect((await engine.windowState()).tools.every(tool => tool.status === "not-installed")).toBe(true);

    const took = await engine.quit();
    expect(took).toBeLessThan(10_000);
    expect(existsSync(connectionPath(home))).toBe(false);
    const log = readFileSync(join(home, "engine.log"), "utf8");
    expect(log).toContain("Petrina engine starting");
    expect(log).toContain("Petrina engine stopped");
    // The key is in no log and no other output.
    expect(log).not.toContain(connection.token);
    expect(await engine.errors()).not.toContain(connection.token);
    const sql = readFileSync(join(home, "sql-executions.jsonl"), "utf8");
    expect(sql).toContain('"sql":"');
    expect(sql).not.toContain(connection.token);
    expect(sql.trim().split("\n").every(line => {
      const row = JSON.parse(line);
      return typeof row.sql === "string" && typeof row.ms === "number" && new Date(row.at).toISOString() === row.at;
    })).toBe(true);

    });
  });

  it("steps aside for the engine that holds the folder, leaving its connection file and log alone", async () => {
    return instanceCase(async ({ newHome, startProcess, app, leasedStandin, nativeCommand }) => {
    const home = newHome();
    const first = await app(home);
    const connectionBefore = readFileSync(connectionPath(home), "utf8");
    const logPath = join(home, "engine.log");
    const logBefore = { text: readFileSync(logPath, "utf8"), changed: statSync(logPath).mtimeMs };

    const second = await startProcess(home, [CLI, "app", "--debug-sql"]);
    if (first.hello.type !== "ready") throw new Error("not ready");
    expect(second.hello).toEqual({ type: "running", owned: false, url: first.hello.url, token: first.hello.token });
    expect(await second.exited(10_000)).toBe(0);
    expect(readFileSync(connectionPath(home), "utf8")).toBe(connectionBefore);
    expect(readFileSync(logPath, "utf8")).toBe(logBefore.text);
    expect(statSync(logPath).mtimeMs).toBe(logBefore.changed);
    expect(existsSync(join(home, "sql-executions.jsonl"))).toBe(false);

    // Started by hand while it runs: a plain refusal.
    const { cli, afterExternalStop } = await leasedStandin(home);
    const byHand = nativeCommand(home, [process.execPath, cli, "serve"], engineEnv(home), { input: "pipe", output: "pipe", errors: "pipe", afterExternalStop });
    const boardBefore = await first.state();
    expect(await byHand.exited).toBe(1);
    expect(await byHand.stderr).toBe("Petrina's engine is already running. Open it with bun run open.\n");
    expect(await byHand.stdout).toBe("");
    expect((await first.state()).tasks).toEqual(boardBefore.tasks);
    expect(readFileSync(logPath, "utf8")).toBe(logBefore.text);
    const progress: Promise<unknown>[] = [];
    await setupWithCleanup(async () => {
      // The second launcher has ended, but its logical API still addresses the live first Engine.
      const initialPaused = (await first.state()).pool.paused, targetPaused = !initialPaused;
      expect(initialPaused).not.toBe(targetPaused);
      let readExisting = false;
      const changed = second.until(state => { readExisting = true; return state.pool.paused === targetPaused; }, "the already running engine to observe a real state change");
      progress.push(changed); void changed.catch(() => undefined);
      await waitFor(() => readExisting, "the secondary handle to observe its still-false predicate", undefined, { during: changed });
      await first.act("setPoolPaused", targetPaused);
      expect((await changed).pool.paused).toBe(targetPaused);
      let readOwned = false;
      const unfinished = first.until(() => { readOwned = true; return false; }, "unfinished progress on the owned app");
      progress.push(unfinished); void unfinished.catch(() => undefined);
      await waitFor(() => readOwned, "the owned handle to observe unfinished progress before stopping", undefined, { during: unfinished });
      await first.quit();
      expect(await rejectionOf(unfinished)).toBeInstanceOf(Error);
    }, async () => {
      try { if (first.proc.exitCode === null) await first.quit(); }
      finally { await Promise.allSettled(progress); }
    });

    });
  });

  it("finds an engine from before the lock through the connection file, and uses it", async () => {
    return instanceCase(async ({ newHome, app, cleanups }) => {
    const home = newHome();
    const token = "an-old-engine-key-0123456789";
    // An engine started before this change: it answers with its key, has no health check, holds no lock.
    const old = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => (request.headers.get("authorization") !== `Bearer ${token}` ? new Response("Unauthorized", { status: 401 }) : new URL(request.url).pathname === "/api/state" ? Response.json({}) : new Response("Not found", { status: 404 })),
    });
    cleanups.push(() => old.stop(true));
    writeConnection(home, { url: `ws://127.0.0.1:${old.port}/ws`, api: `http://127.0.0.1:${old.port}`, token, pid: 1 });
    const before = readFileSync(connectionPath(home), "utf8");

    const engine = await app(home);
    expect(engine.hello).toEqual({ type: "running", owned: false, url: `ws://127.0.0.1:${old.port}/ws`, token });
    expect(await engine.exited(10_000)).toBe(0);
    expect(readFileSync(connectionPath(home), "utf8")).toBe(before);
    expect(existsSync(join(home, "engine.log"))).toBe(false);
    // It never kept the folder.
    const lock = FolderLock.take(home);
    expect(lock).toBeDefined();
    lock?.release();
    old.stop(true);

    });
  });

  it("calls the folder busy when the engine holding it does not answer", async () => {
    return instanceCase(async ({ newHome, app, cleanups }) => {
    const home = newHome();
    const stuck = FolderLock.take(home)!; cleanups.push(() => stuck.release());
    const engine = await app(home);
    expect(engine.hello.type).toBe("error");
    expect(engine.hello.type === "error" && engine.hello.message).toContain("does not answer");
    expect(await engine.exited(10_000)).toBe(1);
    expect(existsSync(join(home, "engine.log"))).toBe(false);
    stuck.release();

    });
  });

  it("lets only one of two engines started together take the folder", async () => {
    return instanceCase(async ({ newHome, app }) => {
    const home = newHome();
    const both = await Promise.all([app(home), app(home)]);
    const owner = both.find((engine) => engine.hello.type === "ready")!;
    const other = both.find((engine) => engine !== owner)!;
    expect(owner).toBeDefined();
    if (owner.hello.type !== "ready") throw new Error("not ready");
    expect(other.hello).toEqual({ type: "running", owned: false, url: owner.hello.url, token: owner.hello.token });
    await other.exited(10_000);
    await owner.quit();

    });
  });

  it("clears the lock by itself when an engine is killed outright", async () => {
    return instanceCase(async ({ newHome, app }) => {
    const home = newHome();
    const first = await app(home);
    await first.kill();
    const next = await app(home);
    expect(next.hello).toMatchObject({ type: "ready", owned: true });
    await next.quit();

    });
  });

  it("keeps its key across restarts when started by hand, unless asked for a new one", async () => {
    return instanceCase(async ({ newHome, leasedStandin, nativeCommand }) => {
    const home = newHome();
    const { cli, afterExternalStop } = await leasedStandin(home);
    const serve = async (...flags: string[]) => {
      const proc = nativeCommand(home, [process.execPath, cli, "serve", ...flags], { ...engineEnv(home), PETRINA_PORT: "0" }, { input: "ignore", output: "ignore", errors: "ignore", afterExternalStop });
      const connection = await waitFor(async () => {
        const found = readConnection(home);
        return found?.pid === proc.pid && (await answers(found)) ? found : undefined;
      }, "the engine to start", undefined, { during: proc.completion });
      return { proc, connection };
    };
    const stop = async (engine: { proc: { kill(): void; exited: Promise<number> } }) => {
      engine.proc.kill();
      await engine.proc.exited;
    };
    const first = await serve();
    await stop(first);
    const second = await serve();
    // Windows has no owner-only file mode to trust, so there it always makes a new key.
    if (process.platform !== "win32") expect(second.connection.token).toBe(first.connection.token);
    await stop(second);
    const third = await serve("--new-key");
    expect(third.connection.token).not.toBe(first.connection.token);
    await stop(third);

    });
  });

  it("stops by itself within 10 seconds when the app crashes or is force-quit", async () => {
    return instanceCase(async ({ newHome, leasedStandin, nativeCommand }) => {
    const home = newHome();
    const { standin, identity } = await leasedStandin(home);
    const shell = nativeCommand(home, standin, engineEnv(home), { input: "ignore", output: "pipe", errors: "ignore" });
    const hello = await shell.line();
    expect(JSON.parse(hello)).toMatchObject({ type: "ready" });
    const connection = readConnection(home)!;
    expect(Number.isSafeInteger(connection.pid)).toBe(true); expect(connection.pid).toBeGreaterThan(0);
    expect(Number(readFileSync(identity, "utf8"))).toBe(connection.pid);
    expect(await answers(connection)).toBe(true);

    const killedAt = Date.now();
    shell.kill("SIGKILL");
    await waitFor(async () => !existsSync(connectionPath(home)) && await childState(connection.pid) === "ended", "the engine to stop", 10_000);
    expect(await answers(connection, 500)).toBe(false);
    expect(Date.now() - killedAt).toBeLessThan(10_000);
    await shell.settle();
    const completed = await shell.completion;
    expect(completed.stdout).toBe(hello + "\n");
    expect(await childState(shell.pid)).toBe("ended");

    });
  });
  it("independently cleans its engine while the native desktop parent remains alive", async () => {
    return instanceCase(async ({ newHome, leasedStandin, nativeCommand }) => {
    const home = newHome();
    const { lease, standin, identity } = await leasedStandin(home);
    const shell = nativeCommand(home, standin, engineEnv(home), { input: "ignore", output: "pipe", errors: "ignore" });
    const hello = await shell.line();
    expect(JSON.parse(hello)).toMatchObject({ type: "ready" });
    const connection = readConnection(home)!;
    expect(Number.isSafeInteger(connection.pid)).toBe(true); expect(connection.pid).toBeGreaterThan(0);
    expect(Number(readFileSync(identity, "utf8"))).toBe(connection.pid);
    expect(await answers(connection)).toBe(true);
    expect(shell.exitCode).toBeNull();
    await lease.close();
    await waitFor(async () => !await answers(connection, 500) && await childState(connection.pid) === "ended", "the leased engine to end independently", 10_000);
    expect(await answers(connection, 500)).toBe(false);
    expect(shell.exitCode).toBeNull();
    // Its independent Engine stop was the subject. Only now stop the deliberately live parent,
    // observing its original command/output completion before generic case teardown can abort it.
    shell.kill("SIGKILL");
    await shell.settle();
    const completed = await shell.completion;
    expect(completed.stdout).toBe(hello + "\n");
    expect(await childState(shell.pid)).toBe("ended");

    });
  });

});
