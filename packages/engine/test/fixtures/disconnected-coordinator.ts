import { createServer } from "node:net";

/** Own the actual port while deterministically disconnecting HTTP; no assumption that a machine port is unused. */
export async function disconnectedCoordinator() {
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("The private disconnected coordinator has no port"); }
  let closing: Promise<void> | undefined;
  return { api: `http://127.0.0.1:${address.port}`, url: `ws://127.0.0.1:${address.port}/ws`,
    close() { return closing ??= new Promise<void>((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close(error => error ? reject(error) : resolve());
    }); },
  };
}
