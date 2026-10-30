// Loaded only when an agent actually connects to its supplied browser.
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createConnection } from "@playwright/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { captureDirectory, capturePath, guardCaptureWrites } from "./captures.js";

export async function connectBrowser(root: string) {
  // Supplied filenames are confined below. A page download never passes one, and
  // saving it would follow a shortcut already in the capture folder, so every capture
  // write in this process is checked before it happens.
  guardCaptureWrites(root);
  // Do not import any PLAYWRIGHT_MCP_* settings, extension endpoints or personal profiles.
  const upstream = await createConnection({
    browser: { browserName: "chromium", isolated: true, launchOptions: { headless: true, channel: "chromium", tracesDir: root } },
    extension: false, outputDir: root, capabilities: ["core"], webmcp: false,
  });
  const client = new Client({ name: "Petrina browser", version: "1" }, { capabilities: { roots: {} } });
  client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(root).href, name: "Browser captures" }] }));
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await upstream.connect(remote);
  await client.connect(local);
  // Only expose tools whose output paths we can confine. Unknown tools stay unavailable,
  // including renamed server-side code runners that can write screenshots anywhere.
  const allowed = new Set([
    "browser_close", "browser_resize", "browser_console_messages", "browser_handle_dialog",
    "browser_emulate_media", "browser_evaluate", "browser_file_upload", "browser_drop",
    "browser_find", "browser_fill_form", "browser_press_key", "browser_type",
    "browser_navigate", "browser_navigate_back", "browser_network_requests", "browser_network_request",
    "browser_take_screenshot", "browser_snapshot", "browser_click", "browser_drag",
    "browser_hover", "browser_select_option", "browser_tabs", "browser_wait_for",
  ]);
  let used = false;
  function proxy() {
    const server = new Server({ name: "Playwright", version: "1" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const result = await client.listTools();
      return { ...result, tools: result.tools.filter((tool) => allowed.has(tool.name)) };
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      try {
        if (!allowed.has(params.name)) throw new Error("Use the supplied browser's page tools for this check.");
        // Tools can create automatic output without a filename. Refuse a redirected
        // capture directory before invoking any of them; cleanup closes upstream directly.
        await captureDirectory(root);
        const args = { ...params.arguments };
        if (params.name === "browser_take_screenshot" && args.filename === undefined) {
          const format = args.type === "jpeg" || args.type === "webp" ? args.type : "png";
          args.filename = `page-${randomUUID()}.${format}`;
        }
        if (typeof args.filename === "string") args.filename = await capturePath(root, args.filename);
        used = true;
        return await client.callTool({ name: params.name, arguments: args });
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "The browser check failed." }] };
      }
    });
    return server;
  }
  // Connectors may reconnect MCP while changing models or safety mode. Each protocol
  // connection gets its own transport, while this agent keeps its single isolated browser.
  const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const proxies = new Set<ReturnType<typeof proxy>>();
  return {
    async fetch(request: Request): Promise<Response> {
      const id = request.headers.get("mcp-session-id");
      let transport = id ? sessions.get(id) : undefined;
      if (id && !transport) return new Response("Session ended", { status: 404 });
      if (!transport) {
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => { sessions.set(
          id,
          transport!
        ); }
        });
        const server = proxy();
        proxies.add(server);
        await server.connect(transport);
      }
      return transport.handleRequest(request);
    },
    async close() {
      if (used) await client.callTool({ name: "browser_close", arguments: {} }).catch(() => undefined);
      await client.close();
      await upstream.close();
      await Promise.all([...proxies].map((server) => server.close()));
    },
  };
}
