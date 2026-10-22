import { expect, it } from "bun:test";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { FAKE_AGENT, Fakes, firstLine, removeDir, tempDir } from "./fixtures.js";
import { recordPrompt, type PromptRecord } from "./prompt-records.js";
import { expectRejection } from "./rejections.js";

// Split a real subprocess's write inside a UTF-8 character, then wait for an explicit release.
// This uses the same publisher as the fake agents, without unrelated planning, Git or engine work.
function writer(root: string, records: PromptRecord[], hold: "partial" | "published") {
  const id = crypto.randomUUID(), script = join(root, `${id}.ts`);
  writeFileSync(script, `
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
    import { recordPrompt } from ${JSON.stringify(join(import.meta.dir, "prompt-records.ts"))};
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
    }
    for (const { child } of participants) child.stdin.end();
    expect(await Promise.all(processes.map(({ child }) => child.exited))).toEqual([0, 0, 0]);
    expect(await Promise.all(processes.map(({ errors }) => errors))).toEqual(["", "", ""]);
    expect(fakes.opens().map((entry) => entry.session).sort()).toEqual(participants.map((entry) => entry.sessionId).sort());
  } finally {
    await stop(processes);
    removeDir(root);
  }
});

it("keeps complete prompt evidence in publication order while several large writes are in progress", async () => {
  const root = tempDir("petrina-prompt-concurrent-");
  const fakes = new Fakes(root);
  const processes: ReturnType<typeof writer>[] = [];
  try {
    expect(fakes.received()).toEqual([]);
    expect(fakes.prompts()).toEqual([]);
    const first = prompt("earlier", "You are the Code Reviewer in Petrina. Earlier prompt.");
    await recordPrompt(root, first);
    // Identical turns are still two accepted prompts, even in the same conversation.
    const records = ["one", "two", "three"].map((session) => [prompt(session, `${session}: ${large}`), prompt(session, `${session} continued: ${large}`), prompt(session, `${session} continued: ${large}`)]);
    processes.push(...records.map((entries) => writer(root, entries, "partial")));
    expect(await Promise.all(processes.map(({ child }) => firstLine(child.stdout)))).toEqual(["partial", "partial", "partial"]);
    const pending = readdirSync(join(root, "prompts")).filter((name) => name.startsWith(".pending-"));
    expect(pending).toHaveLength(3);
    for (const name of pending) expect(() => JSON.parse(readFileSync(join(root, "prompts", name, "prompt.json"), "utf8"))).toThrow(SyntaxError);
    expect(fakes.received()).toEqual([first]);
    expect(fakes.prompts("code reviewer")).toEqual([first.text]);

    // All held writers chose this sequence too. None may overwrite it on release.
    const overtaking = prompt("builder", "A complete prompt while the others are writing.", "builder");
    await recordPrompt(root, overtaking);
    expect(fakes.received()).toEqual([first, overtaking]);
    expect(fakes.prompts("builder")).toEqual([overtaking.text]);
    for (const { child } of processes) { child.stdin.write("go"); child.stdin.flush(); }
    expect(await Promise.all(processes.map(({ child }) => child.exited))).toEqual([0, 0, 0]);
    expect(await Promise.all(processes.map(({ errors }) => errors))).toEqual(["", "", ""]);

    const received = fakes.received();
    expect(received.slice(0, 2)).toEqual([first, overtaking]);
    expect(received).toHaveLength(11);
    for (const entries of records) expect(received.filter((entry) => entry.session === entries[0]!.session)).toEqual(entries);
    expect(fakes.received("code reviewer")).toEqual(received.filter((entry) => entry.role === "code reviewer"));
    expect(fakes.prompts()).toEqual(received.map((entry) => entry.text));
    expect(fakes.openings("code reviewer")).toEqual([first.text]);
    expect(new Fakes(root).received()).toEqual(received);
    expect(readdirSync(join(root, "prompts")).map(Number).sort((a, b) => a - b)).toEqual(Array.from({ length: 11 }, (_, index) => index + 1));
  } finally {
    await stop(processes);
    removeDir(root);
  }
});

for (const hold of ["partial", "published"] as const) it(`retains published prompts and admits new writers after interrupting a ${hold} writer`, async () => {
  const root = tempDir("petrina-prompt-interrupted-");
  const fakes = new Fakes(root);
  const processes: ReturnType<typeof writer>[] = [];
  try {
    const before = prompt("earlier", "Earlier evidence");
    await recordPrompt(root, before);
    const interrupted = prompt("interrupted", `🧩 ${large}`);
    const process = writer(root, [interrupted], hold); processes.push(process);
    expect(await firstLine(process.child.stdout)).toBe(hold);
    const accepted = hold === "published" ? [before, interrupted] : [before];
    expect(fakes.received()).toEqual(accepted);
    process.child.kill("SIGKILL"); await process.child.exited;
    const after = prompt("later", "Evidence after interruption");
    await recordPrompt(root, after);
    expect(fakes.received()).toEqual([...accepted, after]);
    expect(fakes.prompts()).toEqual([...accepted, after].map((entry) => entry.text));
    expect(readdirSync(join(root, "prompts")).filter((name) => name.startsWith(".pending-"))).toHaveLength(hold === "partial" ? 1 : 0);
  } finally {
    await stop(processes);
    removeDir(root);
  }
  expect(existsSync(root)).toBe(false);
});

it("cleans a failed write without losing earlier evidence or reserving a sequence", async () => {
  const root = tempDir("petrina-prompt-failed-");
  try {
    const fakes = new Fakes(root), before = prompt("before", "Complete first record"), after = prompt("after", "Complete next record");
    await recordPrompt(root, before);
    await expectRejection(recordPrompt(root, prompt("failed", large), (path) => {
      writeFileSync(path, '{"text":"unfinished');
      throw new Error("Write interrupted");
    }), "Write interrupted");
    await expectRejection(recordPrompt(root, prompt("unpublished", large), (path, text) => {
      writeFileSync(path, text);
      rmSync(dirname(path), { recursive: true });
    }), "ENOENT");
    await recordPrompt(root, after);
    expect(fakes.received()).toEqual([before, after]);
    expect(readdirSync(join(root, "prompts")).sort()).toEqual(["1", "2"]);
  } finally { removeDir(root); }
});

it("surfaces malformed completed records through every prompt reader, including a different role filter", async () => {
  const root = tempDir("petrina-prompt-malformed-");
  try {
    const fakes = new Fakes(root);
    await recordPrompt(root, prompt("valid", "Complete earlier record"));
    await recordPrompt(root, prompt("malformed", large), (path) => writeFileSync(path, '{"text":"unfinished'));
    await recordPrompt(root, prompt("later", "Complete later record"));
    for (const read of [() => fakes.received(), () => fakes.received("builder"), () => fakes.prompts(), () => fakes.prompts("builder"), () => fakes.openings("builder")]) expect(read).toThrow(SyntaxError);
  } finally { removeDir(root); }
});
