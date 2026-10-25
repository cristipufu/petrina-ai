import { afterAll, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentRun } from "../../../src/acp-run.js";
import { claudeSandbox } from "../../../src/sandbox.js";
import { ENGINE_PROFILES } from "../../../src/tools.js";
import { agentEnv } from "@petrina/platform/process-environment";
import { removeDir, tempDir } from "@petrina/test-support/fixtures";
import { nativeSession } from "../../fixtures/native-session.js";

const roots: string[] = [];
afterAll(() => roots.forEach(removeDir));
const config = () => [
  { type: "select" as const, id: "model", name: "Model", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "opus", name: "Opus 5.5" }, { value: "grok-4.7", name: "Grok 4.7" }] },
  { type: "select" as const, id: "effort", name: "Effort", currentValue: "high", options: [{ value: "high", name: "High" }] },
  { type: "select" as const, id: "mode", name: "Mode", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "auto", name: "Auto" }] },
];
const environment = () => agentEnv({ PATH: process.env.PATH, GH_TOKEN: "fixture-coordinator-login", SSH_AUTH_SOCK: "fixture-ssh-agent" });
function environmentOf(root: string) {
  const env = JSON.parse(readFileSync(join(root, ".native-environment.json"), "utf8"));
  const settings = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT ?? 0) }, (_, index) => [env[`GIT_CONFIG_KEY_${index}`], env[`GIT_CONFIG_VALUE_${index}`]]));
  return { logins: env.GH_TOKEN === "fixture-coordinator-login" && env.SSH_AUTH_SOCK === "fixture-ssh-agent" && !env.GIT_SSH_COMMAND && !env.GH_CONFIG_DIR && settings["credential.helper"] === undefined,
    quiet: env.GIT_TERMINAL_PROMPT === "0" && env.GH_PROMPT_DISABLED === "1" && env.GCM_INTERACTIVE === "never" && env.SSH_ASKPASS_REQUIRE === "never" && !env.GIT_ASKPASS && !env.SSH_ASKPASS && settings["core.askPass"] === "",
    background: env.PETRINA_AGENT === "1" && env.BROWSER === "none" };

}

for (const how of ["resume", "load"] as const) {
  it(`sandboxed sessions keep confirmed settings and token reports on new and ${how}`, async () => {
    const root = tempDir("petrina-sandbox-usage-"); roots.push(root);
    const peer = nativeSession(root, { reopen: how, config: config(), recordEnvironment: true,
      prompt: { steps: [{ update: { sessionUpdate: "usage_update", used: 100, size: 1000, _meta: { "_claude/model": "claude-opus-5-5" } } }], reply: "The protocol turn completed.",
        usage: { totalTokens: 1170, inputTokens: 100, outputTokens: 50 }, meta: { quota: { model_usage: [{ model: "claude-opus-5-5", token_count: { totalTokens: 1170 } }] } } },
    });
    const start = (session?: string) => AgentRun.start({ profile: ENGINE_PROFILES.find(profile => profile.id === "opus-high")!, command: peer.command,
      cwd: root, env: environment(), sandbox: claudeSandbox(), browser: false, signal: new AbortController().signal,
      ...(session ? { reopen: session } : {}), callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" },
    });
    let run: AgentRun | undefined;
    try {
      run = await start(); const session = run.sessionId;
      // Each peer initialization replaces its observation file; retain this start before reopening.
      const environments = [environmentOf(root)];
      for (const reopened of [false, true]) {
        if (reopened) { await run.stop(); run = await start(session); environments.push(environmentOf(root)); expect(run.reopened).toBe(how); }
        expect(run.settings).toEqual({ model: "opus", modelName: "Opus 5.5", effort: "high" });
        const result = await run.prompt("Native sandbox turn");
        expect(result.report).toMatchObject({ main: { total: 1170 }, models: [{ model: "claude-opus-5-5", counts: { total: 1170 } }] });
        expect(result.modelSeen).toBe("claude-opus-5-5");
      }
      const opens = peer.requests().filter(request => ["session/new", `session/${how}`].includes(request.method));
      expect(opens.map((request, index) => ({ session: request.params.sessionId ?? session, how: request.method.slice(8),
        sandbox: (request.params._meta?.claudeCode as { options?: { sandbox?: unknown } })?.options?.sandbox, ...environments[index],
      }))).toEqual((["new", how] as const).map(how => ({ session, how, sandbox: claudeSandbox(), logins: true, quiet: true, background: true })));
    } finally { await run?.stop(); }
  });

  it(`Grok keeps its own session metadata on new and ${how}, even when sandbox settings are supplied`, async () => {
    const root = tempDir("petrina-grok-session-"); roots.push(root);
    const peer = nativeSession(root, { reopen: how, config: config(), recordEnvironment: true });
    const start = (session?: string) => AgentRun.start({ profile: ENGINE_PROFILES.find(profile => profile.id === "grok-high")!, command: peer.command,
      cwd: root, env: environment(), sandbox: claudeSandbox(), browser: false, signal: new AbortController().signal,
      ...(session ? { reopen: session } : {}), callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => "deny" },
    });
    let run: AgentRun | undefined;
    try {
      run = await start(); const session = run.sessionId;
      const environments = [environmentOf(root)];
      await run.stop(); run = await start(session); environments.push(environmentOf(root));
      expect(run.reopened).toBe(how);
      const opens = peer.requests().filter(request => ["session/new", `session/${how}`].includes(request.method));
      expect(opens.map((request, index) => ({ session: request.params.sessionId ?? session, how: request.method.slice(8), ...request.params._meta, ...environments[index] })))
        .toEqual((["new", how] as const).map(how => ({ session, how, autoMode: true, logins: true, quiet: true, background: true })));
    } finally { await run?.stop(); }
  });
}
