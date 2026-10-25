import { expect, it } from "bun:test";
import { closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { FAKE_AGENT, Fakes, removeDir, tempDir } from "../../fixtures.js";
import { type PromptRecord } from "../../prompt-records.js";

function writer(root: string, records: PromptRecord[], hold: "partial" | "published") {
  const id = crypto.randomUUID(), script = join(root, `${id}.ts`);
  writeFileSync(script, `
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
    import { recordPrompt } from ${JSON.stringify(join(import.meta.dir, "../../prompt-records.ts"))};
    const [dir, input, hold] = process.argv.slice(2);
    const release = () => new Promise(resolve => process.stdin.once("data", () => { process.stdin.pause(); resolve(); }));
    let first = true;
    for (const record of JSON.parse(readFileSync(input, "utf8"))) {
      await recordPrompt(dir, record, async (path, text) => {
        if (hold === "partial" && first) {
          const bytes = Buffer.from(text), middle = bytes.indexOf(Buffer.from("🧩"), Math.floor(bytes.length / 2)) + 1;
          writeFileSync(path, bytes.subarray(0, middle));
          console.log("partial");
          await release();
          appendFileSync(path, bytes.subarray(middle));
        } else writeFileSync(path, text);
      });
      first = false;
    }
    if (hold === "published") { console.log("published"); await release(); }
  `);
  const input = join(root, `${id}.json`);
  writeFileSync(input, JSON.stringify(records));
  const child = Bun.spawn([process.execPath, script, root, input, hold], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const errors = new Response(child.stderr).text();
  return { child, errors };
}

async function stop(processes: ReturnType<typeof writer>[]) {
  for (const { child } of processes) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(processes.map(({ child }) => child.exited));
}

const prompt = (session: string, text: string, role = "code reviewer"): PromptRecord => ({ role, session, text });

const large = "🧩 café 漢字 \"quoted\"\n".repeat(40_000);

it("records large prompts from simultaneous fake agents with their original conversations and turn order", async () => {
  const root = tempDir("petrina-prompt-agents-");
  const fakes = new Fakes(root), processes: ReturnType<typeof writer>[] = [];
  const saved = new Map<string, { file: number; state: unknown }>();
  try {
    const participants = await Promise.all(Array.from({ length: 3 }, async (_, index) => {
      const child = Bun.spawn([process.execPath, FAKE_AGENT, root], { stdin: "pipe", stdout: "pipe", stderr: "pipe", windowsHide: true });
      processes.push({ child, errors: new Response(child.stderr).text() });
      const output = new WritableStream<Uint8Array>({ async write(chunk) { child.stdin.write(chunk); await child.stdin.flush(); }, close() { child.stdin.end(); } });
      const client = new acp.ClientSideConnection(() => ({ async sessionUpdate() {}, async requestPermission() { return { outcome: { outcome: "cancelled" } }; } }), acp.ndJsonStream(output, child.stdout));
      await client.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const { sessionId } = await client.newSession({ cwd: root, mcpServers: [] });
      const text = `You are the Code Reviewer in Petrina. Participant ${index}.\n${large}`;
      return { client, child, sessionId, texts: [text, `Next turn for ${index}.\n${large}`] };
    }));
    for (let turn = 0; turn < 2; turn += 1) {
      await Promise.all(participants.map(({ client, sessionId, texts }) => client.prompt({ sessionId, prompt: [{ type: "text", text: texts[turn]! }] })));
      expect(fakes.received()).toHaveLength(participants.length * (turn + 1));
      for (const { sessionId, texts } of participants) expect(fakes.received().filter((entry) => entry.session === sessionId)).toEqual(texts.slice(0, turn + 1).map((text) => prompt(sessionId, text)));
      for (const { sessionId } of participants) {
        const path = join(root, "conversations", `${sessionId}.json`);
        if (turn === 0) saved.set(sessionId, { file: openSync(path, "r"), state: JSON.parse(readFileSync(path, "utf8")) });
        else {
          const earlier = saved.get(sessionId)!;
          expect(JSON.parse(readFileSync(earlier.file, "utf8"))).toEqual(earlier.state);
          expect(JSON.parse(readFileSync(path, "utf8"))).not.toEqual(earlier.state);
        }
      }
    }
    for (const { child } of participants) child.stdin.end();
    expect(await Promise.all(processes.map(({ child }) => child.exited))).toEqual([0, 0, 0]);
    expect(await Promise.all(processes.map(({ errors }) => errors))).toEqual(["", "", ""]);
    expect(fakes.opens().map((entry) => entry.session).sort()).toEqual(participants.map((entry) => entry.sessionId).sort());
  } finally {
    for (const { file } of saved.values()) closeSync(file);
    await stop(processes);
    removeDir(root);
  }
});
