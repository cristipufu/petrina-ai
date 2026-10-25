import type { AgentBrowser } from "../../src/browser.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export async function connectBrowser(browser: AgentBrowser): Promise<Client> {
  if (!("url" in browser.mcp) || !("headers" in browser.mcp)) throw new Error("Expected an HTTP browser");
  const client = new Client({ name: "browser check", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(browser.mcp.url), { requestInit: { headers: Object.fromEntries(browser.mcp.headers.map(header => [header.name, header.value])) } }));
  return client;
}
