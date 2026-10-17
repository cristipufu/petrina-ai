// The local API the UI (and scripts) use. It only listens on 127.0.0.1, every request
// needs the random token, and Host/Origin are checked so a web page cannot reach it.
// The token never travels in an address: requests that carry it there are refused.

import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { COMMAND_NAMES, type CommandName, type Commands } from "@petrina/core";
import type { Engine } from "./engine.js";

const ALLOWED_ORIGINS = new Set(["http://localhost:1430", "http://127.0.0.1:1430", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

/** The window's id for something it sent, so a resend after a lost confirmation counts once. */
const ClientId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Said = z.object({ taskId: z.string().optional(), about: z.string().max(4000).optional(), clientId: ClientId.optional() });
const TaskId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const How = z.enum(["open", "copy"]);

/**
 * What each command's arguments may be, checked before the engine sees them. The compiler holds this to
 * the command table (Commands in @petrina/core): every command, nothing else, arguments the engine takes.
 */
const ARGS = {
  addProduct: z.tuple([z.string().min(1), z.string().optional()]),
  removeProduct: z.tuple([z.string()]),
  setProductChecks: z.tuple([z.string(), z.union([z.null(), z.array(z.object({ name: z.string().min(1).max(40), command: z.string().min(1).max(500) })).max(12)])]),
  updateProduct: z.tuple([z.string(), z.object({ name: z.string(), delivery: z.enum(["pull-request", "release", "local"]), approveDelivery: z.boolean(), shipLowRisk: z.boolean().optional() })]),
  setProductDelivery: z.tuple([z.string(), z.enum(["pull-request", "release", "local"]), z.boolean()]),
  addTask: z.tuple([
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
  moveInQueue: z.tuple([z.string(), z.number().int()]),
  placeInQueue: z.tuple([z.string(), z.string(), z.enum(["before", "after"])]),
  moveVisibleInQueue: z.tuple([z.string(), z.array(z.string()).max(100000), z.union([z.literal(-1), z.literal(1)])]),
  moveToTop: z.tuple([z.string()]),
  setHeld: z.tuple([z.string(), z.boolean()]),
  setAfter: z.tuple([z.string(), z.array(z.string()).max(20)]),
  setPoolLimit: z.tuple([z.number()]),
  setPoolPaused: z.tuple([z.boolean()]),
  setToolCap: z.tuple([z.string(), z.number()]),
  pause: z.tuple([z.string()]),
  resume: z.tuple([z.string()]),
  cancel: z.tuple([z.string()]),
  retry: z.tuple([z.string()]),
  sendMessage: z.tuple([z.string(), z.string().min(1).max(8000), z.enum(["queue", "interrupt"]).optional(), ClientId.optional()]),
  removeQueued: z.tuple([z.string(), z.string()]),
  setStageProfile: z.tuple([z.string(), z.string(), z.enum(["profileIds", "reviewerProfileIds"]), z.number().int(), z.string()]),
  addReviewer: z.tuple([z.string(), z.string(), z.string()]),
  answer: z.tuple([z.string(), z.string().min(1).max(4000), Said.optional()]),
  decideForMe: z.tuple([z.string()]),
  allow: z.tuple([z.string(), z.enum(["once", "always"])]),
  deny: z.tuple([z.string(), z.string().max(4000).optional(), Said.optional()]),
  approve: z.tuple([z.string()]),
  decline: z.tuple([z.string()]),
  addLessons: z.tuple([z.string(), z.array(z.number().int().min(0).max(50)).max(50)]),
  requestChanges: z.tuple([z.string(), z.string().min(1).max(4000)]),
  checkShipping: z.tuple([z.string()]),
  shipAgain: z.tuple([z.string()]),
  markDone: z.tuple([z.string()]),
  takeOver: z.tuple([TaskId, How.optional()]),
  reopenTerminal: z.tuple([TaskId, How.optional()]),
  handBackPreview: z.tuple([TaskId]),
  handBack: z.tuple([TaskId, z.string().max(4000).optional(), z.boolean().optional()]),
  setTerminal: z.tuple([z.string().regex(/^[a-z0-9-]{0,40}$/)]),
  // The window asks for the numbers of one view at a time: only these views and periods exist.
  usage: z.tuple([
    z.discriminatedUnion("view", [
      z.object({ view: z.literal("task"), taskId: z.string().min(1).max(200) }).strict(),
      z.object({ view: z.literal("products") }).strict(),
      z.object({ view: z.literal("today") }).strict(),
      z.object({ view: z.literal("analytics"), period: z.enum(["today", "7d", "30d"]), productId: z.string().min(1).max(200).optional() }).strict(),
    ]),
  ]),
} satisfies { [K in CommandName]: z.ZodType<Parameters<Commands[K]>> };

const Envelope = z.object({ name: z.enum(COMMAND_NAMES), args: z.array(z.unknown()) });

export async function dispatch(engine: Engine, raw: unknown): Promise<unknown> {
  const { name, args } = Envelope.parse(raw);
  const checked = ARGS[name].parse(args) as unknown[];
  const method = engine[name] as (...args: unknown[]) => unknown;
  return await method.apply(engine, checked);
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
