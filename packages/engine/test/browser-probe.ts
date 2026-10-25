// Manual acceptance check; real logged-in agents, local page, invisible browsers only.
// bun packages/engine/test/browser-probe.ts <claude-code|codex> <output folder>
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { preserveCaptures } from "@petrina/agent-runtime/captures";
import { browserPrompt, parseResult, repairPrompt } from "../src/prompts.js";
import { BuildResult } from "../src/roles.js";
import { claudeSandbox } from "@petrina/agent-runtime/sandbox";

const [toolId = "claude-code", output = "/private/tmp/petrina-browser-verification"] = process.argv.slice(2);
const root = resolve(output);
const cwd = join(root, `${toolId}-product`);
await mkdir(cwd, { recursive: true });
await mkdir(join(cwd, ".codex"), { recursive: true });
await mkdir(join(cwd, ".claude"), { recursive: true });
// Harmless inherited desktop/browser connection. Starting it leaves a marker, never a window.
const marker = join(root, `${toolId}-personal-started`);
const standin = join(root, "personal-standin.ts");
await writeFile(standin, `await Bun.write(${JSON.stringify(marker)}, "started"); process.stdin.resume();`);
await writeFile(join(cwd, ".mcp.json"), JSON.stringify({ mcpServers: { "personal-desktop": { command: process.execPath, args: [standin] } } }));
await writeFile(join(cwd, ".claude/settings.json"), JSON.stringify({ enableAllProjectMcpServers: true, enabledPlugins: { "computer-use@personal": true } }));
await writeFile(join(cwd, ".codex/config.toml"), `[features]\ncomputer_use=true\nbrowser_use=true\nplugins=true\n[mcp_servers.personal-desktop]\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(standin)}]\n`);
let clicked = false;
const page = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  if (new URL(request.url).pathname === "/clicked") { clicked = true; return new Response("ok"); }
  return new Response(`<!doctype html><title>Petrina browser check</title><style>body{font:24px system-ui;padding:60px}input,button{font:inherit;padding:12px;margin:12px}</style><h1>Background browser check</h1><label>Name <input aria-label="Name"></label><button onclick="document.querySelector('p').textContent='Checked: '+document.querySelector('input').value;console.log('Petrina console check passed');fetch('/clicked')">Check</button><p>Waiting for the check</p>`, { headers: { "content-type": "text/html" } });
} });
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 180_000);
let run: AgentRun | undefined;
let logs = "";
try {
  run = await AgentRun.start({
    profile: { id: "browser-check", toolId, model: toolId === "codex" ? "sol" : "Opus 5.5", modelId: toolId === "codex" ? "gpt-6.1-sol" : "opus", effort: "high" },
    cwd, signal: controller.signal, browserRoot: join(root, "temporary"),
    ...(toolId === "claude-code" ? { sandbox: claudeSandbox() } : {}),
    env: { ...process.env, DEBUG: "pw:browser", BROWSER: "none", CLAUDE_CODE_CHROME_ENABLED: "1" },
    callbacks: { onActivity: (text) => console.log(text), onPlanStep: (text) => console.log(text), onPermission: async () => "deny", onLog: (text) => { logs += text; } },
  });
  const catalog = await run.prompt("/mcp");
  await writeFile(join(root, `${toolId}-connections.txt`), catalog.text);
  console.log("Connection report:", catalog.text.slice(0, 3000));
  let result = await run.prompt(`Use only the supplied Playwright browser tools to check http://127.0.0.1:${page.port}. Open the page, type Petrina into Name, click Check, read the browser console and verify the message Petrina console check passed. Take a screenshot named checked.png. Do not use shell, computer use, or any other browser. Report incomplete checks honestly. Also say whether Claude in Chrome or any computer/desktop-control tools are offered to you. End with a fenced petrina JSON block containing summary (string), changes (array of strings), tests (one string) and images (array with path and caption). ${browserPrompt(run.browser!.directory)}`);
  let parsed = parseResult(result.text, BuildResult);
  for (let repairs = 0; parsed.ok === false && repairs < 2; repairs++) {
    result = await run.prompt(repairPrompt(parsed.error));
    parsed = parseResult(result.text, BuildResult);
  }
  await writeFile(join(root, `${toolId}-report.txt`), result.text);
  const saved = parsed.ok === true ? await preserveCaptures(run.browser!.directory, join(root, toolId), parsed.value.images ?? []) : [];
  const evidence = { toolId, clicked, saved, headlessLaunchRecorded: /<launching>.*--headless/.test(logs), inheritedStandinStarted: await Bun.file(marker).exists(), report: result.text, browserOutputs: await readdir(run.browser!.directory) };
  await writeFile(join(root, `${toolId}-result.json`), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  if (!clicked || !saved.length || !evidence.headlessLaunchRecorded || evidence.inheritedStandinStarted) process.exitCode = 1;
} catch (error) {
  const incomplete = { toolId, incomplete: true, clicked, reason: error instanceof Error ? error.message : String(error), detail: (error as { data?: unknown }).data };
  await writeFile(join(root, `${toolId}-debug.txt`), logs);
  await writeFile(join(root, `${toolId}-result.json`), JSON.stringify(incomplete, null, 2));
  console.log(JSON.stringify(incomplete, null, 2));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await run?.stop();
  page.stop(true);
  // Keep only the result and chosen picture; browser output and profiles are gone.
  if (run) console.log("Temporary browser removed:", !(await Bun.file(join(run.browser!.directory, "checked.png")).exists()));
}
