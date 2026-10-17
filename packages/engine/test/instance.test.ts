import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { answers, connectionPath, FolderLock, readConnection, writeConnection } from "../src/instance.js";
import { CLI, EngineProcess, engineEnv, firstLine, removeDir, spawnEngine, tempDir, waitFor } from "./support.js";

const root = tempDir("petrina-instance-");
let count = 0;
const newHome = () => {
  const home = join(root, `home-${(count += 1)}`);
  mkdirSync(home, { recursive: true });
  return home;
};
const app = (home: string) => EngineProcess.start(home, [CLI, "app"]);

afterAll(() => removeDir(root));

describe("one engine per Petrina folder", () => {
  it("is ready on a free port, tells only the shell its key, and writes the connection file for scripts", async () => {
    const home = newHome();
    const engine = await app(home);
    expect(engine.hello).toMatchObject({ type: "ready", owned: true });
    const connection = readConnection(home)!;
    if (engine.hello.type !== "ready") throw new Error("not ready");
    expect(connection.url).toBe(engine.hello.url);
    expect(connection.token).toBe(engine.hello.token);
    expect(connection.api).not.toContain(":4317");
    // Scripts reach it as before.
    const state = await fetch(`${connection.api}/api/state`, { headers: { authorization: `Bearer ${connection.token}` } });
    expect(state.ok).toBe(true);

    const took = await engine.quit();
    expect(took).toBeLessThan(10_000);
    expect(existsSync(connectionPath(home))).toBe(false);
    const log = readFileSync(join(home, "engine.log"), "utf8");
    expect(log).toContain("Petrina engine starting");
    expect(log).toContain("Petrina engine stopped");
    // The key is in no log and no other output.
    expect(log).not.toContain(connection.token);
    expect(await new Response(engine.proc.stderr).text()).not.toContain(connection.token);
  });

  it("steps aside for the engine that holds the folder, leaving its connection file and log alone", async () => {
    const home = newHome();
    const first = await app(home);
    const connectionBefore = readFileSync(connectionPath(home), "utf8");
    const logPath = join(home, "engine.log");
    const logBefore = { text: readFileSync(logPath, "utf8"), changed: statSync(logPath).mtimeMs };

    const second = await app(home);
    if (first.hello.type !== "ready") throw new Error("not ready");
    expect(second.hello).toEqual({ type: "running", owned: false, url: first.hello.url, token: first.hello.token });
    expect(await second.exited(10_000)).toBe(0);
    expect(readFileSync(connectionPath(home), "utf8")).toBe(connectionBefore);
    expect(readFileSync(logPath, "utf8")).toBe(logBefore.text);
    expect(statSync(logPath).mtimeMs).toBe(logBefore.changed);

    // Started by hand while it runs: a plain refusal.
    const byHand = spawnEngine([CLI, "serve"], home);
    const boardBefore = await first.state();
    expect(await byHand.exited).toBe(1);
    expect(await new Response(byHand.stderr).text()).toBe("Petrina's engine is already running. Open it with bun run open.\n");
    expect(await new Response(byHand.stdout).text()).toBe("");
    expect((await first.state()).tasks).toEqual(boardBefore.tasks);
    expect(readFileSync(logPath, "utf8")).toBe(logBefore.text);
    await first.quit();
  });

  it("finds an engine from before the lock through the connection file, and uses it", async () => {
    const home = newHome();
    const token = "an-old-engine-key-0123456789";
    // An engine started before this change: it answers with its key, has no health check, holds no lock.
    const old = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => (request.headers.get("authorization") !== `Bearer ${token}` ? new Response("Unauthorized", { status: 401 }) : new URL(request.url).pathname === "/api/state" ? Response.json({}) : new Response("Not found", { status: 404 })),
    });
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

  it("calls the folder busy when the engine holding it does not answer", async () => {
    const home = newHome();
    const stuck = FolderLock.take(home)!;
    const engine = await app(home);
    expect(engine.hello.type).toBe("error");
    expect(engine.hello.type === "error" && engine.hello.message).toContain("does not answer");
    expect(await engine.exited(10_000)).toBe(1);
    expect(existsSync(join(home, "engine.log"))).toBe(false);
    stuck.release();
  });

  it("lets only one of two engines started together take the folder", async () => {
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

  it("clears the lock by itself when an engine is killed outright", async () => {
    const home = newHome();
    const first = await app(home);
    await first.kill();
    const next = await app(home);
    expect(next.hello).toMatchObject({ type: "ready", owned: true });
    await next.quit();
  });

  it("keeps its key across restarts when started by hand, unless asked for a new one", async () => {
    const home = newHome();
    const serve = async (...flags: string[]) => {
      const proc = Bun.spawn([process.execPath, CLI, "serve", ...flags], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { ...engineEnv(home), PETRINA_PORT: "0" } });
      const connection = await waitFor(async () => {
        const found = readConnection(home);
        return found?.pid === proc.pid && (await answers(found)) ? found : undefined;
      }, "the engine to start");
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

  it("stops by itself within 10 seconds when the app crashes or is force-quit", async () => {
    const home = newHome();
    const shell = Bun.spawn([process.execPath, join(import.meta.dir, "shell-standin.ts"), CLI], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: engineEnv(home) });
    expect(JSON.parse(await firstLine(shell.stdout))).toMatchObject({ type: "ready" });
    const connection = readConnection(home)!;
    expect(await answers(connection)).toBe(true);

    const killedAt = Date.now();
    shell.kill("SIGKILL");
    await waitFor(() => !existsSync(connectionPath(home)), "the engine to stop", 10_000);
    expect(await answers(connection, 500)).toBe(false);
    expect(Date.now() - killedAt).toBeLessThan(10_000);
  });
});
