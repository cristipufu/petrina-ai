#!/usr/bin/env bun
// petrina serve [--new-key] [--debug-sql] — start the engine and its local API by hand (keeps its key across restarts).
// petrina app     — the engine the desktop app starts (see launch.ts). Not for terminals.
// petrina state   — print the engine's state (for scripts).
// petrina do <action-json> — run one action, e.g. '{"name":"addTask","args":[{...}]}'.
// petrina open [--dev] — open the UI in the browser, connected to the running engine.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readConnection } from "./instance.js";
import { launch } from "./launch.js";
import { browserCommand } from "./setup.js";
import { coordinationCli } from "./coordination-cli.js";
import { updateStandaloneCli } from "./cli-update.js";
import { runMcp } from "./mcp.js";
import { runEmbeddedAcpSubcommand } from "@petrina/agent-runtime";
import { runBrowserServer } from "@petrina/agent-runtime/browser-server";
import { runCodexBackground } from "@petrina/agent-runtime/codex-background";
import { compiledExecutableDir, isCompiledBinary } from "@petrina/platform/compiled-runtime";
import pkg from "../package.json" with { type: "json" };
import type { EngineClient } from "./engine-client.js";

export const PETRINA_CLI_VERSION: string = pkg.version;

export function resolveDefaultUiDir(execPath: string = process.execPath, metaDir: string = import.meta.dir): string {
  if (isCompiledBinary(metaDir)) {
    const dir = compiledExecutableDir(execPath);
    const adjacent = join(dir, "ui");
    if (existsSync(adjacent)) return adjacent;
    const sibling = resolve(dir, "../ui");
    if (existsSync(sibling)) return sibling;
    return adjacent;
  }
  return resolve(metaDir, "../../../apps/desktop/dist");
}

const home = process.env.PETRINA_HOME || join(homedir(), ".petrina");
const ui = resolveDefaultUiDir();
const DEV_UI = "http://localhost:1430/";

function connection() {
  const found = readConnection(home);
  if (!found) {
    console.error("The engine is not running. Open the Petrina app, or start it with: bun run engine");
    process.exit(1);
  }
  return found;
}

async function call(path: string, init?: RequestInit): Promise<unknown> {
  const { api, token } = connection();
  const response = await fetch(
    `${api}${path}`,
    {
    ...init,
    headers: {
    ...(init?.headers ?? {}),
    authorization: `Bearer ${token}`,
    "content-type": "application/json"
  }
  }
  );
  return response.json();
}

/** Hand the engine's address to the page in the URL fragment: browsers never send it anywhere. */
async function open(dev: boolean): Promise<void> {
  // Agents work in the background and never open windows on the coordinator's screen.
  if (process.env.PETRINA_AGENT) {
    console.error("petrina open is for the coordinator. Agents work in the background: use a headless browser on a free port.");
    process.exit(1);
  }
  const { api, token, url } = connection();
  const fragment = Buffer.from(JSON.stringify({ url, token })).toString("base64url");
  // The developer UI when it runs, otherwise the one the engine serves.
  const useDev = dev && (await fetch(DEV_UI, { signal: AbortSignal.timeout(1000) }).then((response) => response.ok).catch(() => false));
  if (!useDev && !(await fetch(`${api}/`).then((response) => response.headers.get("content-type")?.includes("html") ?? false).catch(() => false))) {
    console.error("There is no page to open yet: start the developer UI with bun run dev, or build it with bun run build.");
    process.exit(1);
  }
  const page = `${useDev ? DEV_UI : `${api}/`}#engine=${fragment}`;
  Bun.spawn(browserCommand(page), { stdout: "ignore", stderr: "ignore", windowsHide: true });
  console.log(`Opened Petrina${useDev ? " (dev UI)" : ""}.`);
}

/** The production parser with a launch boundary that lifecycle tests can supply without native accounts. */
export async function runCli(args: readonly string[] = process.argv.slice(2), startEngine: typeof launch = launch, client?: EngineClient): Promise<void> {
  const [command, ...rest] = args;
  if (command === "__internal-browser-server") {
    runBrowserServer(rest);
    return;
  }
  if (command === "__internal-codex-background") {
    await runCodexBackground(rest);
    return;
  }
  if (await runEmbeddedAcpSubcommand(command, rest)) {
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(`petrina ${PETRINA_CLI_VERSION}`);
    return;
  }
  if (command === "update") {
    try {
      await updateStandaloneCli();
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  const newKey = rest.includes("--new-key");
  const debugSql = rest.includes("--debug-sql") || process.env.PETRINA_DEBUG_SQL === "1";
  if (command === "serve") await startEngine({
    home,
    mode: "serve",
    engine: { debugSql },
    port: Number(process.env.PETRINA_PORT || 4317),
    newKey,
    ...(existsSync(ui) ? { ui } : {})
  });
  else if (command === "app") await startEngine({ home, mode: "app", engine: { debugSql }, ...(existsSync(ui) ? { ui } : {}) });
  else if (command === "open") await open(rest.includes("--dev"));
  else if (command === "state") console.log(JSON.stringify(await call("/api/state"), null, 2));
  else if (command === "do") console.log(JSON.stringify(await call("/api/action", { method: "POST", body: rest.join(" ") }), null, 2));
  else if (command === "mcp") {
    if (rest.includes("--help")) console.log("petrina mcp — connect a coding agent over MCP stdio. Discover named tools with tools/list. Uses the existing local connection; connecting never starts an engine. See docs/coordination.md for client configuration and docs/coordinator.md for project coordination.");
    else await runMcp(client);
  }
  else process.exitCode = await coordinationCli([...args], client);
}

if (import.meta.main) await runCli();
