import { AcceptanceStep, AcceptanceResults, WorkCompletion, BuildCompletion, finishSourcePort } from "@petrina/orchestrator";
import { type AcceptanceRoutingHost, type RepositoryContext } from "@petrina/orchestrator";
import { versionsOf, committedCodeOf, acceptanceVersion, invalidateAcceptance } from "./repositories.js";
// "do" stages: one role on one profile. The builder answers findings, brings work up to date and writes a pull
// request's description, and Petrina keeps its work as one commit; the tester checks acceptance, and any other
// role hands back notes. The delivery step is Petrina's own (shipping.ts).

import { builderFindings, endAgentStep, JOURNEY_WORDS, type Task } from "@petrina/core";
import * as git from "@petrina/repositories/git";
import { formatFindings } from "./prompts.js";
import { BuildResult, freshBuilderRethink, NotesResult, TestResult, TEXT_LIMITS } from "./roles.js";
import { Kernel, type MutableStage } from "./kernel.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import type { GuideKeeper } from "./guide-keeper.js";
import type { Updates } from "./update.js";
import type { Learnings } from "./learnings.js";
import type { ProductChecks } from "./product-checks.js";
import { assignedCheckFailures } from "./related-check-evidence.js";

/** A pull request's description must fit where GitHub puts it, beside Petrina's own part: the builder shortens it, never Petrina. */
function tooLong(value: { description?: string | undefined }): string | undefined {
  if (value.description && value.description.length > TEXT_LIMITS.description) return `"description" is longer than a pull request can take (${TEXT_LIMITS.description} characters). Shorten it, then end with the result block.`;
  return undefined;
}

export class Work {
  private readonly acceptanceStep: AcceptanceStep;
  private readonly acceptanceHost: AcceptanceRoutingHost;
  private readonly acceptanceResults: AcceptanceResults;
  private readonly completion: WorkCompletion;
  private readonly buildCompletion: BuildCompletion;
  constructor(private readonly k: Kernel, private readonly turns: Pick<Turns, "turn">, private readonly context: Pick<Context, "sectionsFor">, private readonly guide: Pick<GuideKeeper, "proposeGuideLine">, private readonly updates: Pick<Updates, "reopen" | "fold" | "message" | "patch">, learnings: Pick<Learnings, "note">, checks: Pick<ProductChecks, "repairVersion">) {
    this.buildCompletion = new BuildCompletion({
      now: () => Date.now(), checkpoint: task => k.commitNow(task),
      note: (scope, tone, text, roleId, profileId) => k.log(scope, tone, text, roleId, profileId),
      noteLearnings: (scope, lessons, roleId, profileId) => learnings.note(scope, lessons, roleId, profileId),
    }, {
      saveChanges: async scope => { await git.commitChanges(scope.work.worktree!, updates.message(scope)); },
      finishPort: async (scope, updating) => {
        const worktree = scope.work.worktree!;
        await finishSourcePort(scope, updating, {
          treeOf: head => git.treeOf(worktree, head), merge: (onto, head) => git.mergeTree(worktree, onto, head),
          changedFiles: async tree => git.changedFiles(worktree, tree, "HEAD"),
        });
      },
      fold: scope => updates.fold(scope), tree: scope => git.treeOf(scope.work.worktree!), versions: versionsOf,
      repairVersion: scope => checks.repairVersion(scope),
    });
    this.acceptanceResults = new AcceptanceResults({
      id: task => k.id(task.id), now: () => Date.now(),
      note: (scope, tone, text, roleId, profileId) => k.log(scope, tone, text, roleId, profileId),
      noteLearnings: (scope, lessons, roleId, profileId) => learnings.note(scope, lessons, roleId, profileId),
      acceptancePatch: async (scope, versions) => (await acceptanceVersion(scope.task, versions)) ?? (await updates.patch(scope)),
    });
    this.completion = new WorkCompletion({
      finishStep: scope => k.finishStep(scope),
      endStage: scope => k.tracking.endStage(scope, "done"),
      rerun: task => k.rerun(task),
      invalidateAcceptance: (scope, versions) => invalidateAcceptance(scope.task, versions).then(() => undefined),
      checkpoint: () => k.commitNow(),
      changed: () => k.commit(),
    });
    this.acceptanceHost = {
      role: (id, task) => k.role(id, task),
      finishStep: scope => k.finishStep(scope),
      note: (scope, tone, text) => k.log(scope, tone, text),
      commitNow: task => k.commitNow(task),
      commit: task => k.commit(task),
      openDeliveryDecision: task => k.gate(task, "delivery"),
    };
    this.acceptanceStep = new AcceptanceStep({ now: () => Date.now(), checkpoint: () => k.commitNow() }, {
      committedCode: committedCodeOf, versions: versionsOf,
      saveEdits: (scope, roleId, profileId) => k.saveRoleEdits(scope, roleId, profileId),
      turn: (scope, input, signal) => {
        const initialHead = input.committed?.[scope.work.productId];
        return turns.turn(scope, input.roleId, input.profileId, () => context.sectionsFor(scope, input.roleId), TestResult, signal, {
          used: input.used,
          check: input.check,
          ...(initialHead && git.isSha(initialHead) ? { initialHead } : {}),
          ...(input.committed ? { initialCompanionHeads: input.committed } : {}),
        });
      },
    }, this.acceptanceResults, this.acceptanceHost);
  }

