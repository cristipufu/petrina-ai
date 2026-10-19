import { StartFromSchema, WorkChoiceSchema } from "./source-schema.js";
// The local API the UI (and scripts) use. It only listens on 127.0.0.1, every request
// needs the random token, and Host/Origin are checked so a web page cannot reach it.
// The token never travels in an address: requests that carry it there are refused.

import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import { ROLE_ICON_CHOICES, ROLE_LIMITS, TONE_CHOICES, type RoleIcon, type Tone, COMMAND_NAMES, type CommandName, type Commands } from "@petrina/core";
import type { Engine } from "./engine.js";
import { Coordination, serial, type LifecycleControl } from "./coordination.js";

const ALLOWED_ORIGINS = new Set(["http://localhost:1430", "http://127.0.0.1:1430", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

/** The window's id for something it sent, so a resend after a lost confirmation counts once. */
const ClientId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Said = z.object({ taskId: z.string().optional(), about: z.string().max(4000).optional(), decided: z.boolean().optional(), clientId: ClientId.optional() });
const TaskId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const How = z.enum(["open", "copy"]);
const NewTask = z.object({
  backlog: z.boolean().optional(),
  worksOn: z.array(WorkChoiceSchema).max(20).optional(),
  startFrom: StartFromSchema.optional(),
  productId: z.string(),
  title: z.string().min(1).max(200),
  description: z.string().max(8000).optional(),
  kind: z.enum(["new", "feature", "bug", "chore"]).optional(),
  position: z.enum(["top", "bottom"]).optional(),
  approvePlan: z.boolean().optional(),
  delivery: z.enum(["pull-request", "release", "local"]).optional(),
  approveDelivery: z.boolean().optional(),
  clientId: ClientId.optional(),
});

/**
 * What each command's arguments may be, checked before the engine sees them. The compiler holds this to
 * the command table (Commands in @petrina/core): every command, nothing else, arguments the engine takes.
 */
const RoleDraft = z.object({
  name: z.string().max(ROLE_LIMITS.name * 10),
  icon: z.enum(ROLE_ICON_CHOICES as unknown as [RoleIcon, ...RoleIcon[]]),
  tone: z.enum(TONE_CHOICES as unknown as [Tone, ...Tone[]]),
  purpose: z.string().max(ROLE_LIMITS.purpose * 10),
  instructions: z.string().max(ROLE_LIMITS.instructions * 10),
  canEdit: z.boolean(),
  handsBack: z.string().max(ROLE_LIMITS.handsBack * 10),
  result: z.enum(["plan", "notes", "brief", "objections", "build", "checks", "findings", "delivery", "check-discovery", "guide", "votes"]),
});

const ARGS = {
  historyPage: z.tuple([z.object({ productId: z.string().max(200).optional(), query: z.string().max(500).optional(), cursor: z.string().max(1000).optional(), limit: z.number().int().min(1).max(100).optional() }).strict()]),
  taskDetails: z.tuple([TaskId]),
  previewImage: z.tuple([TaskId, z.string().min(1).max(4096), z.string().max(200).optional()]),
  saveRole: z.tuple([z.string(), RoleDraft]),
  addRole: z.tuple([RoleDraft]),
  resetRole: z.tuple([z.string()]),
  removeRole: z.tuple([z.string()]),
  addProduct: z.tuple([z.string().min(1).max(4096), z.string().max(200).optional()]),
  removeProduct: z.tuple([z.string()]),
  setProductChecks: z.tuple([z.string(), z.union([z.null(), z.array(z.object({ name: z.string().min(1).max(40), command: z.string().min(1).max(500) })).max(12)])]),
  updateProduct: z.tuple([z.string(), z.object({ name: z.string(), delivery: z.enum(["pull-request", "release", "local"]), approveDelivery: z.boolean(), shipLowRisk: z.boolean().optional() })]),
  setProductDelivery: z.tuple([z.string(), z.enum(["pull-request", "release", "local"]), z.boolean()]),
  setTaskStart: z.tuple([z.string(), WorkChoiceSchema]),
  setTaskProducts: z.tuple([z.string(), z.array(WorkChoiceSchema).max(20)]),
  setTaskAddition: z.tuple([z.string(), z.string(), z.string().min(1).max(200), z.string().min(1).max(4096)]),
  setTaskApproval: z.tuple([z.string(), z.boolean()]),
  addTask: z.tuple([NewTask]),
  queueTask: z.tuple([TaskId]),
  combineBacklog: z.tuple([z.array(TaskId).min(2).max(20), z.string().trim().min(1).max(200), ClientId]),
  moveToBacklog: z.tuple([TaskId]),
  updateBacklog: z.tuple([TaskId, z.object({ title: z.string().trim().min(1).max(200), description: z.string().max(8000) })]),
  checkTools: z.tuple([]),
  findClones: z.tuple([]),
  setSetupStep: z.tuple([z.enum(["welcome", "tools", "product", "task"])]),
  skipSetup: z.tuple([]),
  startFirstTask: z.tuple([NewTask.extend({ clientId: ClientId })]),
  dismissTip: z.tuple([]),
  openGuide: z.tuple([z.string().max(300)]),
  moveInQueue: z.tuple([z.string(), z.number().int()]),
  placeInQueue: z.tuple([z.string(), z.string(), z.enum(["before", "after"])]),
  moveVisibleInQueue: z.tuple([z.string(), z.array(z.string()).max(100000), z.union([z.literal(-1), z.literal(1)])]),
  moveToTop: z.tuple([z.string()]),
  setHeld: z.tuple([z.string(), z.boolean()]),
  setAfter: z.tuple([z.string(), z.array(z.string()).max(20)]),
  setPoolLimit: z.tuple([z.number()]),
  setPoolPaused: z.tuple([z.boolean()]),
  setToolCap: z.tuple([z.string(), z.number()]),
  setScreenUse: z.tuple([z.enum(["off", "hour", "on"])]),
  pause: z.tuple([z.string()]),
  resume: z.tuple([z.string()]),
  cancel: z.tuple([z.string()]),
  retry: z.tuple([z.string()]),
  sendMessage: z.tuple([z.string(), z.string().min(1).max(8000), z.enum(["queue", "interrupt"]).optional(), ClientId.optional()]),
  removeQueued: z.tuple([z.string(), z.string()]),
  setStageProfile: z.tuple([z.string(), z.string(), z.enum(["profileIds", "reviewerProfileIds"]), z.number().int(), z.string()]),
  addReviewer: z.tuple([z.string(), z.string(), z.string()]),
  allowScreen: z.tuple([z.string()]),
  setTaskScreen: z.tuple([z.string(), z.boolean()]),
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
  return await serial(engine, async () => {
    const before = engine.s?.inbox.map(item => item.id) ?? [];
    const result = await method.apply(engine, checked);
    engine.store?.noteHandled(before.filter(id => !engine.s.inbox.some(item => item.id === id)));
    return result;
  });
}

interface Socket {
  authed: boolean;
}

/** `port` 0 picks a free one: read it back from the returned server. */
export function serve(engine: Engine, options: { port: number; token: string; ui?: string; lifecycle?: LifecycleControl }) {
  const { token, ui } = options;
  const coordination = new Coordination(engine, options.lifecycle);
  let hosts = new Set<string>();
  let selfOrigins = new Set<string>();
  const sockets = new Set<ServerWebSocket<Socket>>();

  let pending: ReturnType<typeof setTimeout> | undefined;
  const broadcast = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      const message = JSON.stringify({ type: "state", state: engine.windowState() });
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
      const healthHeaders = (url.pathname === "/api/health" || url.pathname.startsWith("/api/images/")) && origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : undefined;
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
        if (url.pathname === "/api/state" && request.method === "GET") return Response.json(engine.windowState());
        if (url.pathname === "/api/coordinate" && request.method === "POST") {
          try {
            const { name, args } = await request.json() as { name: string; args: unknown };
            return Response.json(await coordination.call(name, args));
          } catch {
            return Response.json({ outcome: "failed", message: "The coordination request could not be completed. Retry changes with their original request reference." });
          }
        }
        const imagePath = /^\/api\/images\/([A-Za-z0-9_-]+)\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (imagePath && request.method === "GET") {
          const image = await engine.reportImage(imagePath[1]!, imagePath[2]!);
          return image ? new Response(image, { headers: { ...healthHeaders, "content-type": "image/png", "cache-control": "private, no-store", "x-content-type-options": "nosniff" } }) : new Response("Not found", { status: 404 });
        }
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
        socket.send(JSON.stringify({ type: "state", state: engine.windowState() }));
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
