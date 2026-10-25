import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { serve } from "../../../src/server.js";
import { removeDir, tempDir, waitFor } from "../../fixtures.js";

let dir: string, engine: Engine, token: string, server: ReturnType<typeof serve>, http: string, ws: string;
const OWN = "tauri://localhost";
beforeEach(async () => {
  dir = tempDir("petrina-server-");
  engine = new Engine(join(dir, "data"));
  try {
    await engine.waitUntilReady();
    token = randomBytes(24).toString("base64url");
    server = serve(engine, { port: 0, token });
    http = `http://127.0.0.1:${server.port}`;
    ws = `ws://127.0.0.1:${server.port}/ws`;
  } catch (error) { await engine.shutdown(); removeDir(dir); throw error; }
});
afterEach(async () => {
  server?.stop(true);
  await engine?.shutdown();
  removeDir(dir);
});

/** Try a WebSocket the way the window does: the key as a subprotocol, sent when the connection opens. */
function connect(url: string, protocols: string[], origin?: string): Promise<"open" | "refused"> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { protocols, headers: origin ? { origin } : {} } as unknown as string[]);
    socket.onopen = () => {
      socket.close();
      resolve("open");
    };
    socket.onerror = () => resolve("refused");
  });
}

/** The status a handshake gets, without upgrading. */
const status = (path: string, headers: Record<string, string>) => fetch(`${http}${path}`, { headers }).then((response) => response.status);

it("closes a window cleanly after a failed timed snapshot and serves a fresh snapshot on reconnect", async () => {
  let socket: WebSocket | undefined;
  const states: number[] = [];
  const open = () => {
    const client = new WebSocket(ws, { protocols: ["petrina.v1", `petrina.token.${token}`], headers: { origin: OWN } } as unknown as string[]);
    client.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.type === "state") { states.push(message.stateId); client.send(JSON.stringify({ type: "state-ack", stateId: message.stateId })); }
    };
    return client;
  };
  const log = spyOn(console, "error").mockImplementation(() => {});
  const snapshot = spyOn(engine, "windowState");
  try {
    socket = open(); await waitFor(() => states.length === 1, "the first live snapshot");
    let closed: number | undefined; socket.onclose = event => { closed = event.code; };
    snapshot.mockImplementationOnce(() => { throw new Error("Snapshot unavailable"); });
    engine.commit();
    await waitFor(() => closed !== undefined, "the timed snapshot failure to close its socket");
    expect(closed).toBe(1011);
    expect(log).toHaveBeenCalledWith("Could not refresh task windows:", expect.objectContaining({ message: "Snapshot unavailable" }));
    socket = open(); await waitFor(() => states.length === 2, "a recovered snapshot");
    expect(states[1]).toBeGreaterThan(states[0]!);
  } finally { socket?.close(); snapshot.mockRestore(); log.mockRestore(); }
});

describe("the engine's key checks", () => {
  it("lets only Petrina's browser pages read whether their health-check key was refused", async () => {
    const origin = "http://127.0.0.1:1430";
    const preflight = await fetch(`${http}/api/health`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    const refused = await fetch(`${http}/api/health`, { headers: { origin, authorization: "Bearer an-old-key" } });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("access-control-allow-origin")).toBe(origin);
    expect(await status("/api/health", { origin: "https://example.com" })).toBe(403);
    const state = await fetch(`${http}/api/state`, { headers: { origin, authorization: `Bearer ${token}` } });
    expect(state.headers.get("access-control-allow-origin")).toBeNull();
  });
  it("lets Petrina's own window in with the key in the connection", async () => {
    expect(await connect(ws, ["petrina.v1", `petrina.token.${token}`], OWN)).toBe("open");
    expect(await connect(ws, ["petrina.v1", `petrina.token.${token}`], `http://127.0.0.1:${server.port}`)).toBe("open");
  });

  it("refuses the key in the address, even the right key", async () => {
    expect(await connect(`${ws}?token=${token}`, ["petrina.v1", `petrina.token.${token}`], OWN)).toBe("refused");
    expect(await status(`/ws?token=${token}`, { origin: OWN, "sec-websocket-protocol": `petrina.v1, petrina.token.${token}` })).toBe(400);
    expect(await status(`/api/state?key=${token}`, { authorization: `Bearer ${token}` })).toBe(400);
    expect(await status(`/${token}`, {})).toBe(400);
  });

  it("refuses a wrong or missing key", async () => {
    expect(await connect(ws, ["petrina.v1", "petrina.token.not-the-key-at-all-000"], OWN)).toBe("refused");
    expect(await connect(ws, ["petrina.v1"], OWN)).toBe("refused");
    expect(await status("/ws", { origin: OWN, "sec-websocket-protocol": "petrina.v1, petrina.token.wrong" })).toBe(401);
    expect(await status("/api/state", { authorization: "Bearer wrong" })).toBe(401);
    expect(await status("/api/health", {})).toBe(401);
  });

  it("refuses a page that is not one of Petrina's own, and a connection from no page at all", async () => {
    expect(await connect(ws, ["petrina.v1", `petrina.token.${token}`], "https://example.com")).toBe("refused");
    expect(await connect(ws, ["petrina.v1", `petrina.token.${token}`])).toBe("refused");
    expect(await status("/ws", { origin: "http://localhost:3000", "sec-websocket-protocol": `petrina.v1, petrina.token.${token}` })).toBe(403);
    expect(await status("/ws", { "sec-websocket-protocol": `petrina.v1, petrina.token.${token}` })).toBe(403);
  });

  it("answers its health check only with the key", async () => {
    const response = await fetch(`${http}/api/health`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
  });

  it("serves no page with the key in it", async () => {
    expect(await (await fetch(`${http}/`)).text()).not.toContain(token);
  });
});