  async runDo(scope: RepositoryContext, stage: MutableStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const { task, work: repository } = scope;
    const roleId = stage.roleId;
    const profileId = (task.repositories && this.k.role(
      stage.roleId,
      task
    )?.result === "build" ? task.plan?.products?.find((owner) => owner.productId === repository.productId)?.builderProfileId : undefined) ?? stage.profileIds[0] ?? "opus-xhigh";
    let by = profileId;
    const used = (id: string) => (by = id);
    const role = repository.conversation?.roleId === roleId && repository.conversation.role ? repository.conversation.role : this.k.role(roleId, task);
    if (task.repositories && role?.canEdit && (repository.pr || repository.release || repository.landed)) throw new Error("This product has already been delivered. Its confirmed work is preserved; any further repair needs a separately reviewed follow-up.");
    const sections = () => this.context.sectionsFor(scope, roleId);

    const maintenance = task.maintenance?.role.id === roleId ? task.maintenance : undefined;
    const pending = maintenance?.pendingResult;
    const savedResult = pending && pending.stageId === stage.id && maintenance?.settingsDecision?.choice === "keep" ? pending.value : undefined;
    // A restart may interrupt a read-only turn's cleanup after its settings decision was saved.
    const acceptedReply = maintenance?.pendingReply?.stageId === stage.id && maintenance.settingsDecision?.choice === "keep";
    if ((savedResult !== undefined || acceptedReply) && !role?.canEdit && repository.worktree && repository.conversation?.head) {
      const status = await git.worktreeStatus(repository.worktree);
      if (status.head !== repository.conversation.head || !status.clean) {
        maintenance!.readOnlyWrites = true;
        if (status.head !== repository.conversation.head) await git.resetTo(repository.worktree, repository.conversation.head);
        if (!status.clean) await git.discardChanges(repository.worktree);
        this.k.commitNow(scope);
      }
    }
    let testedVersions: Record<string, string> | undefined;
    if (role?.result === "build") {
      if (task.miss) await this.guide.proposeGuideLine(scope, signal);
      const updating = repository.updating;
      const sourceName = repository.source?.start.kind === "pull-request" ? `PR #${repository.source.start.number}` : repository.source?.start.branch ?? "main";
      if (updating) await this.updates.reopen(scope);
      const starting = repository.conversation?.roleId === roleId && repository.conversation.head
        ? { head: repository.conversation.head, tree: repository.conversation.builderTree }
        : await git.observeContentTree(repository.worktree!, repository.savedVersion).catch(() => ({ head: undefined, tree: undefined }));
      const startingTree = starting.tree;
      // In a fix round the builder answers every finding it was given, by id. Acceptance failures whose returns are used up
      // wait for the coordinator: no repair of another finding hands them over.
      const given = task.fixing ? builderFindings(task, repository.productId) : [];
      // Bind to the failure attempt now; mutable finding ids can be reused by a later check run.
      const checkFailures = assignedCheckFailures(scope);
      // Fix rounds and updates go back to its own conversation, except when it is asked to step back and rethink.
      const own = repository.builderSession;
      const rethink = freshBuilderRethink(task as Task, own, stage.id, profileId);
      const back = (task.fixing || updating) && own?.stageId === stage.id && (own.plannedProfileId ?? own.profileId) === profileId && !rethink ? own : undefined;
      const result = savedResult !== undefined ? BuildResult.parse(savedResult) : await this.turns.turn(scope, roleId, profileId, sections, BuildResult, signal, {
        builderTree: startingTree,
        initialHead: starting.head,
        used,
        check: async (value) => {
          if (maintenance && typeof value.complete !== "boolean") return 'Return "complete": true for a completed investigation, or false and explain why it is incomplete.';
          const missing = given.filter((finding) => !value.answers.some((answer) => answer.id === finding.id));
          if (missing.length) return `answer every finding by id in "answers" (fixed, or not fixed and why), and these have none:\n${formatFindings(missing as Task["findings"])}`;
          const marked = updating ? await git.withMarkers(repository.worktree!, updating.files) : [];
          if (marked.length) return `these files still have git's conflict markers: ${marked.join(", ")}. Resolve them, run the checks again, then end with the result block.`;
          return tooLong(value);
        },
        ...(back ? { resume: back } : {}),
        ...(rethink ? { freshReason: "A deliberate fresh rethink after three review rounds; later repairs can keep this replacement conversation." } : {}),
      });
      await this.buildCompletion.complete(scope, { stageId: stage.id, roleId, plannedProfileId: profileId, actualProfileId: by,
        result, maintenance: !!maintenance, updating, sourceName, startingTree, given, checkFailures, rethought: rethink || back?.rethought });
    } else if (role?.result === "checks") {
      const accepted = await this.acceptanceStep.run(scope, { roleId, profileId, canEdit: () => !!role.canEdit, used }, signal);
      testedVersions = accepted.testedVersions;
      if (accepted.next) return accepted.next;
    } else {
      const result = savedResult !== undefined ? NotesResult.parse(savedResult) : await this.turns.turn(
        scope,
        roleId,
        profileId,
        sections,
        NotesResult,
        signal,
        {
        used,
        check: value => maintenance && typeof value.complete !== "boolean" ? 'Return "complete": true for a completed investigation, or false and explain why it is incomplete.' : undefined
      }
      );
      const handed = {
        ...(task.repositories && role?.canEdit ? { productId: repository.productId } : {}),
        at: Date.now(),
        profileId: by,
        stageId: stage.id,
        roleId,
        roleName: repository.conversation?.role?.name ?? role?.name ?? roleId,
        title: stage.title,
        summary: result.summary,
        notes: result.notes
      };
      task.handedBack = [...(task.handedBack ?? []).filter((entry) => entry.stageId !== stage.id || entry.productId !== handed.productId), handed];
      this.k.participantSay(scope, "agent", [result.summary, ...result.notes.map((note) => `• ${note}`)].join("\n"), roleId, by, undefined);
      this.k.log(scope, "done", `${role?.name ?? roleId} done: ${result.summary}`, roleId, by);
      if (maintenance && !result.complete) {
        this.k.commitNow(task);
        throw new Error(`Maintenance investigation is incomplete: ${result.summary}`);
      }
      endAgentStep(task, { outcome: JOURNEY_WORDS.wroteNotes, reason: JOURNEY_WORDS.notesReady }, Date.now());
    }
    if (role?.result !== "build" && role?.result !== "checks") await this.k.saveRoleEdits(scope, roleId, by);
    if (maintenance) {
      delete maintenance.pendingResult;
      if (maintenance.readOnlyWrites) throw new Error("The read-only maintenance agent changed product files. Petrina undid those writes. Review its report and retry the investigation.");
      // Compare the actual final product tree, including committed changes withdrawn in a repair.
      const base = repository.baseSha;
      const changed = repository.worktree && base ? (await git.changedFiles(repository.worktree, base, "HEAD")).length > 0 : true;
      if (!changed) {
        maintenance.noProductChanges = true;
        this.k.finishStep(scope);
        this.k.tracking.endStage(scope, "done");
        Object.assign(task, { state: "done", column: "done", statusLine: "Completed · No product changes", holdsSlot: false, finishedAt: Date.now() });
        delete task.agent;
        repository.nothingToPublish = true;
        repository.cleanup = { ...repository.cleanup, pullRequest: "none" };
        this.k.onTaskDone?.(task);
        this.k.commitNow(task);
        return "stop";
      }
    }
    return this.completion.complete(scope, { stageId: stage.id, canEdit: !!role?.canEdit, ...(testedVersions ? { testedVersions } : {}) });
  }
}
