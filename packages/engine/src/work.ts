import { AcceptanceResults, WorkCompletion } from "@petrina/orchestrator";
import { routeAcceptance, type AcceptanceRoutingHost, type RepositoryContext } from "@petrina/orchestrator";
import { versionsOf, committedCodeOf, acceptanceVersion, invalidateAcceptance } from "./repositories.js";
import { openProofs, refreshProofs } from "@petrina/core";
// "do" stages: one role on one profile. The builder answers findings, brings work up to date and writes a pull
// request's description, and Petrina keeps its work as one commit; the tester checks acceptance, and any other
// role hands back notes. The delivery step is Petrina's own (shipping.ts).

import { builderFindings, builderReturnWords, checkProblem, recordBuilderFindingAnswers, endAgentStep, JOURNEY_WORDS as W, openStep, type Task } from "@petrina/core";
import * as git from "@petrina/repositories/git";
import { formatFindings } from "./prompts.js";
import { BuildResult, freshBuilderRethink, NotesResult, TestResult, TEXT_LIMITS } from "./roles.js";
import { Kernel, stepKey, type MStage } from "./kernel.js";
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
  private readonly acceptanceHost: AcceptanceRoutingHost;
  private readonly acceptanceResults: AcceptanceResults;
  private readonly completion: WorkCompletion;
  constructor(private readonly k: Kernel, private readonly turns: Pick<Turns, "turn">, private readonly context: Pick<Context, "sectionsFor">, private readonly guide: Pick<GuideKeeper, "proposeGuideLine">, private readonly updates: Pick<Updates, "reopen" | "fold" | "message" | "patch">, private readonly learnings: Pick<Learnings, "note">, private readonly checks: Pick<ProductChecks, "repairVersion">) {
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
  }

  async runDo(scope: RepositoryContext, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const { task, work: repository } = scope;
    const roleId = stage.roleId;
    const profileId = (task.repositories && this.k.role(stage.roleId, task)?.result === "build" ? task.plan?.products?.find((owner) => owner.productId === repository.productId)?.builderProfileId : undefined) ?? stage.profileIds[0] ?? "opus-xhigh";
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
      const startingTree = repository.conversation?.roleId === roleId && repository.conversation.head
        ? repository.conversation.builderTree
        : await git.contentTree(repository.worktree!).catch(() => undefined);
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
      // A pull request's description: the builder's latest, or what it wrote before when it hands back none this time.
      const description = result.description?.trim() || repository.report?.description;
      repository.report = {
        summary: result.summary,
        changes: result.changes,
        ...(result.tests ? { tests: result.tests } : {}),
        ...(result.title ? { title: result.title } : {}),
        ...(description ? { description } : {}),
      };
      if (maintenance && !result.complete) { this.k.commitNow(task); throw new Error(`Maintenance investigation is incomplete: ${result.summary}`); }
      await this.learnings.note(scope, result.learnings, roleId, by);
      // One commit per task: the builder's work joins the branch's one commit, under its title.
      await git.commitChanges(repository.worktree!, this.updates.message(scope));
      if (updating) {
        // A first review, an unreviewed fix, or work beyond the conflicts needs the whole planned review.
        // Check the saved code too: older updates recorded a head without recording any completed review.
        const reviewed = !task.fixing && updating.head && repository.reviewedTree && repository.reviewedTree === await git.treeOf(repository.worktree!, updating.head);
        const merged = reviewed ? await git.mergeTree(repository.worktree!, updating.onto, updating.head) : undefined;
        const portOnly = merged && (await git.changedFiles(repository.worktree!, merged.tree, await git.head(repository.worktree!))).every((file) => updating.files.includes(file));
        delete repository.updating;
        delete repository.reviewedSha;
        delete task.hunt;
        delete repository.portReview;
        if (portOnly && updating.head) repository.portReview = { from: updating.from, head: updating.head, onto: updating.onto, files: updating.files };
        else delete repository.reviewedTree;
        this.k.log(scope, "done", `Brought up to date with ${sourceName}: ${result.summary}`, roleId, by);
      } else delete repository.reviewedTree;
      const folded = await this.updates.fold(scope);
      if (folded && (!git.isSha(folded.version.head) || !git.isSha(folded.version.tree))) {
        if (repository.checks) repository.checks.current = false;
        throw new Error("Petrina could not read the folded product version");
      }
      // A successful fold already observed or created this exact version. No fold still needs a fresh read.
      const builtTree = folded ? folded.version.tree : await git.treeOf(repository.worktree!);
      if (task.proofRequests?.length) refreshProofs(task, await versionsOf(task));
      const changed = startingTree && builtTree ? startingTree !== builtTree : undefined;
      if (repository.checks) repository.checks.current = !!builtTree && repository.checks.tree === builtTree;
      const buildReport = openStep(task)?.agentResults?.findLast((entry) => entry.roleId === roleId && entry.profileId === by);
      if (buildReport && builtTree) buildReport.versions = { [repository.productId]: builtTree };
      const completedStep = openStep(task);
      if (completedStep && builtTree) completedStep.buildVersions = { ...completedStep.buildVersions, [repository.productId]: builtTree };
      if (completedStep && checkFailures.length) {
        const version = await this.checks.repairVersion(scope).catch(() => undefined);
        if (version?.sha && version.tree) completedStep.checkRepairs = checkFailures.flatMap((failure) => {
          if (!completedStep.findingIds?.includes(failure.check.findingId!) || !given.some((finding) => finding.id === failure.check.findingId)) return [];
          const answer = result.answers.find((answer) => answer.id === failure.check.findingId);
          return answer?.text.trim() ? [{ productId: repository.productId, failureNode: failure.nodeId, checkId: failure.check.id!, attemptId: failure.attempt.id, findingId: answer.id,
            sha: version.sha!, tree: version.tree!, definition: version.definition, commands: version.commands, answer: { fixed: answer.fixed, text: answer.text.slice(0, 600) } }] : [];
        });
      }
      // The next fix round or update goes back to the conversation that really completed this build.
      const conversation = repository.conversation;
      if (conversation?.briefed && conversation.roleId === roleId) repository.builderSession = { stageId: stage.id, profileId: by, plannedProfileId: profileId, toolId: conversation.toolId, model: conversation.model, sessionId: conversation.sessionId, ...(conversation.context ? { context: conversation.context } : {}), ...(rethink || back?.rethought ? { rethought: true } : {}) };
      const fixing = task.fixing;
      const fixed = fixing ? recordBuilderFindingAnswers(task, given, result.answers, { productId: repository.productId, shared: !!task.repositories, at: Date.now() }) : 0;
      // A changed return awaits verification. An unchanged return retains the unresolved problem,
      // including when an earlier edit or check-definition change made that evidence outdated.
      const problem = changed === true ? undefined : checkProblem(repository);
      const outcome = builderReturnWords(changed, problem, fixed);
      const returnedStep = openStep(task);
      if (returnedStep?.kind === "agent") returnedStep.builderReturn = { productId: repository.productId, ...(changed !== undefined ? { changed } : {}), claimedFixes: fixed, outcome };
      if (!updating) this.k.log(scope, "done", `${outcome}: ${result.summary}`, roleId, by);
      endAgentStep(
        task,
        updating ? { outcome: W.broughtUpToDate, reason: sourceName === "main" ? W.upToDate : `up to date with ${sourceName}` } : fixing || (changed === false && problem) ? { outcome, reason: outcome, ...(problem ? { tone: "back" as const } : {}) } : { outcome: changed === false ? W.unchanged : W.built, reason: W.readyForReview },
        Date.now(),
      );
    } else if (role?.result === "checks") {
      const continuing = repository.conversation?.roleId === roleId && repository.conversation.step === stepKey(task);
      if (!task.acceptanceRun || !continuing) {
        // An interrupted attempt whose changes Petrina undid settled nothing: its step keeps that record, and the fresh run gets its own.
        const interrupted = openStep(task);
        const lost = interrupted?.kind === "agent" ? interrupted.proofRun?.restored : undefined;
        if (lost) endAgentStep(task, { outcome: "Stopped before a result", reason: `${lost.products.length ? "Petrina undid changes during this attempt" : "Petrina could not confirm what this attempt's cleanup undid"}; the next run starts fresh`, tone: "back" }, Date.now());
        const observed = await committedCodeOf(task);
        refreshProofs(task, observed.versions);
        task.acceptanceRun = { ...observed, requestIds: openProofs(task).map(request => request.id) };
        this.k.commitNow();
      }
      const run = task.acceptanceRun;
      testedVersions = { ...run.versions };
      const rawResult = await this.turns.turn(scope, roleId, profileId, sections, TestResult, signal, {
        used,
        check: (value) => {
          const ids = value.proofAnswers.map(answer => answer.id);
          if (new Set(ids).size !== ids.length || ids.some(id => !run.requestIds.includes(id)) || run.requestIds.some(id => !ids.includes(id))) return `Answer every open proof request exactly once by id in proofAnswers, with pass, fail, or blocked and evidence. Required ids: ${run.requestIds.join(", ") || "none"}.`;
          const missing = task.brief?.acceptance.filter((item) => !value.checks.some((check) => check.text === item.text));
          return missing?.length ? `Report pass, fail, or blocked for every acceptance item, using its exact text. For blocked checks, include a reason naming what prevented verification. These are missing:\n${missing.map((item) => `- ${item.text}`).join("\n")}` : undefined;
        },
      });
      if (role.canEdit) {
        await this.k.saveRoleEdits(scope, roleId, by);
        testedVersions = await versionsOf(task);
      }
      // Reuse the run's snapshot for ordinary acceptance and the post-save snapshot for editors.
      // Explicit proof also needs one finishing observation when a read-only Tester returns.
      const currentVersions = role.canEdit || !task.proofRequests?.length ? testedVersions : await versionsOf(task);
      const recorded = await this.acceptanceResults.record(scope, { roleId, profileId: by, report: rawResult, run, testedVersions, currentVersions });
      const next = routeAcceptance(this.acceptanceHost, scope, recorded);
      if (next) return next;
    } else {
      const result = savedResult !== undefined ? NotesResult.parse(savedResult) : await this.turns.turn(scope, roleId, profileId, sections, NotesResult, signal, { used, check: value => maintenance && typeof value.complete !== "boolean" ? 'Return "complete": true for a completed investigation, or false and explain why it is incomplete.' : undefined });
      const handed = { ...(task.repositories && role?.canEdit ? { productId: repository.productId } : {}), at: Date.now(), profileId: by, stageId: stage.id, roleId, roleName: repository.conversation?.role?.name ?? role?.name ?? roleId, title: stage.title, summary: result.summary, notes: result.notes };
      task.handedBack = [...(task.handedBack ?? []).filter((entry) => entry.stageId !== stage.id || entry.productId !== handed.productId), handed];
      this.k.participantSay(scope, "agent", [result.summary, ...result.notes.map((note) => `• ${note}`)].join("\n"), roleId, by, undefined);
      this.k.log(scope, "done", `${role?.name ?? roleId} done: ${result.summary}`, roleId, by);
      if (maintenance && !result.complete) { this.k.commitNow(task); throw new Error(`Maintenance investigation is incomplete: ${result.summary}`); }
      endAgentStep(task, { outcome: W.wroteNotes, reason: W.notesReady }, Date.now());
    }
    if (role?.result !== "build" && role?.result !== "checks") await this.k.saveRoleEdits(scope, roleId, by);
    if (maintenance) {
      delete maintenance.pendingResult;
      if (maintenance.readOnlyWrites) throw new Error("The read-only maintenance agent changed product files. Petrina undid those writes. Review its report and retry the investigation.");
      // Compare the actual final product tree, including committed changes withdrawn in a repair.
      const base = repository.baseSha;
      const changed = repository.worktree && base ? (await git.changedFiles(repository.worktree, base, await git.head(repository.worktree))).length > 0 : true;
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
