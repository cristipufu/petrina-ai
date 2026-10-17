// The local API the UI (and scripts) use. It only listens on 127.0.0.1, every request
// needs the random token, and Host/Origin are checked so a web page cannot reach it.
// The token never travels in an address: requests that carry it there are refused.

import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import type { Engine } from "./engine.js";

const ALLOWED_ORIGINS = new Set(["http://localhost:1430", "http://127.0.0.1:1430", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

/** The window's id for something it sent, so a resend after a lost confirmation counts once. */
const ClientId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Said = z.object({ taskId: z.string().optional(), about: z.string().max(4000).optional(), clientId: ClientId.optional() });
const TaskId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const How = z.enum(["open", "copy"]);

const Action = z.discriminatedUnion("name", [
  z.object({ name: z.literal("addProduct"), args: z.tuple([z.string().min(1), z.string().optional()]) }),
  z.object({ name: z.literal("removeProduct"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("setProductChecks"), args: z.tuple([z.string(), z.union([z.null(), z.array(z.object({ name: z.string().min(1).max(40), command: z.string().min(1).max(500) })).max(12)])]) }),
  z.object({ name: z.literal("updateProduct"), args: z.tuple([z.string(), z.object({ name: z.string(), delivery: z.enum(["pull-request", "release", "local"]), approveDelivery: z.boolean(), shipLowRisk: z.boolean().optional() })]) }),
  z.object({ name: z.literal("setProductDelivery"), args: z.tuple([z.string(), z.enum(["pull-request", "release", "local"]), z.boolean()]) }),
  z.object({
    name: z.literal("addTask"),
    args: z.tuple([
      z.object({
        productId: z.string(),
        title: z.string().min(1).max(200),
        description: z.string().max(8000).optional(),
        kind: z.enum(["new", "feature", "bug", "chore"]).optional(),
        position: z.enum(["top", "bottom"]).optional(),
        approvePlan: z.boolean().optional(),
        delivery: z.enum(["pull-request", "release", "local"]).optional(),
        approveDelivery: z.boolean().optional(),
      }),
    ]),
  }),
  z.object({ name: z.literal("moveInQueue"), args: z.tuple([z.string(), z.number().int()]) }),
  z.object({ name: z.literal("placeInQueue"), args: z.tuple([z.string(), z.string(), z.enum(["before", "after"])]) }),
  z.object({ name: z.literal("moveVisibleInQueue"), args: z.tuple([z.string(), z.array(z.string()).max(100000), z.union([z.literal(-1), z.literal(1)])]) }),
  z.object({ name: z.literal("moveToTop"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("setHeld"), args: z.tuple([z.string(), z.boolean()]) }),
  z.object({ name: z.literal("setAfter"), args: z.tuple([z.string(), z.array(z.string()).max(20)]) }),
  z.object({ name: z.literal("setPoolLimit"), args: z.tuple([z.number()]) }),
  z.object({ name: z.literal("setPoolPaused"), args: z.tuple([z.boolean()]) }),
  z.object({ name: z.literal("setToolCap"), args: z.tuple([z.string(), z.number()]) }),
  z.object({ name: z.literal("pause"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("resume"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("cancel"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("retry"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("sendMessage"), args: z.tuple([z.string(), z.string().min(1).max(8000), z.enum(["queue", "interrupt"]).optional(), ClientId.optional()]) }),
  z.object({ name: z.literal("removeQueued"), args: z.tuple([z.string(), z.string()]) }),
  z.object({ name: z.literal("setStageProfile"), args: z.tuple([z.string(), z.string(), z.enum(["profileIds", "reviewerProfileIds"]), z.number().int(), z.string()]) }),
  z.object({ name: z.literal("addReviewer"), args: z.tuple([z.string(), z.string(), z.string()]) }),
  z.object({ name: z.literal("answer"), args: z.tuple([z.string(), z.string().min(1).max(4000), Said.optional()]) }),
  z.object({ name: z.literal("decideForMe"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("allow"), args: z.tuple([z.string(), z.enum(["once", "always"])]) }),
  z.object({ name: z.literal("deny"), args: z.tuple([z.string(), z.string().max(4000).optional(), Said.optional()]) }),
  z.object({ name: z.literal("approve"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("requestChanges"), args: z.tuple([z.string(), z.string().min(1).max(4000)]) }),
  z.object({ name: z.literal("checkShipping"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("shipAgain"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("markDone"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("takeOver"), args: z.tuple([TaskId, How.optional()]) }),
  z.object({ name: z.literal("reopenTerminal"), args: z.tuple([TaskId, How.optional()]) }),
  z.object({ name: z.literal("handBackPreview"), args: z.tuple([TaskId]) }),
  z.object({ name: z.literal("handBack"), args: z.tuple([TaskId, z.string().max(4000).optional(), z.boolean().optional()]) }),
  z.object({ name: z.literal("setTerminal"), args: z.tuple([z.string().regex(/^[a-z0-9-]{0,40}$/)]) }),
]);

export async function dispatch(engine: Engine, raw: unknown): Promise<unknown> {
  const action = Action.parse(raw);
  const method = (engine as unknown as Record<string, (...args: unknown[]) => unknown>)[action.name];
  if (typeof method !== "function") throw new Error(`Unknown action ${action.name}`);
  return await method.apply(engine, action.args as unknown[]);
}

interface Socket {
  authed: boolean;
}

/** `port` 0 picks a free one: read it back from the returned server. */
export function serve(engine: Engine, options: { port: number; token: string; ui?: string }) {
  const { token, ui } = options;
  let hosts = new Set<string>();
  let selfOrigins = new Set<string>();
  const sockets = new Set<ServerWebSocket<Socket>>();

  let pending: ReturnType<typeof setTimeout> | undefined;
  const broadcast = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      const message = JSON.stringify({ type: "state", state: engine.getState() });
      for (const socket of sockets) socket.send(message);
    }, 120);
  };
  engine.subscribe(broadcast);

  const tokenOk = (value: string | null | undefined) => {
    if (!value || value.length !== token.length) return false;
    let diff = 0;
    for (let index = 0; index < token.length; index += 1) diff |= value.charCodeAt(index) ^ token.charCodeAt(index);
    return diff === 0;
  };

  const server = Bun.serve<Socket>({
    hostname: "127.0.0.1",
    port: options.port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (!hosts.has(request.headers.get("host") ?? "")) return new Response("Forbidden", { status: 403 });
      // An address with the key in it ends up in logs and history: refuse it, even when the key is right.
      if (request.url.includes(token) || url.searchParams.has("token")) return new Response("The key never goes in the address", { status: 400 });
      const origin = request.headers.get("origin");
      if (origin && !selfOrigins.has(origin)) return new Response("Forbidden", { status: 403 });

      // A browser on the dev server can distinguish an engine that is down from one with a new
      // key. Only the health check allows cross-origin reads, and only from Petrina's own pages.
      const healthHeaders = url.pathname === "/api/health" && origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : undefined;
      if (healthHeaders && request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...healthHeaders, "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "Authorization" } });

      if (url.pathname === "/ws") {
        // Browsers always send Origin on WebSocket handshakes: a missing one is not a browser we know.
        if (!origin) return new Response("Forbidden", { status: 403 });
        // The token travels as a subprotocol, so it never appears in a URL or a log line.
        const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((entry) => entry.trim());
        const presented = offered.find((entry) => entry.startsWith("petrina.token."))?.slice("petrina.token.".length);
        if (!offered.includes("petrina.v1") || !tokenOk(presented)) return new Response("Unauthorized", { status: 401 });
        return server.upgrade(request, { data: { authed: true }, headers: { "Sec-WebSocket-Protocol": "petrina.v1" } }) ? undefined : new Response("Upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/api/")) {
        const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!tokenOk(bearer)) return new Response("Unauthorized", { status: 401, headers: healthHeaders });
        if (url.pathname === "/api/health" && request.method === "GET") return Response.json({ ok: true, pid: process.pid }, { headers: healthHeaders });
        if (url.pathname === "/api/state" && request.method === "GET") return Response.json(engine.getState());
        if (url.pathname === "/api/action" && request.method === "POST") {
          try {
            const result = await dispatch(engine, await request.json());
            return Response.json({ ok: true, result: result ?? null });
          } catch (error) {
            return Response.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
          }
        }
        return new Response("Not found", { status: 404 });
      }

      if (ui) return serveUi(ui, url.pathname);
      return new Response("Petrina engine", { status: 200 });
    },
    websocket: {
      maxPayloadLength: 1 << 20,
      open(socket) {
        sockets.add(socket);
        socket.send(JSON.stringify({ type: "state", state: engine.getState() }));
      },
      async message(socket, data) {
        let id: unknown;
        try {
          const message = JSON.parse(String(data)) as { id?: unknown; action?: unknown };
          id = message.id;
          const result = await dispatch(engine, message.action);
          socket.send(JSON.stringify({ type: "result", id, ok: true, result: result ?? null }));
        } catch (error) {
          socket.send(JSON.stringify({ type: "result", id, ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
      },
      close(socket) {
        sockets.delete(socket);
      },
    },
  });
  hosts = new Set([`127.0.0.1:${server.port}`, `localhost:${server.port}`]);
  selfOrigins = new Set([...ALLOWED_ORIGINS, `http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`]);
  return server;
}

/**
 * Serve the built UI. It carries no secret: `petrina open` hands the token to the page in the
 * URL fragment, which never reaches a server or a log.
 */
async function serveUi(root: string, pathname: string): Promise<Response> {
  const base = resolve(root);
  const target = normalize(join(base, pathname === "/" ? "index.html" : pathname));
  if (!target.startsWith(base + sep) && target !== base) return new Response("Not found", { status: 404 });
  const file = existsSync(target) ? target : join(base, "index.html");
  return new Response(Bun.file(file), file.endsWith("index.html") ? { headers: { "cache-control": "no-store" } } : undefined);
}
