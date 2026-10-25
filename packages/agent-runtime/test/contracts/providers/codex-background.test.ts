import { afterAll, expect, it } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_FEATURES } from "../../../src/codex-background.js";
import { removeDir, tempDir, waitFor } from "@petrina/test-support/fixtures";
import { SLOW } from "@petrina/test-support/slow";

const root = tempDir("petrina-codex-background-");
afterAll(() => removeDir(root));

it("keeps Codex's message stream working past diagnostic and non-object lines, including during config reads", async () => {
  const fake = join(root, "codex.ts");
  await Bun.write(fake, `import { createInterface } from 'node:readline';
console.log('Codex is starting');
console.log('null');
console.log('42');
console.log('[]');
createInterface({input:process.stdin}).on('line', line => {
  const message=JSON.parse(line);
  if(message.method==='config/read') {
    console.log('{incomplete diagnostic');
    console.log(JSON.stringify({id:message.id,result:{config:{mcp_servers:{'personal-desktop':{command:'unused',enabled:true}}}}}));
  } else console.log(JSON.stringify({id:message.id,result:{method:message.method,params:message.params}}));
});
process.stdin.on('end',()=>process.exit(0));
`);
  // Bun itself is the stand-in executable; no new shell program or window is needed.
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../../../src/codex-background.ts"), fake], {
    cwd: root, env: { ...process.env, PETRINA_CODEX_EXECUTABLE: process.execPath }, stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true,
  });
  const responses: { id: number; result: { method: string; params?: { config?: Record<string, unknown> } } }[] = [];
  let output = "";
  const reading = (async () => {
    for await (const chunk of child.stdout) output += new TextDecoder().decode(chunk);
  })();
  const errors = new Response(child.stderr).text();
  let exited: number | undefined;
  void child.exited.then((code) => { exited = code; });
  try {
    for (const [index, method] of ["initialize", "thread/start", "thread/resume", "thread/fork"].entries()) {
      const id = index + 1;
      child.stdin.write(`${JSON.stringify({ id, method, params: { cwd: root, config: { mcp_servers: { supplied: { url: "http://127.0.0.1/browser" } } } } })}\n`);
      const response = await waitFor(() => {
        const lines = output.split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line) as typeof responses[number]);
        const found = lines.find((line) => line.id === id);
        if (found) return found;
        if (exited !== undefined) throw new Error(`The helper stopped before responding (${exited}).`);
      }, "the helper to forward the next response");
      responses.push(response);
      expect(response.result.method).toBe(method);
      if (method !== "initialize") {
        const config = response.result.params!.config!;
        expect(config.mcp_servers).toEqual({ "personal-desktop": { command: "unused", enabled: false }, supplied: { url: "http://127.0.0.1/browser", enabled: true } });
        for (const feature of BACKGROUND_FEATURES) expect(config[`features.${feature}`]).toBe(false);
      }
    }
    child.stdin.end();
    expect(await child.exited).toBe(0);
    await reading;
    const diagnostics = await errors;
    expect(diagnostics).toContain("Codex is starting");
    expect(diagnostics).toContain("{incomplete diagnostic");
    expect(diagnostics).toContain("null");
    expect(responses).toHaveLength(4);
  } finally {
    child.kill();
    await child.exited;
    await reading;
    await errors;
  }
}, 30_000 * SLOW);
