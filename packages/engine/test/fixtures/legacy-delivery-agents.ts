import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";
import { acceptanceAgents } from "./acceptance-agents.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import type { World } from "../support.js";

/** Shipping/recovery runs real Git/SQLite/GitHub peers; provider transport is not the subject. */
export function legacyDeliveryAgents(world: Pick<World, "script" | "setScript">) {
  const replies = acceptanceAgents({ beforeReply(prompt) {
    const title = /^# The task: (.+)$/m.exec(prompt.text)?.[1];
    if (prompt.result === "build" && world.script().ownFiles && title)
      writeFileSync(join(prompt.cwd, `${title.toLowerCase().replace(/\W+/g, "-")}.txt`), `${title}\n`);
  } });
  const agents = new ScriptedAgents((prompt, signal) => {
    if (["build", "findings", "votes"].includes(prompt.result)) return replies.respond(prompt, signal);
    if (prompt.result === "plan") return scriptedResult({ rationale: "Build, review and deliver the requested change.", stages: [
      { kind: "do", title: "Build", roleId: "builder", profileIds: ["sol-xhigh"] },
      { kind: "review-chain", title: "Review", roleId: "code-reviewer", profileIds: ["opus-high"], maxRounds: 1 },
    ] });
    if (prompt.result === "check-discovery") return scriptedResult({ summary: "Verify the product repository.", checks: [{ name: "Version", argv: ["git", "--version"], why: "Verify Git can inspect this private repository" }] });
    if (prompt.result === "delivery") {
      world.setScript(script => { script.releaseManagerPrompts = [...(script.releaseManagerPrompts ?? []), prompt.text]; });
      return scriptedResult({ summary: "Prepared the release notes.", notes: "A greeting was added." });
    }
    throw new Error(`Unexpected legacy-delivery participant: ${prompt.result}`);
  });
  return { startAgentSession: agents.start, toolProbe: scriptedToolProbe({ "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "not-installed" }, gh: { status: "ready" }, git: { status: "ready" } }) };
}
