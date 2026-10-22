import { Database } from "bun:sqlite";
import { afterAll, expect, it } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../src/store.js";
import { removeDir, SLOW, tempDir, waitFor } from "./fixtures.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));

for (const releases of [true, false]) it(`database startup ${releases ? "waits for a short competing lock" : "reports a lock that outlasts its allowance and can then recover"}`, async () => {
  const root = tempDir("petrina-store-startup-"); roots.push(root);
  const file = join(root, "petrina.db"), marker = join(root, "opening"), wrapper = join(root, "open.ts");
  const seed = new Store(file);
  seed.database.run("CREATE TABLE saved_work (text TEXT NOT NULL)");
  seed.database.run("INSERT INTO saved_work VALUES ('Saved before interruption')");
  seed.close();
  const blocker = new Database(file);
  blocker.run("PRAGMA locking_mode = EXCLUSIVE");
  blocker.run("BEGIN EXCLUSIVE");
  writeFileSync(wrapper, `
import { writeFileSync } from "node:fs";
import { Store } from ${JSON.stringify(join(import.meta.dir, "../src/store.ts"))};
writeFileSync(${JSON.stringify(marker)}, "opening");
const started = performance.now();
try {
  const store = new Store(${JSON.stringify(file)});
  const saved = store.database.query("SELECT text FROM saved_work").get();
  store.close();
  console.log(JSON.stringify({ outcome: "completed", saved }));
} catch (error) {
  console.log(JSON.stringify({ outcome: "failed", message: String(error), elapsed: performance.now() - started }));
  process.exitCode = 1;
}
`);
  const child = Bun.spawn([process.execPath, wrapper], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let blocked = true;
  try {
    await waitFor(() => existsSync(marker), "the competing database open to begin");
    if (releases) {
      // Real time checks that SQLite waits rather than immediately failing startup. The
      // other process owns the wait, so releasing this connection cannot deadlock it.
      expect(await Promise.race([child.exited.then(() => "exited"), Bun.sleep(100).then(() => "waiting")])).toBe("waiting");
      blocker.run("ROLLBACK"); blocked = false;
      blocker.close();
    }
    expect(await child.exited).toBe(releases ? 0 : 1);
    expect(await new Response(child.stderr).text()).toBe("");
    const result = JSON.parse(await new Response(child.stdout).text());
    if (releases) expect(result).toEqual({ outcome: "completed", saved: { text: "Saved before interruption" } });
    else {
      expect(result).toMatchObject({ outcome: "failed", message: expect.stringContaining("locked") });
      expect(result.elapsed).toBeGreaterThanOrEqual(2800);
      expect(result.elapsed).toBeLessThan(10000 * SLOW);
      blocker.run("ROLLBACK"); blocked = false;
      blocker.close();
    }
    const recovered = new Store(file);
    try { expect(recovered.database.query("SELECT text FROM saved_work").get()).toEqual({ text: "Saved before interruption" }); }
    finally { recovered.close(); }
  } finally {
    child.kill("SIGKILL"); await child.exited;
    if (blocked) { blocker.run("ROLLBACK"); blocker.close(); }
  }
});
