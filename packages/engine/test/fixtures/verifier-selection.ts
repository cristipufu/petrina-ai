import { type EngineCaseOwner } from "./engine-cases.js";
import { reviewRecords } from "./review-records.js";
import { scriptedToolProbe } from "../scripted-probes.js";
import { createVerifierBallots } from "../../src/verifier-host.js";
/** Actual native selection/recording composition, with no repository or agent prerequisite. */
export async function verifierSelection(owner: EngineCaseOwner, root: string, utilization: number) {
  const f = await reviewRecords(owner, root, { toolProbe: scriptedToolProbe({
      "claude-code": { status: "ready" }, codex: { status: "ready" }, grok: { status: "ready" }, antigravity: { status: "logged-out" },
      gh: { status: "unknown" }, git: { status: "ready" },
    }) }, false);
  try {
    f.engine.schedule = () => {};
    await f.engine.checkTools();
    f.engine.setPoolLimit(3);
    for (const toolId of ["claude-code", "codex", "grok", "antigravity"]) f.engine.setToolCap(toolId, 1);
    f.task.state = "running";
    f.task.hunt = { stageId: f.stage.id, round: 1, reported: { "0": true, "1": true }, profiles: { "0": "opus-high", "1": "sol-high" }, findings: 0 };
    f.task.findings.push({ id: "finding", text: "The greeting is missing on the welcome page.", severity: "blocking", raisedBy: "opus-high", confirmedBy: [], status: "open" });
    f.engine.s.pool.usage = [{ toolId: "grok", kind: "five_hour", status: "allowed", utilization, resetsAt: Date.now() + 3_600_000, at: Date.now() }];
    f.engine.setPoolPaused(false);
    return { ...f, ballots: createVerifierBallots(f.engine) };
  } catch (error) { await owner.stop(f.engine); throw error; }
}
