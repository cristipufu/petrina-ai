// A stand-in for `codex app-server`, for tests: JSON lines over stdio, the way Codex's app-server speaks.
// It answers `initialize` and `account/rateLimits/read` from dir/codex.json, notes every request it gets
// in dir/codex.jsonl (with its process id, so a test can check it was stopped), and sends a notification
// without an id first, as the real one does. It ends when its stdin ends.
// bun fake-codex.ts <dir>
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface CodexScript {
  /** The windows the read answers with (the app-server's own shape, seconds for `resetsAt`). */
  primary?: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
  secondary?: { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
  /** The read fails with this message (Codex not logged in, say). */
  error?: string;
  /** Never answer the read. */
  hang?: boolean;
}

const dir = process.argv[2];
const script = (): CodexScript => !dir ? { primary: { usedPercent: 16, windowDurationMins: 10_080, resetsAt: Math.round(Date.now() / 1000) + 5 * 86_400 } } : (existsSync(join(dir, "codex.json")) ? (JSON.parse(readFileSync(join(dir, "codex.json"), "utf8")) as CodexScript) : {});
const note = (message: unknown) => dir && appendFileSync(join(dir, "codex.jsonl"), `${JSON.stringify({ pid: process.pid, ...(message as object) })}\n`);
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString();
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
    const line = buffer.slice(0, at).trim();
    buffer = buffer.slice(at + 1);
    if (!line) continue;
    const message = JSON.parse(line) as { id: number; method: string; params?: unknown };
    note(message);
    if (message.method === "initialize") {
      send({ id: message.id, result: { userAgent: "fake-codex", codexHome: dir, platformFamily: "unix", platformOs: "test" } });
      // Not an answer: the reader must let it pass.
      send({ method: "account/updated", params: { authMode: "chatgpt", planType: "test" }, emittedAtMs: Date.now() });
      continue;
    }
    if (message.method === "account/rateLimits/read") {
      const plan = script();
      if (plan.hang) continue;
      if (plan.error) {
        send({ id: message.id, error: { code: -32000, message: plan.error } });
        continue;
      }
      const snapshot = { limitId: "codex", limitName: null, primary: plan.primary ?? null, secondary: plan.secondary ?? null, credits: null, planType: "test", rateLimitReachedType: null };
      send({ id: message.id, result: { ordinaryUsageAllowed: true, rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot } } });
      continue;
    }
    send({ id: message.id, error: { code: -32601, message: `fake codex does not know ${message.method}` } });
  }
});
process.stdin.on("end", () => process.exit(0));
