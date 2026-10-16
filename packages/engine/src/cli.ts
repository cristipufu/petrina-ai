#!/usr/bin/env bun
// petrina serve   — start the engine and its local API.
// petrina state   — print the engine's state (for scripts).
// petrina do <action-json> — run one action, e.g. '{"name":"addTask","args":[{...}]}'.

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Engine } from "./engine.js";
import { serve } from "./server.js";

const home = process.env.PETRINA_HOME || join(homedir(), ".petrina");
const connectionFile = join(home, "engine.json");

async function start(): Promise<void> {
  const port = Number(process.env.PETRINA_PORT || 4317);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const token = randomBytes(24).toString("base64url");
  const engine = new Engine(home);
  const ui = resolve(import.meta.dir, "../../../apps/desktop/dist");
  const server = serve(engine, { port, token, ...(existsSync(ui) ? { ui } : {}) });
  await writeFile(connectionFile, JSON.stringify({ url: `ws://127.0.0.1:${port}/ws`, api: `http://127.0.0.1:${port}`, token, pid: process.pid }, null, 2), { mode: 0o600 });
  await chmod(connectionFile, 0o600);
  console.log(`Petrina engine on http://127.0.0.1:${server.port} (data in ${home})`);
  const stop = () => {
    engine.shutdown();
    server.stop(true);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

function connection(): { api: string; token: string } {
  if (!existsSync(connectionFile)) throw new Error("The engine is not running. Start it with: bun run engine");
  return JSON.parse(readFileSync(connectionFile, "utf8")) as { api: string; token: string };
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const { api, token } = connection();
  const response = await fetch(`${api}${path}`, { ...init, headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}`, "content-type": "application/json" } });
  return response.json();
}

const [command, ...rest] = process.argv.slice(2);
if (command === "serve") await start();
else if (command === "state") console.log(JSON.stringify(await call("/api/state"), null, 2));
else if (command === "do") console.log(JSON.stringify(await call("/api/action", { method: "POST", body: rest.join(" ") }), null, 2));
else {
  console.log("Usage: petrina serve | petrina state | petrina do '<action json>'");
  process.exit(command ? 1 : 0);
}
