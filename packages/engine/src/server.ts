import { allowsLongWait, CheckSetupRequirementsSchema } from "./operations.js";
import { StartFromSchema, WorkChoiceSchema } from "./source-schema.js";
// The local API the UI (and scripts) use. It only listens on 127.0.0.1, every request
// needs the random token, and Host/Origin are checked so a web page cannot reach it.
// The token never travels in an address: requests that carry it there are refused.

import { existsSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import type { ServerWebSocket } from "bun";
import { z } from "zod";
import {
  MAX_READING_OFFSET,
  READING_PAGE_SIZE,
  allowanceKey,
  captureWindowStateBase,
  diffWindowState,
  HISTORY_STATUSES,
  type HistoryStatus,
  ROLE_ICON_CHOICES,
  ROLE_LIMITS,
  TONE_CHOICES,
  COMMAND_NAMES,
  type CommandName,
  type Commands,
  type State,
  type WindowStateBase,
} from "@petrina/core";
import type { Engine } from "./engine.js";
import { Coordination, serial, type LifecycleControl } from "./coordination.js";

const ALLOWED_ORIGINS = new Set(["http://localhost:1430", "http://127.0.0.1:1430", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]);

/** The window's id for something it sent, so a resend after a lost confirmation counts once. */
const ClientId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Said = z.object({
  taskId: z.string().optional(),
  about: z.string().max(4000).optional(),
  decided: z.boolean().optional(),
  clientId: ClientId.optional()
});
const TaskId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const How = z.enum(["open", "copy"]);
const NewTask = z.object({
  backlog: z.boolean().optional(),
  after: z.array(TaskId).max(20).optional(),
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
  category: z.enum(["workflow", "maintenance"]).optional(),
  name: z.string().max(ROLE_LIMITS.name * 10),
  icon: z.enum(ROLE_ICON_CHOICES),
  tone: z.enum(TONE_CHOICES),
  purpose: z.string().max(ROLE_LIMITS.purpose * 10),
  instructions: z.string().max(ROLE_LIMITS.instructions * 10),
  canEdit: z.boolean(),
  handsBack: z.string().max(ROLE_LIMITS.handsBack * 10),
  result: z.enum(["plan", "notes", "brief", "objections", "build", "checks", "findings", "delivery", "check-discovery", "guide", "votes"]),
});

const RoutineDraft = z.object({
  name: z.string().max(100),
  productId: z.string(),
  roleId: z.string(),
  profileId: z.string(),
  focus: z.string().max(4000),
  zone: z.string().max(100),
  enabled: z.boolean(),
  schedule: z.discriminatedUnion(
  "kind",
  [
  z.object({
  kind: z.literal("daily"),
  time: z.string()
}),
  z.object({
  kind: z.literal("weekly"),
  time: z.string(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7)
}),
  z.object({
  kind: z.literal("cron"),
  expression: z.string().max(200)
})
]
)
});
const HistoryReport = z.object({
  toolId: z.string().min(1).max(200),
  kind: z.string().min(1).max(200),
  model: z.string().max(200).optional(),
  name: z.string().max(400).optional(),
  status: z.enum([
  "allowed",
  "allowed_warning",
  "rejected"
]),
  at: z.number().int().min(0),
  utilization: z.number().optional(),
  windowMinutes: z.number().positive().optional(),
  resetsAt: z.number().min(0).optional(),
  overage: z.boolean().optional()
}).strict();
const ARGS = {
  profileChoices: z.tuple([z.object({
    toolId: z.string().min(1).max(100),
    modelId: z.string().min(1).max(200).optional(),
    refresh: z.boolean().optional()
  }).strict()]),
  saveProfile: z.tuple([
    z.object({
    toolId: z.string().min(1).max(100),
    modelId: z.string().min(1).max(200),
    effort: z.enum([
    "low",
    "medium",
    "high",
    "xhigh",
    "ultra"
  ]),
    standby: z.boolean().optional()
  }).strict(),
    ClientId,
    z.string().optional()
  ]),
  removeProfile: z.tuple([z.string()]),
  saveRoutine: z.tuple([RoutineDraft, z.string().optional()]),
  setRoutineEnabled: z.tuple([z.string(), z.boolean()]),
  removeRoutine: z.tuple([z.string()]),
  resolveMaintenanceSettings: z.tuple([TaskId, z.enum(["keep", "stop"])]),
  historyPage: z.tuple([z.object({
    includeUsage: z.boolean().optional(),
    taskId: TaskId.optional(),
    status: z.enum(Object.keys(HISTORY_STATUSES) as HistoryStatus[]).optional(),
    routineId: z.string().min(1).max(200).optional(),
    productId: z.string().max(200).optional(),
    query: z.string().max(500).optional(),
    cursor: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(100).optional()
  }).strict()]),
  taskDetails: z.tuple([TaskId]),
  taskDetailsDelta: z.tuple([TaskId, z.string().min(1).max(200)]),
  previewImage: z.tuple([TaskId, z.string().min(1).max(4096), z.string().max(200).optional()]),
  saveRole: z.tuple([z.string(), RoleDraft]),
  addRole: z.tuple([RoleDraft]),
  resetRole: z.tuple([z.string()]),
  removeRole: z.tuple([z.string()]),
  addProduct: z.tuple([z.string().min(1).max(4096), z.string().max(200).optional()]),
  removeProduct: z.tuple([z.string()]),
  setProductChecks: z.tuple([
    z.string(),
    z.union([
    z.null(),
    z.array(z.object({
    name: z.string().min(1).max(40),
    command: z.string().min(1).max(500)
  })).max(12)
  ])
  ]),
  setProductCheckSetup: z.tuple([z.string(), CheckSetupRequirementsSchema]),
  setProductRemoteChecks: z.tuple([
    z.string(),
    z.array(z.string().min(1).max(120)).max(20),
  ]),
  updateProduct: z.tuple([
    z.string(),
    z.object({
    name: z.string(),
    delivery: z.enum([
    "pull-request",
    "release",
    "local"
  ]),
    approveDelivery: z.boolean(),
    shipLowRisk: z.boolean().optional()
  })
  ]),
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
  rerunChecks: z.tuple([z.string()]),
  sendMessage: z.tuple([z.string(), z.string().min(1).max(8000), z.enum(["now", "queue", "interrupt"]).optional(), ClientId.optional()]),
  removeQueued: z.tuple([z.string(), z.string()]),
  setStageProfile: z.tuple([z.string(), z.string(), z.enum(["profileIds", "reviewerProfileIds"]), z.number().int(), z.string()]),
  addReviewer: z.tuple([z.string(), z.string(), z.string()]),
  allowScreen: z.tuple([z.string()]),
  setTaskScreen: z.tuple([z.string(), z.boolean()]),
  answer: z.tuple([z.string(), z.string().min(1).max(4000), Said.optional()]),
  decideForMe: z.tuple([z.string()]),
  allow: z.tuple([z.string(), z.enum(["once", "always"]).optional()]),
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
      z.object({ view: z.literal("node"), taskId: z.string().min(1).max(200), nodeId: z.string().min(1).max(200) }).strict(),
      z.object({ view: z.literal("products") }).strict(),
      z.object({ view: z.literal("today") }).strict(),
      z.object({
        view: z.literal("readings"),
        toolId: z.string().min(1).max(200),
        allowanceKey: z.string().min(1).max(600),
        from: z.number().int().min(0),
        to: z.number().int().min(0),
        snapshotAt: z.number().int().min(0),
        latest: HistoryReport.optional(),
        offset: z.number().int().min(0).max(MAX_READING_OFFSET).multipleOf(READING_PAGE_SIZE)
      }).strict(),
      z.object({ view: z.literal("analytics"), period: z.enum(["today", "7d", "30d"]), productId: z.string().min(1).max(200).optional() }).strict(),
    ]),
  ]),
} satisfies { [K in CommandName]: z.ZodType<Parameters<Commands[K]>> };

