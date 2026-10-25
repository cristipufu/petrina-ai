import { afterAll, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { Engine } from "../../engine.js";
import { coordinator, FAKE_AGENT, FAKE_GH, taskOf, until } from "../../support.js";
import { securityWorlds } from "../../fixtures/security.js";

const { world, close } = securityWorlds();
afterAll(close);
describe.skipIf(process.platform === "win32")("Petrina's credentialed git steps trust none of the repository's own settings", () => {
it("runs a product's credentialed git steps one at a time, task-start updates included", async () => {
    const w = await world("serial");
    let open = 0;
    let most = 0;
    let total = 0;
    // GitHub standing in as a server that holds each connection a moment, then hangs up.
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          open += 1;
          total += 1;
          most = Math.max(most, open);
          setTimeout(() => socket.end(), 300);
        },
        close() {
          open -= 1;
        },
        data() {},
      },
    });
    const engine = new Engine(w.data, { agentCommand: () => [process.execPath, FAKE_AGENT], gh: [process.execPath, FAKE_GH, join(w.dir, "github.json"), w.remote], remote: `https://127.0.0.1:${server.port}/acme/demo.git` });
    try {
      const productId = await engine.addProduct(w.clone);
      engine.setPoolPaused(true);
      const tasks = [1, 2, 3].map((n) => engine.addTask({ productId, title: `Task ${n}`, description: "A greeting file. [quick]" }));
      engine.setPoolPaused(false);
      await until(engine, (state) => tasks.every((id) => taskOf(state, id).timeline.some((entry) => entry.text.startsWith("Did not update from GitHub"))), coordinator([]));
      expect(total).toBeGreaterThanOrEqual(3);
      expect(most).toBe(1);
      for (const id of tasks) engine.cancel(id);
    } finally {
      await engine.shutdown();
      server.stop(true);
    }
  });

});
