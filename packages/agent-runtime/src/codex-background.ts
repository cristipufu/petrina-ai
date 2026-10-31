#!/usr/bin/env bun
// Codex's config tables merge with inherited settings. At each thread opening, read
// its effective configuration and switch inherited MCP servers off through Codex's
// own per-server enabled option. No personal settings are written.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { isCompiledBinary } from "@petrina/platform/compiled-runtime";

export const BACKGROUND_FEATURES = ["apps", "plugins", "computer_use", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "in_app_browser"];

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// config/read includes null defaults; thread config overrides are converted to TOML,
// which cannot represent null (Codex otherwise turns it into an empty string).
function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, value]) => value !== null).map(([key, value]) => [
    key,
    withoutNulls(value)
  ]));
  return value;
}

export function backgroundConfig(config: Record<string, unknown>, inherited: Record<string, unknown>, layers: unknown[] = []): Record<string, unknown> {
  const supplied = object(config.mcp_servers);
  const servers = Object.assign({}, ...layers.map((layer) => object(object(object(layer).config).mcp_servers)), object(inherited.mcp_servers));
  const mcp: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) mcp[name] = { ...object(server), enabled: false };
  for (const [name, server] of Object.entries(supplied)) mcp[name] = { ...object(server), enabled: true };
  const controls: Record<string, unknown> = {};
  for (const feature of BACKGROUND_FEATURES) controls[`features.${feature}`] = false;
  return withoutNulls({ ...config, ...controls, mcp_servers: mcp }) as Record<string, unknown>;
}

export async function backgroundCommand(
  executable: string | undefined,
  pathEnv: string | undefined = process.env.PATH,
): Promise<string[]> {
  const candidate = executable ?? Bun.which("codex", { PATH: pathEnv ?? "" }) ?? undefined;
  if (!candidate) {
    throw new Error("Codex is not installed: no `codex` on PATH.");
  }
  const resolvedExec = await realpath(resolve(candidate)).catch(() => resolve(candidate));
  const selfPaths = [
    ...(isCompiledBinary() ? [] : [await realpath(import.meta.path).catch(() => import.meta.path)]),
    ...(process.env.PETRINA_CODEX_WRAPPER
      ? [await realpath(resolve(process.env.PETRINA_CODEX_WRAPPER)).catch(() => resolve(process.env.PETRINA_CODEX_WRAPPER!))]
      : []),
  ];
  if (selfPaths.includes(resolvedExec)) {
    throw new Error(
      "Codex could not start because its launcher points back to itself. Restart Petrina before trying again.",
    );
  }
  return [candidate];
}

export async function runCodexBackground(rawArgs: readonly string[] = process.argv.slice(2)): Promise<void> {
  const command = await backgroundCommand(process.env.PETRINA_CODEX_EXECUTABLE);
  const args = [...rawArgs, ...BACKGROUND_FEATURES.flatMap((feature) => ["-c", `features.${feature}=false`])];
  const child = spawn(command[0]!, [...command.slice(1), ...args], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stderr.pipe(process.stderr);
  const pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  let seq = 0;
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Not a message");
      message = value as Record<string, unknown>;
    } catch {
      // Like Codex's connector, keep reading after diagnostics or incomplete output.
      process.stderr.write(`${line}\n`);
      return;
    }
    const waiting = pending.get(String(message.id));
    if (!waiting) {
      process.stdout.write(`${line}\n`);
      return;
    }
    pending.delete(String(message.id));
    if (message.error) waiting.reject(new Error("Codex could not read its inherited browser connections."));
    else waiting.resolve(object(message.result));
  });
  const read = (cwd: unknown) => new Promise<Record<string, unknown>>((resolve, reject) => {
    const id = `petrina-background-${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Codex did not return its inherited browser connections."));
    }, 30_000);
    pending.set(id, { resolve: (value) => {
      clearTimeout(timer);
      resolve(value);
    }, reject: (error) => {
      clearTimeout(timer);
      reject(error);
    } });
    send({ id, method: "config/read", params: { cwd, includeLayers: true } });
  });
  createInterface({ input: process.stdin }).on("line", (line) => {
    void (async () => {
      const message = JSON.parse(line) as { id?: unknown; method?: string; params?: Record<string, unknown> };
      if (["thread/start", "thread/resume", "thread/fork"].includes(message.method ?? "")) {
        try {
          const params = message.params ?? {};
          const inherited = await read(params.cwd);
          params.config = backgroundConfig(object(params.config), object(inherited.config), Array.isArray(inherited.layers) ? inherited.layers : []);
          message.params = params;
        } catch {
          process.stdout.write(`${JSON.stringify({
            id: message.id,
            error: {
            code: -32603,
            message: "Codex could not switch off inherited browser and desktop connections. Try this step again."
          }
          })}\n`);
          return;
        }
      }
      send(message);
    })();
  });
  process.stdin.on("end", () => child.stdin.end());
  child.on("exit", (code) => process.exit(code ?? 1));
  child.on("error", () => process.exit(1));
}

if (import.meta.main) await runCodexBackground();
