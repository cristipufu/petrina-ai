import { createServer, type Socket } from "node:net";
import { SLOW } from "../slow.js";

/** An out-of-band lifetime for fixture actors, independent of the cleanup being tested. */
export interface ProcessLease {
  /** No actor body runs before its owner answers. Losing that connection ends the actor. */
  program(body: string): string;
  /** Refuse late actors and disconnect existing actors; safe to call more than once. */
  close(): Promise<void>;
}

/**
 * A private loopback connection survives reparenting and detached process groups. When a case fails,
 * closing the lease ends its actors; when a worker dies, the OS closes its connections instead.
 * No PID is signalled and no lifetime timer can masquerade as the subject's successful cleanup.
 * Actors must use this wrapper before starting children; wrap each long-lived child as well.
 */
export async function createProcessLease(): Promise<ProcessLease> {
  const token = crypto.randomUUID(), sockets = new Set<Socket>();
  let closed = false, closing: Promise<void> | undefined;
  const server = createServer(socket => {
    if (closed) { socket.destroy(); return; }
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    let input = "";
    socket.on("data", chunk => {
      input += chunk.toString("utf8");
      if (input === `${token}\n`) socket.write(input);
      else if (input.length >= token.length + 1 || !`${token}\n`.startsWith(input)) socket.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error) => { server.close(); reject(error); };
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => { server.off("error", failed); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("The fixture process owner has no loopback address"); }
  const port = address.port;
  return {
    program(body) {
      return `await (async () => {
  const { createConnection } = require("node:net");
  const connection = createConnection({ host: "127.0.0.1", port: ${port} });
  const ended = () => process.exit(78);
  connection.on("error", ended);
  connection.on("end", ended);
  connection.on("close", ended);
  await new Promise(resolve => {
    const timeout = setTimeout(ended, ${30_000 * SLOW});
    let answer = "";
    connection.once("connect", () => connection.write(${JSON.stringify(`${token}\n`)}));
    connection.on("data", chunk => {
      answer += chunk.toString("utf8");
      if (answer === ${JSON.stringify(`${token}\n`)}) { clearTimeout(timeout); resolve(); }
      else if (answer.length >= ${token.length + 1} || !${JSON.stringify(`${token}\n`)}.startsWith(answer)) ended();
    });
  });
  await (async () => { ${body}\n})();
  process.exit(0);
})();`;
    },
    close() {
      return closing ??= new Promise<void>((resolve, reject) => {
        closed = true;
        for (const socket of sockets) socket.destroy();
        server.close(error => error ? reject(error) : resolve());
      });
    },
  };
}
