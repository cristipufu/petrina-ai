import { createHash } from "node:crypto";
import { FixtureOperations } from "@petrina/test-support/fixture-operations";
import { beginAgentStep, currentStepAssignment, openStep, recordAgentResult, stepKey, type AgentProfile, type BuilderContext, type ConversationNote, type Id, type Role } from "@petrina/core";
import { ParticipantInputs, ReopenFailed, openParticipantSession, repositoryView, type RepositoryContext, type AgentSession, type InputSection } from "@petrina/orchestrator";
import { ContextInput as Context, type ContextHost, type Section } from "../../src/context-input.js";
import { builderContextInput as builderContext, type ContextPacketStorage } from "../../src/builder-context-input.js";
import { buildPrompt, continuePrompt, ownCopy, OWN_COPY, parseResult } from "../../src/prompts.js";
import { contractFor } from "../../src/roles.js";
import { inputManifest, numberInputManifest } from "../../src/input-manifest.js";
import { verificationContextInput } from "../../src/verification-context-input.js";
import { assignedCheckFailures } from "@petrina/core";
import { ScriptedAgents, scriptedResult } from "../scripted-agents.js";

export class UnavailableInputParticipant extends Error {}

/** Actual Context/prompt/input producers with private in-memory storage and actual scripted sessions. No Engine, Git, SQL or native session facts. */
export function participantInputFixture(host: ContextHost, now: () => number, scripted?: ScriptedAgents) {
  const controller = new AbortController(), packets = new Map<string, string>(), exact = new Map<string, string>();
  const starts: { profileId: Id; reopen?: string; sessionId?: string }[] = [];
  const announcements: { roleId: Id; profileId: Id }[] = [];
  const statuses: { roleId: Id; profileId: Id; text: string }[] = [];
  const checkpointed: RepositoryContext[] = [];
  const active = new Set<AgentSession>();
  const missingSessions = new Set<string>();
  const failures = new Map<Id, Error>();
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  const storage: ContextPacketStorage = {
    root: (_dir, taskId) => `scripted:contexts/${taskId}`,
    contains: (root, file) => file.startsWith(root + "/") && !file.slice(root.length + 1).includes("/"),
    async read(file) { const text = packets.get(file); if (text === undefined) throw new Error("The scripted context is unavailable"); return text; },
    async save(root, text) { const digest = hash(text), file = `${root}/${digest}.md`; packets.set(file, text); return { file, digest }; },
  };
  const agents = scripted ?? new ScriptedAgents(({ result }) => {
    if (result !== "findings") throw new Error(`Unexpected participant input result: ${result}`);
    return scriptedResult({ verdict: "pass", findings: [], confirms: [], disputes: [] });
  });
  const operations = new FixtureOperations({
    label: "participant input", allowanceMs: 5000,
    arm: (fire, ms) => { const timer = setTimeout(fire, ms); return () => clearTimeout(timer); },
    stop: async () => { controller.abort(); await Promise.all([...active].map(run => run.stop())); },
    dispose: () => { packets.clear(); exact.clear(); },
  });
  const context = new Context(host, { pendingPoints: async () => [] }, {
    checksFor(product) {
      if (product.checksSeen?.length && product.checksBy !== "coordinator") throw new Error("No check fingerprint observation is declared");
      return product.checks ?? [];
    },
    readReviewHistory: async () => { throw new Error("No compact review-history read is declared"); },
    currentSourcePointers: async (_task, pointers) => { if (pointers.length) throw new Error("No source-pointer observation is declared"); return []; },
    verificationContext: (dir, task, versions) => verificationContextInput(dir, task, versions, {
      async saveIndex(_dir, taskId, body, digest) { const file = `scripted:verification/${taskId}/${digest}.json`; packets.set(file, body); return file; },
    }),
    relatedCheckEvidence: async (_host, bound) => { if (assignedCheckFailures(bound).length) throw new Error("No related-check lookup is declared"); return []; },
    treeOf: async () => { throw new Error("No live tree observation is declared"); },
  });
  const inputs = new ParticipantInputs({ now, current: scope => host.s.tasks.includes(scope.task), stopped: () => controller.signal.aborted,
    status: (_scope, text, roleId, profileId) => { statuses.push({ text, roleId, profileId }); },
    checkpoint: scope => { checkpointed.push(scope); }, commit: scope => { checkpointed.push(scope); }, noteStream: () => {},
    say: () => { throw new Error("No streamed public message is declared by this input fixture"); }, briefed: () => {},
  }, { clone: structuredClone, manifest: inputManifest, numberManifest: numberInputManifest,
    async saveExact(taskId, text) { const digest = hash(text), file = `scripted:messages/${taskId}/${digest}.md`; exact.set(file, text); return { file, digest, size: text.length }; },
  });

  async function send(scope: RepositoryContext, role: Role, profile: AgentProfile, plannedId: Id, options: {
    reviewerKey?: string; selectionReason?: string; freshReason?: string; designContext?: boolean;
    resume?: (profile: AgentProfile, role: Role) => Promise<{ sessionId: string; reselect?: boolean; context?: BuilderContext; continuedSections?: readonly InputSection[]; knownSections?: readonly string[] } | undefined>;
    started?(): void; completed?(note: ConversationNote, profile: AgentProfile, role: Role): void;
    given?: () => Promise<Section[]>;
  } = {}) {
    const { task, work } = scope;
    const group = openStep(task), team = group?.kind === "agent" && group.roleId === role.id ? group.team ?? (group.profileId ? [group.profileId] : []) : [];
    const step = beginAgentStep(task, role.id, profile.id, now(), host.s.roles, [...new Set([...team, profile.id])], work);
    const offered = await options.resume?.(profile, role);
    const opened = await openParticipantSession({ sessionId: offered?.sessionId, reselect: offered?.reselect }, {
      aborted: () => controller.signal.aborted,
      announce: () => { announcements.push({ roleId: role.id, profileId: profile.id }); },
      unavailable: reason => new UnavailableInputParticipant(reason),
      stop: async run => { await run.stop(); },
      async start(reopen) {
        const observation = { profileId: profile.id, ...(reopen ? { reopen } : {}) }; starts.push(observation);
        if (reopen && missingSessions.has(reopen)) throw new ReopenFailed("The tool could not reopen the conversation: the scripted conversation was removed");
        const failure = failures.get(profile.id); if (failure) throw failure;
        const run = await agents.start({ profile, cwd: work.worktree ?? "scripted:product", signal: controller.signal, ...(reopen ? { reopen } : {}),
          callbacks: { onActivity() {}, onPlanStep() {}, onPermission: async () => { throw new Error("Unexpected permission"); } },
        }, role);
        active.add(run); Object.assign(observation, { sessionId: run.sessionId }); return { run };
      },
    });
    const { run } = opened;
    try {
      options.started?.();
      const wentBack = offered !== undefined && run.reopened !== undefined;
      const sections = [...currentStepAssignment(task, role.id), ...await (options.given?.() ?? context.sectionsFor(scope, role.id, options.reviewerKey)), ...(wentBack ? offered?.continuedSections ?? [] : []), { title: OWN_COPY, body: ownCopy("") }];
      const note: ConversationNote = { step: stepKey(task), roleId: role.id, profileId: profile.id, role, access: { canEdit: role.canEdit }, toolId: profile.toolId, model: profile.modelId ?? profile.model, sessionId: run.sessionId, startedAt: now(), briefed: true };
      const prepared = await inputs.prepare(scope, { packet: true, note, previous: wentBack ? offered?.context : undefined, sections, supplyHistory: false,
        prepare: () => builderContext(host.dataDir, repositoryView(scope), role, run.sessionId, sections, wentBack ? offered?.context : undefined, { design: options.designContext, knownSections: wentBack ? offered?.knownSections : undefined }, storage),
        history: async () => { throw new Error("No compact history is declared"); },
      });
      const promptContext = { task: repositoryView(scope), product: host.productOf(scope)!, role, roles: host.s.roles, profiles: [] as AgentProfile[], tools: [],
        worktree: work.worktree ?? "scripted:product", branch: work.branch ?? "main", base: work.baseSha ?? work.base ?? "", defaultBranch: "main", sections: prepared.sections };
      let pending: ReturnType<ParticipantInputs["capture"]>;
      const recordJob = (instructions: string, supplied: readonly InputSection[]) => {
        pending = inputs.capture({
          scope,
          roleId: role.id,
          profileId: profile.id,
          sections: prepared.sections,
          mode: wentBack ? "continued" : "fresh",
          plannedId,
          selectionReason: options.selectionReason,
          reviewerKey: options.reviewerKey,
          confirmedSettings: run.settings,
          instructions,
          extra: {
            sessionId: run.sessionId,
            supplied,
            omitted: prepared.omitted,
            ...(!wentBack && (opened.reopenFailure ?? options.freshReason)
              ? { freshReason: opened.reopenFailure ?? options.freshReason }
              : {}),
          },
        });
      };
      const text = wentBack ? continuePrompt(promptContext, { refreshRole: prepared.refreshRole, recordJob }) : buildPrompt(promptContext, recordJob);
      await inputs.attach(scope, pending, text);
      const reply = await run.prompt(text);
      const parsed = parseResult(reply.text, contractFor(role).result);
      if (parsed.ok !== true) throw new Error("The canonical participant did not return a review");
      const inputIndex = step.agentInputs?.findLastIndex(input => input.roleId === role.id && input.profileId === profile.id && input.reviewerKey === options.reviewerKey) ?? -1;
      if (inputIndex < 0) throw new Error("The actual outgoing participant input was not attached");
      recordAgentResult(step, { roleId: role.id, profileId: profile.id, productId: work.productId, at: now(), value: parsed.value, ...(inputIndex >= 0 ? { inputIndex } : {}) });
      options.completed?.(note, profile, role);
      return { run, note, value: parsed.value, input: step.agentInputs![inputIndex]!, text };
    } finally { await run.stop(); active.delete(run); }
  }
  return { context, inputs, agents, packets, exact, starts, announcements, statuses, checkpointed, missingSessions, failures, signal: controller.signal,
    /** Compose only inside run, so expected rejection is observed before its one registered owner settles. */
    perform: send,
    send: (...args: Parameters<typeof send>) => operations.run(() => send(...args)),
    run: <T>(start: () => Promise<T>) => operations.run(start), close: () => operations.close(),
  };
}
