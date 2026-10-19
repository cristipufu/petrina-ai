// One engine-owned Playwright MCP instance. Its stdin is a lifetime pipe from Petrina.
// The protocol proxy only confines browser output; the coding tool still owns permissions.
import { rm } from "node:fs/promises";
import type { connectBrowser } from "./browser-connection.js";

const [root, secret, owner] = process.argv.slice(2) as [string, string, string];
process.chdir(root);
// Most conversations never use a page. Keep their supplied endpoint ready without
// loading Playwright and its protocol libraries in another process for each one.
let connection: ReturnType<typeof connectBrowser> | undefined;
let closing = false;
const http = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Unauthorized", { status: 401 });
  if (closing) return new Response("Session ended", { status: 503 });
  try {
    const browser = await (connection ??= import("./browser-connection.js").then(({ connectBrowser }) => connectBrowser(root)));
    if (closing) return new Response("Session ended", { status: 503 });
    return browser.fetch(request);
  } catch {
    return new Response("The headless browser could not start. Try this step again.", { status: 503 });
  }
} });
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(watchdog);
  http.stop(true);
  await connection?.then((browser) => browser.close(), () => undefined);
  await rm(root, { recursive: true, force: true });
  process.exit(0);
}
const watchdog = setInterval(() => { try { process.kill(Number(owner), 0); } catch { void close(); } }, 1000);
process.stdin.resume();
process.stdin.on("end", () => void close());
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
console.log(JSON.stringify({ url: `http://127.0.0.1:${http.port}/mcp` }));
