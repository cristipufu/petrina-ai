// A stand-in for `codex app-server` in tests: it answers the handshake and the limits read
// the way the installed Codex does, and nothing else.
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const send = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);

lines.on("line", (line) => {
  const message = JSON.parse(line) as { id?: number; method?: string };
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake", codexHome: "/nowhere", platformFamily: "unix", platformOs: "macos" } });
  if (message.method === "account/rateLimits/read") {
    const window = { usedPercent: 16, windowDurationMins: 10_080, resetsAt: Math.round(Date.now() / 1000) + 5 * 86_400 };
    const snapshot = { limitId: "codex", limitName: null, primary: window, secondary: null, credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "pro" };
    send({ id: message.id, result: { rateLimits: snapshot, rateLimitsByLimitId: { codex: snapshot }, accountId: "not-for-petrina" } });
  }
});