type MutableInput<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { -readonly [K in keyof T]: MutableInput<T[K]> }
    : T;

type CheckCommandInputs<
  T extends { [K in CommandName]: (args: MutableInput<Parameters<Commands[K]>>) => Parameters<Commands[K]> },
> = T;
export type CheckedCommandInputs = CheckCommandInputs<{
  [K in CommandName]: (args: z.input<(typeof ARGS)[K]>) => z.output<(typeof ARGS)[K]>;
}>;

const Envelope = z.object({ name: z.enum(COMMAND_NAMES), args: z.array(z.unknown()) });

export async function dispatch(engine: Engine, raw: unknown): Promise<unknown> {
  const { name, args } = Envelope.parse(raw);
  const checked = ARGS[name].parse(args) as unknown[];
  if (name === "usage") {
    const request = checked[0] as Parameters<Commands["usage"]>[0];
    if (request.view === "readings" && (request.to <= request.from || request.to - request.from > 31 * 86_400_000)) throw new Error("Choose dates within 31 days");
    if (request.view === "readings" && request.latest && (request.latest.at > request.snapshotAt || request.latest.toolId !== request.toolId || allowanceKey(request.latest) !== request.allowanceKey)) throw new Error("The latest report must belong to this allowance and snapshot");
  }
  const method = engine[name] as (...args: unknown[]) => unknown;
  if (name === "profileChoices") return await method.apply(engine, checked);
  // Native discovery must not hold the coordinator mutation queue while a tool opens.
  if (name === "saveProfile") {
    const draft = checked[0] as Parameters<Commands["saveProfile"]>[0];
    await engine.profileChoices({
    toolId: draft.toolId,
    modelId: draft.modelId
  });
  }
  return await serial(engine, async () => {
    const before = engine.s?.inbox.map(item => item.id) ?? [];
    const result = await method.apply(engine, checked);
    engine.store?.noteHandled(before.filter(id => !engine.s.inbox.some(item => item.id === id)));
    return result;
  });
}

