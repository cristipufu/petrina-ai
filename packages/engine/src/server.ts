// The local API the UI (and scripts) use. It only listens on 127.0.0.1, every request
// needs the random token, and Host/Origin are checked so a web page cannot reach it.

import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import type { Engine } from "./engine.js";

const ALLOWED_ORIGINS = new Set(["http://localhost:1430", "http://127.0.0.1:1430", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

const Action = z.discriminatedUnion("name", [
  z.object({ name: z.literal("addProduct"), args: z.tuple([z.string().min(1)]) }),
  z.object({ name: z.literal("removeProduct"), args: z.tuple([z.string()]) }),
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
  z.object({ name: z.literal("moveToTop"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("setHeld"), args: z.tuple([z.string(), z.boolean()]) }),
  z.object({ name: z.literal("setPoolLimit"), args: z.tuple([z.number()]) }),
  z.object({ name: z.literal("setPoolPaused"), args: z.tuple([z.boolean()]) }),
  z.object({ name: z.literal("pause"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("resume"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("cancel"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("retry"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("sendMessage"), args: z.tuple([z.string(), z.string().min(1).max(8000), z.enum(["queue", "interrupt"]).optional()]) }),
  z.object({ name: z.literal("removeQueued"), args: z.tuple([z.string(), z.string()]) }),
  z.object({ name: z.literal("setStageProfile"), args: z.tuple([z.string(), z.string(), z.enum(["profileIds", "reviewerProfileIds"]), z.number().int(), z.string()]) }),
  z.object({ name: z.literal("addReviewer"), args: z.tuple([z.string(), z.string(), z.string()]) }),
  z.object({ name: z.literal("answer"), args: z.tuple([z.string(), z.string().min(1).max(4000)]) }),
  z.object({ name: z.literal("decideForMe"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("allow"), args: z.tuple([z.string(), z.enum(["once", "always"])]) }),
  z.object({ name: z.literal("deny"), args: z.tuple([z.string(), z.string().optional()]) }),
  z.object({ name: z.literal("approve"), args: z.tuple([z.string()]) }),
  z.object({ name: z.literal("requestChanges"), args: z.tuple([z.string(), z.string().min(1).max(4000)]) }),
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

export function serve(engine: Engine, options: { port: number; token: string; ui?: string }) {
  const { port, token, ui } = options;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const selfOrigins = new Set([...ALLOWED_ORIGINS, `http://127.0.0.1:${port}`, `http://localhost:${port}`]);
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

  return Bun.serve<Socket>({
    hostname: "127.0.0.1",
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      if (!hosts.has(request.headers.get("host") ?? "")) return new Response("Forbidden", { status: 403 });
      const origin = request.headers.get("origin");
      if (origin && !selfOrigins.has(origin)) return new Response("Forbidden", { status: 403 });

      if (url.pathname === "/ws") {
        if (!tokenOk(url.searchParams.get("token"))) return new Response("Unauthorized", { status: 401 });
        return server.upgrade(request, { data: { authed: true } }) ? undefined : new Response("Upgrade failed", { status: 400 });
      }

      if (url.pathname.startsWith("/api/")) {
        const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!tokenOk(bearer)) return new Response("Unauthorized", { status: 401 });
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

      if (ui) return serveUi(ui, url.pathname, port, token);
      return new Response("Petrina engine", { status: 200 });
    },
    websocket: {
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
}

/** Serve the built UI with the connection details in a meta tag (no inline script, so the CSP holds). */
async function serveUi(root: string, pathname: string, port: number, token: string): Promise<Response> {
  const base = resolve(root);
  const target = normalize(join(base, pathname === "/" ? "index.html" : pathname));
  if (!target.startsWith(base + sep) && target !== base) return new Response("Not found", { status: 404 });
  const file = existsSync(target) ? target : join(base, "index.html");
  if (file.endsWith("index.html")) {
    const html = await Bun.file(file).text();
    const meta = `<meta name="petrina-engine" content="${JSON.stringify({ url: `ws://127.0.0.1:${port}/ws`, token }).replace(/"/g, "&quot;")}" />`;
    return new Response(html.replace("<head>", `<head>\n    ${meta}`), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }
  return new Response(Bun.file(file));
}
