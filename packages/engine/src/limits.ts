// Codex doesn't send its usage limits through ACP, so Petrina asks the installed Codex
// directly: it starts `codex app-server`, reads `account/rateLimits/read` and stops it.
// No agent, no thread, no tokens. Only each limit's percentage, length and reset are kept.

import { spawn } from "node:child_process";
import { codexLimits, type UsageReport } from "@petrina/core";

export async function readCodexLimits(command: readonly string[], options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = { cwd: process.cwd() }): Promise<UsageReport[]> {
  const [program, ...args] = command;
  if (!program) throw new Error("No Codex command");
  const child = spawn(program, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: options.env ?? process.env });
  return await new Promise<UsageReport[]>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error: Error | undefined, limits?: UsageReport[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin?.end();
      if (child.exitCode === null) child.kill();
      if (error) reject(error);
      else resolve(limits ?? []);
    };
    const timer = setTimeout(() => finish(new Error("Codex did not answer in time")), options.timeoutMs ?? 15_000);
    child.once("error", (error) => finish(error));
    child.once("exit", () => finish(new Error("Codex stopped before answering")));
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 1 << 20) return finish(new Error("Codex sent too much"));
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message: { id?: unknown; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 0 && message.error) return finish(new Error("Codex refused to start"));
        if (message.id === 0) {
          send({ method: "initialized" });
          send({ id: 1, method: "account/rateLimits/read" });
        } else if (message.id === 1) {
          return message.error ? finish(new Error("Codex did not report its limits")) : finish(undefined, codexLimits(message.result, Date.now()));
        }
      }
    });
    const send = (message: object) => child.stdin?.write(`${JSON.stringify(message)}\n`);
    send({ id: 0, method: "initialize", params: { clientInfo: { name: "petrina", title: "Petrina", version: "0.1.0" }, capabilities: { experimentalApi: true } } });
  });
}