interface Socket {
  authed: boolean;
  dirty: boolean;
  awaitingState?: number;
  ackedStateId?: number;
  ackedBase?: WindowStateBase;
  pendingBase?: { stateId: number; base: WindowStateBase };
}

/** `port` 0 picks a free one: read it back from the returned server. */
export function serve(engine: Engine, options: { port: number; token: string; ui?: string; lifecycle?: LifecycleControl }) {
  const { token, ui } = options;
  const coordination = new Coordination(engine, options.lifecycle);
  let hosts = new Set<string>();
  let selfOrigins = new Set<string>();
  const sockets = new Set<ServerWebSocket<Socket>>();

  let pending: ReturnType<typeof setTimeout> | undefined;
  let stateId = 0;
  const send = (socket: ServerWebSocket<Socket>, message: string) => {
    // Bun can drop a message when its buffer is full. Reconnect rather than silently lose a reply.
    if (socket.send(message) === 0) socket.close(1013, "The window fell behind. Reconnecting.");
  };
  const sendState = (ready: ServerWebSocket<Socket>[]) => {
    if (!ready.length) return;
    const id = ++stateId;
    let snapshot: State;
    let currentBase: WindowStateBase;
    let fullMessage: string | undefined;
    const deltaMessages = new Map<number, string>();
    try {
      snapshot = engine.windowState();
      currentBase = captureWindowStateBase(snapshot);
      for (const socket of ready) {
        const baseId = socket.data.ackedStateId;
        const base = socket.data.ackedBase;
        if (baseId !== undefined && base !== undefined) {
          if (!deltaMessages.has(baseId)) {
            const delta = diffWindowState(base, snapshot, currentBase);
            deltaMessages.set(
              baseId,
              JSON.stringify({ type: "state-delta", stateId: id, baseStateId: baseId, delta }),
            );
          }
        } else {
          fullMessage ??= JSON.stringify({ type: "state", stateId: id, state: snapshot });
        }
      }
    } catch (error) {
      console.error("Could not refresh task windows:", error);
      for (const socket of ready) socket.close(1011, "Could not refresh this window. Reconnecting.");
      return;
    }
    for (const socket of ready) {
      const baseId = socket.data.ackedStateId;
      const message =
        baseId !== undefined && socket.data.ackedBase !== undefined
          ? deltaMessages.get(baseId)!
          : fullMessage!;
      socket.data.dirty = false;
      socket.data.awaitingState = id;
      socket.data.pendingBase = { stateId: id, base: currentBase };
      send(socket, message);
    }
  };
  const schedule = () => {
    if (pending || !sockets.size) return;
    pending = setTimeout(() => {
      pending = undefined;
      // A slow window keeps only a dirty flag, not a queue of snapshots or serialized bodies.
      sendState([...sockets].filter((socket) => socket.readyState === 1 && socket.data.dirty && socket.data.awaitingState === undefined));
    }, 120);
  };
  const broadcast = () => {
    for (const socket of sockets) socket.data.dirty = true;
    schedule();
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
      const healthHeaders = (url.pathname === "/api/health" || url.pathname.startsWith("/api/images/")) && origin ? {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin"
      } : undefined;
      if (healthHeaders && request.method === "OPTIONS") return new Response(
        null,
        {
        status: 204,
        headers: {
        ...healthHeaders,
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Authorization"
      }
      }
      );

      if (url.pathname === "/ws") {
        // Browsers always send Origin on WebSocket handshakes: a missing one is not a browser we know.
        if (!origin) return new Response("Forbidden", { status: 403 });
        // The token travels as a subprotocol, so it never appears in a URL or a log line.
        const offered = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((entry) => entry.trim());
        const presented = offered.find((entry) => entry.startsWith("petrina.token."))?.slice("petrina.token.".length);
        if (!offered.includes("petrina.v1") || !tokenOk(presented)) return new Response("Unauthorized", { status: 401 });
        return server.upgrade(
          request,
          {
          data: {
          authed: true,
          dirty: true
        },
          headers: { "Sec-WebSocket-Protocol": "petrina.v1" }
        }
        ) ? undefined : new Response(
          "Upgrade failed",
          { status: 400 }
        );
      }

      if (url.pathname.startsWith("/api/")) {
        const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!tokenOk(bearer)) return new Response("Unauthorized", { status: 401, headers: healthHeaders });
        if (url.pathname === "/api/health" && request.method === "GET") return Response.json({ ok: true, pid: process.pid }, { headers: healthHeaders });
        if (url.pathname === "/api/state" && request.method === "GET") return Response.json(engine.windowState());
        if (url.pathname === "/api/coordinate" && request.method === "POST") {
          try {
            const { name, args } = await request.json() as { name: string; args: unknown };
            // A wait stays open for its whole requested deadline, past the ordinary idle cutoff; other
            // requests keep the server's usual behavior. Disconnecting releases the wait through its signal.
            if (typeof name === "string" && allowsLongWait(name, args)) server.timeout(
              request,
              0
            );
            return Response.json(await coordination.call(name, args, request.signal));
          } catch {
            return Response.json({
              outcome: "failed",
              message: "The coordination request could not be completed. Retry changes with their original request reference."
            });
          }
        }
        const imagePath = /^\/api\/images\/([A-Za-z0-9_-]+)\/([a-f0-9-]{36})$/.exec(url.pathname);
        if (imagePath && request.method === "GET") {
          const image = await engine.reportImage(imagePath[1]!, imagePath[2]!);
          return image ? new Response(
            image,
            { headers: {
            ...healthHeaders,
            "content-type": "image/png",
            "cache-control": "private, no-store",
            "x-content-type-options": "nosniff"
          } }
          ) : new Response(
            "Not found",
            { status: 404 }
          );
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
        sendState([socket]);
      },
      async message(socket, data) {
        let id: unknown;
        try {
          const message = JSON.parse(String(data)) as { type?: unknown; stateId?: unknown; id?: unknown; action?: unknown };
          if (message.type === "state-ack") {
            if (message.stateId === socket.data.awaitingState && typeof message.stateId === "number") {
              if (socket.data.pendingBase?.stateId === message.stateId) {
                socket.data.ackedStateId = message.stateId;
                socket.data.ackedBase = socket.data.pendingBase.base;
                delete socket.data.pendingBase;
              }
              delete socket.data.awaitingState;
              if (socket.data.dirty) schedule();
            }
            return;
          }
          id = message.id;
          const result = await dispatch(engine, message.action);
          send(socket, JSON.stringify({ type: "result", id, ok: true, result: result ?? null }));
        } catch (error) {
          send(socket, JSON.stringify({ type: "result", id, ok: false, error: error instanceof Error ? error.message : String(error) }));
        }
      },
      close(socket) {
        sockets.delete(socket);
        if (!sockets.size) {
          clearTimeout(pending);
          pending = undefined;
        }
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
