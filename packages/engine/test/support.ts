// Shared by the tests that run engines as separate processes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { State, Task } from "@petrina/core";
import { readConnection } from "../src/instance.js";
import type { ShellMessage } from "../src/launch.js";
import type { Scenario } from "./fake-agent.js";
import type { FakeGitHub } from "./fake-gh.js";

export const CLI = join(import.meta.dir, "../src/cli.ts");
export const HARNESS = join(import.meta.dir, "harness.ts");

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Windows keeps files open a moment after a process ends: cleaning up is best effort. */
export function removeDir(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Left for the system's temp cleanup.
  }
}

export const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

/** A product with a GitHub-like origin: a bare repository and a clone of it, on main. */
export function makeProduct(root: string): string {
  const origin = join(root, "origin.git");
  const seed = join(root, "seed");
  const clone = join(root, "clone");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "config", "user.name", "Test");
  writeFileSync(join(seed, "README.md"), "# Demo\n");
  writeFileSync(join(seed, "VERSION"), "1.0.0\n");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "init");
  git(root, "clone", "-q", "--bare", seed, origin);
  git(root, "clone", "-q", origin, clone);
  git(clone, "config", "user.email", "test@example.com");
  git(clone, "config", "user.name", "Test");
  return clone;
}

export async function waitFor<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 30_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > ms) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** The first line a process writes to stdout. */
export async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text.split("\n")[0]!;
}

type Spawned = ReturnType<typeof spawnEngine>;

/**
 * The environment test engines run in. Git settings passed down through the environment are
 * dropped (inside a Petrina agent they switch pushing off), so the fake shipper can push to the
 * test's own bare repository wherever the tests run.
 */
export function engineEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, PETRINA_HOME: home };
  for (const name of Object.keys(env)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(name) || name === "GIT_SSH_COMMAND") delete env[name];
  return env;
}

export function spawnEngine(args: readonly string[], home: string) {
  return Bun.spawn([process.execPath, ...args], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: engineEnv(home) });
}

/** An app-mode engine process, and what it told its "shell". */
export class EngineProcess {
  private constructor(
    readonly proc: Spawned,
    readonly hello: ShellMessage,
    readonly home: string,
  ) {}

  static async start(home: string, args: readonly string[]): Promise<EngineProcess> {
    const proc = spawnEngine(args, home);
    const line = await firstLine(proc.stdout);
    if (!line) throw new Error(`The engine said nothing: ${await new Response(proc.stderr).text()}`);
    return new EngineProcess(proc, JSON.parse(line) as ShellMessage, home);
  }

  /** The engine on fake agents, with its fake dir. */
  static harness(home: string, dir: string): Promise<EngineProcess> {
    return EngineProcess.start(home, [HARNESS, home, dir]);
  }

  async act(name: string, ...args: unknown[]): Promise<unknown> {
    const { api, token } = readConnection(this.home)!;
    const response = await fetch(`${api}/api/action`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ name, args }) });
    const body = (await response.json()) as { ok: boolean; result?: unknown; error?: string };
    if (!body.ok) throw new Error(`${name} failed: ${body.error}`);
    return body.result;
  }

  /** A WebSocket the way the desktop window opens one: Petrina's own page, the key as a subprotocol. */
  socket(): Promise<WebSocket> {
    const { url, token } = readConnection(this.home)!;
    const socket = new WebSocket(url, { protocols: ["petrina.v1", `petrina.token.${token}`], headers: { origin: "tauri://localhost" } } as unknown as string[]);
    return new Promise((resolve, reject) => {
      socket.onopen = () => resolve(socket);
      socket.onerror = () => reject(new Error("The engine refused the connection"));
    });
  }

  async state(): Promise<State> {
    const { api, token } = readConnection(this.home)!;
    return (await (await fetch(`${api}/api/state`, { headers: { authorization: `Bearer ${token}` } })).json()) as State;
  }

  async task(id: string): Promise<Task> {
    return (await this.state()).tasks.find((task) => task.id === id)!;
  }

  until(check: (state: State) => boolean, what: string, ms = 30_000): Promise<State> {
    return waitFor(async () => {
      const state = await this.state();
      return check(state) ? state : undefined;
    }, what, ms);
  }

  /** The app quits: the line closes, and the engine stops by itself. Returns how long it took. */
  async quit(): Promise<number> {
    const started = Date.now();
    void this.proc.stdin.end();
    await this.exited(10_000);
    return Date.now() - started;
  }

  /** A forced kill: nothing gets saved on the way out. */
  async kill(): Promise<void> {
    this.proc.kill("SIGKILL");
    await this.exited(10_000);
  }

  async exited(ms: number): Promise<number> {
    return Promise.race([this.proc.exited, Bun.sleep(ms).then(() => Promise.reject(new Error(`The engine did not stop within ${ms / 1000} seconds`)))]);
  }
}

/** A fake dir for one test: scenario, prompts, markers and the fake GitHub. */
export class Fakes {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  scenario(value: Scenario): void {
    writeFileSync(join(this.dir, "scenario.json"), JSON.stringify(value));
  }

  github(change: (state: FakeGitHub) => void): void {
    const path = join(this.dir, "github.json");
    const state = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { prs: [], releases: [] };
    change(state);
    writeFileSync(path, JSON.stringify(state));
  }

  marked(name: string): boolean {
    return existsSync(join(this.dir, name));
  }

  /** Every prompt the fake agents received, in order. */
  prompts(role?: string): string[] {
    const path = join(this.dir, "prompts.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { role: string; text: string })
      .filter((entry) => !role || entry.role === role)
      .map((entry) => entry.text);
  }

  /** The opening prompt of each agent of a role (the ones that say who they are). */
  openings(role: string): string[] {
    return this.prompts(role).filter((text) => /You are the [A-Za-z ]+ in Petrina/.test(text));
  }
}
