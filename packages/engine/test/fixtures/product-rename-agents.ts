import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { ReleaseEvents } from "../release-events.js";
import { scriptedToolProbe } from "../scripted-probes.js";

/** A held planner and the next real prompt, with no unrelated ACP or account setup. */
export function productRenameAgents() {
  const release = new ReleaseEvents();
  const agents = new ScriptedAgents(async (prompt, signal) => {
    if (prompt.result === "plan") {
      await release.wait(prompt.sessionId, signal);
      return scriptedResult({ rationale: "Research the request, then build it.", stages: [
        { kind: "do", title: "Research", roleId: "researcher", profileIds: ["sol-high"] },
        { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
        { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
      ] });
    }
    if (prompt.result !== "notes") throw new Error(`Unexpected product-rename participant: ${prompt.result}`);
    await release.wait(`finish-${prompt.sessionId}`, signal);
    return scriptedResult({ summary: "Read the current product display name.", notes: [] });
  });
  const received = (role: string) => agents.received().filter(prompt => prompt.roleId === role).map(prompt => ({ ...prompt, session: prompt.sessionId }));
  return { startAgentSession: agents.start, toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "not-installed" }, gh: { status: "ready" }, git: { status: "ready" } }),
    release: (session: string) => release.release(session), received, prompts: (role: string) => received(role).map(prompt => prompt.text),
  };
}
