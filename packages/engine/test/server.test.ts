import { afterAll, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Engine } from "../src/engine.js";
import { serve } from "../src/server.js";
import { removeDir, tempDir } from "./support.js";

const dir = tempDir("petrina-server-");
const engine = new Engine(join(dir, "data"));
const token = randomBytes(24).toString("base64url");
const server = serve(engine, { port: 0, token });
const http = `http://127.0.0.1:${server.port}`;
const ws = `ws://127.0.0.1:${server.port}/ws`;
const OWN = "tauri://localhost";

afterAll(() => {
  server.stop(true);
  engine.shutdown();
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
