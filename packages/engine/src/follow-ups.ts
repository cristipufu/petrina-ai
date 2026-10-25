import { existsSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { FileOperations } from "@petrina/platform/file-operations";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { matchPrompt, extraSlot, limitOf, type AgentProfile, type FollowUpCredit, type Id, type MatchAnswer, type MatchAsk, type ReportImage } from "@petrina/core";
import { FollowUpLinks } from "@petrina/orchestrator";
import { AgentRun } from "@petrina/agent-runtime/acp-run";
import { agentCommandFor } from "@petrina/agent-runtime/tools";
import type { Kernel } from "./kernel.js";
import { parseResult } from "./prompts.js";
import { agentEnv } from "@petrina/platform/process-environment";
import { claudeSandbox } from "@petrina/agent-runtime/sandbox";
export { matchPrompt } from "@petrina/core";

const MatchBody = z.object({
  groups: z.array(z.object({ keys: z.array(z.string()).min(1), cardId: z.string().optional() })).default([]),
  uncertain: z.array(z.string()).optional(),
});

export class FollowUps extends FollowUpLinks {
  private readonly matchingStopped: AbortController;
  constructor(k: Kernel) {
    const stopped = new AbortController();
    super({
      current: () => k.s, task: id => k.task(id), stopped: () => k.stopped,
      hold: id => k.holdFollowUp(id), track: work => k.trackWork(work),
      id: prefix => k.id(prefix), taskIdTaken: id => k.tracking.taskIdTaken(id), now: () => Date.now(),
      checkpoint: () => k.commitNow(), changed: task => k.commit(task), saveArchived: task => k.saveArchivedTask(task),
      atomic: work => k.store.database.transaction(work)(), match: ask => answer(k, stopped.signal, ask),
      picturePresent: image => existsSync(join(k.dataDir, "captures", image.sourceTaskId, `${image.sourceImageId}.png`)),
      keepPicture: (target, image) => keepPicture(k.dataDir, target, image, k.files),
      dropCreditedPicture: (target, imageId) => unlinkSync(join(k.dataDir, "captures", target, `${imageId}.png`)),
      discardPreparedPicture: async (target, imageId) => { await rm(join(k.dataDir, "captures", target, `${imageId}.png`), { force: true }); },
    });
    this.matchingStopped = stopped;
  }
  override stop(): Promise<void> { this.matchingStopped.abort(); return super.stop(); }
}

async function answer(k: Kernel, stopped: AbortSignal, ask: MatchAsk): Promise<MatchAnswer> {
    try {
      if (k.options.matchFollowUps) return await k.options.matchFollowUps(matchPrompt(ask));
      if (k.admissionsClosed) return "unavailable";
      const profile = selectProfile(k);
      if (!profile) return "unavailable";
      return await askAgent(k, stopped, profile, matchPrompt(ask));
    } catch {
      return "unavailable";
    }
  }

function selectProfile(k: Kernel): AgentProfile | undefined {
    const ready = new Set(k.s.tools.filter((tool) => tool.status === "ready").map((tool) => tool.id));
    const open = k.s.profiles.filter((profile) => !profile.standby && extraSlot(k.activeState(), profile.toolId, profile) && !limitOf(k.s.pool, profile, Date.now()));
    // Matching different descriptions of a bug needs judgment: prefer high, with xhigh last to bound cost.
    const effort = (profile: AgentProfile) => profile.effort === "high" ? 0 : profile.effort === "medium" ? 1 : profile.effort === "low" ? 2 : 3;
    open.sort((a, b) => effort(a) - effort(b));
    return open.find((profile) => ready.has(profile.toolId)) ?? (k.options.agentCommand ? open[0] : undefined);
  }

async function askAgent(k: Kernel, stopped: AbortSignal, profile: AgentProfile, prompt: string): Promise<MatchAnswer> {
    if (k.admissionsClosed || !extraSlot(k.activeState(), profile.toolId, profile)) return "unavailable";
    const id = `follow-up-${randomUUID()}`;
    k.s.backgroundAgents ??= [];
    k.s.backgroundAgents.push({ id, roleId: "verifier", profileId: profile.id, label: "Matching older bugs", since: Date.now() });
    k.commit();
    let cwd: string | undefined;
    let run: AgentRun | undefined;
    const answerDeadline = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const parent = join(k.dataDir, "matching");
      await mkdir(parent, { recursive: true });
      cwd = await mkdtemp(join(parent, "follow-up-"));
      const command = agentCommandFor(k.options, profile);
      run = await AgentRun.start({
        profile,
        cwd,
        env: agentEnv(process.env),
        ...(profile.toolId === "claude-code" ? { sandbox: claudeSandbox() } : {}),
        ...(command ? { command } : {}),
        callbacks: { onActivity() {}, onPlanStep() {}, async onPermission() { return "deny"; } },
        signal: AbortSignal.any([stopped, answerDeadline.signal]),
        startTimeoutMs: k.options.startTimeoutMs ?? 30_000,
        browser: false,
      });
      // Startup and comparison have separate budgets; opening the tool cannot consume its thinking time.
      timer = setTimeout(() => answerDeadline.abort(), 120_000);
      const turn = await run.prompt(prompt);
      const parsed = parseResult(turn.text, MatchBody);
      if (parsed.ok !== true) return "unavailable";
      return { groups: parsed.value.groups, ...(parsed.value.uncertain ? { uncertain: parsed.value.uncertain } : {}) };
    } finally {
      clearTimeout(timer);
      await run?.stop().catch(() => undefined);
      if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      k.s.backgroundAgents = k.s.backgroundAgents.filter((agent) => agent.id !== id);
      k.commit();
      if (!k.stopped) k.schedule();
    }
  }

async function keepPicture(dataDir: string, taskId: Id, image: FollowUpCredit["images"][number], files: FileOperations): Promise<ReportImage | "failed" | undefined> {
  const from = join(dataDir, "captures", image.sourceTaskId, `${image.sourceImageId}.png`);
  if (!await Bun.file(from).exists()) return undefined;
  try {
    const id = randomUUID();
    const dir = join(dataDir, "captures", taskId);
    await mkdir(dir, { recursive: true });
    await files.copyFile(from, join(dir, `${id}.png`));
    return { id, caption: image.caption, from: { taskId: image.sourceTaskId, imageId: image.sourceImageId } };
  } catch {
    // The original is still there. The next pass copies it; the finding stays untracked until then.
    return "failed";
  }
}
