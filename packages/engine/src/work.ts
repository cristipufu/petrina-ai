import { type RepositoryContext } from "@petrina/orchestrator";
import { productsFor, versionsOf, changesOf, acceptanceVersion, invalidateAcceptance } from "./repositories.js";
import { beginRepair } from "@petrina/orchestrator";
import { openProofs, refreshProofs, restorationReason, sameVersions } from "@petrina/core";
// "do" stages: one role on one profile. The builder answers findings, brings work up to date and writes a pull
// request's description, and Petrina keeps its work as one commit; the tester checks acceptance, and any other
// role hands back notes. The delivery step is Petrina's own (shipping.ts).

import { builderFindings, builderReturnWords, checkProblem, recordStepResult, endAgentStep, lastIndexWhere, JOURNEY_WORDS as W, noteReproduction, openStep, owedAcceptanceTest, type Task } from "@petrina/core";
import * as git from "./git.js";
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
import { addDeliveryCheck } from "./proof-requests.js";

/** A pull request's description must fit where GitHub puts it, beside Petrina's own part: the builder shortens it, never Petrina. */
function tooLong(value: { description?: string | undefined }): string | undefined {
  if (value.description && value.description.length > TEXT_LIMITS.description) return `"description" is longer than a pull request can take (${TEXT_LIMITS.description} characters). Shorten it, then end with the result block.`;
  return undefined;
}

export class Work {
  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly context: Context, private readonly guide: GuideKeeper, private readonly updates: Updates, private readonly learnings: Learnings, private readonly checks: ProductChecks) {}

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
      await git.commitAll(repository.worktree!, this.updates.message(scope));
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
      await this.updates.fold(scope);
      const builtTree = await git.treeOf(repository.worktree!);
      if (task.proofRequests?.length) refreshProofs(task, await versionsOf(task));
      const changed = startingTree && builtTree ? startingTree !== builtTree : undefined;
      if (repository.checks) repository.checks.current = repository.checks.tree === builtTree;
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
      let fixed = 0;
      if (fixing) {
        const at = Date.now();
        for (const answer of result.answers) {
          const finding = given.find((entry) => entry.id === answer.id && entry.status === "open");
          if (!finding) continue;
          finding.answer = { fixed: answer.fixed, text: answer.text, at };
          if (task.repositories) {
            finding.answers = { ...finding.answers, [repository.productId]: finding.answer };
            // Shared work stays open until every owner has answered, then combined review verifies it.
            if (answer.fixed && finding.raisedBy !== "petrina" && finding.productIds?.length === 1) finding.status = "fixed";
            // A failed check stays open whatever the builder says: only a passing run on the new code settles it.
          } else if (answer.fixed && !(finding.raisedBy === "petrina" && finding.text.startsWith("Check failed"))) finding.status = "fixed";
          if (answer.fixed) fixed += 1;
        }
        task.fixing = false;
        recordStepResult(task, { findings: given });
      }
      // A changed return awaits verification. An unchanged return retains the unresolved problem,
      // including when an earlier edit or check-definition change made that evidence outdated.
      const problem = changed === true ? undefined : checkProblem({ checks: repository.checks });
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
        const versions = await versionsOf(task);
        refreshProofs(task, versions);
        task.acceptanceRun = { versions, changes: await changesOf(task), requestIds: openProofs(task).map(request => request.id) };
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
      const staleRun = !!task.proofRequests?.length && !sameVersions(run.versions, currentVersions);
      // Saved by the step's cleanup before it undid commits or tracked edits anywhere in the task: every answer
      // from this run stays unverified, keeping any reason it was already unavailable. The agent's report is untouched.
      const restored = run.restored, invalid = restored && restorationReason(restored);
      const unavailable = <C extends { result: "pass" | "fail" | "blocked"; reason?: string | undefined }>(check: C): C => invalid
        ? { ...check, result: "blocked", reason: [invalid, check.result === "blocked" ? check.reason : undefined].filter(Boolean).join(" ") }
        : check;
      // Preserve observed failures and unavailable probes. Freshness belongs to each request's
      // affected products, independently of the outcome recorded on the run's starting versions.
      const answered = rawResult.proofAnswers.map(answer => answer.evidence?.trim() ? answer : { ...answer, result: "blocked" as const, reason: answer.reason?.trim() || "The agent did not record how it verified this request." });
      const proofAnswers = answered.map(unavailable);
      const proofChecks = answered.map(answer => ({ ...answer, proofRequestId: answer.id, text: task.proofRequests!.find(request => request.id === answer.id)!.text, productIds: [...task.proofRequests!.find(request => request.id === answer.id)!.productIds] }));
      const result = { ...rawResult, checks: [...rawResult.checks, ...proofChecks].map((check) => {
        const productIds = productsFor(task, "productIds" in check ? check.productIds : undefined);
        if (task.repositories && !productIds.length) return unavailable({ ...check, productIds: [], result: "blocked" as const, reason: "Together: no valid affected products were assigned. The coordinator must resolve ownership." });
        if (check.result !== "blocked" && !check.evidence) return unavailable({ ...check, productIds, result: "blocked" as const, reason: "The agent did not record how it verified this item." });
        return unavailable({ ...check, productIds });
      }) };
      const testerStep = openStep(task);
      if (testerStep?.kind === "agent" && testerStep.roleId === roleId) {
        const report = testerStep.agentResults?.findLast((entry) => entry.roleId === roleId && entry.profileId === by);
        if (report) report.versions = testedVersions;
        if (restored) testerStep.proofRun = structuredClone(run);
        testerStep.proofChecks = proofAnswers;
        testerStep.acceptanceChecks = result.checks.map((check) => ({ text: check.text, result: check.result, ...(check.evidence ? { evidence: check.evidence } : {}), ...("reason" in check && check.reason ? { reason: check.reason } : {}) }));
      }
      await this.learnings.note(scope, result.learnings, roleId, by);
      if (task.brief) task.brief.acceptance = task.brief.acceptance.map((item) => {
        const check = result.checks.find((entry) => entry.text === item.text);
        if (!check) return item;
        return {
          ...item,
          // An invalidated run cannot reassign an item's products or versions.
          ...(task.repositories && !restored ? { productIds: check.productIds, versions: Object.fromEntries(check.productIds.map((id) => [id, testedVersions![id]!])) } : {}),
          met: check.result === "pass" ? true : check.result === "fail" ? false : undefined,
          verification: check.result === "pass" ? "passed" : check.result === "fail" ? "failed" : "blocked",
          ...(check.result === "blocked" && check.reason ? { reason: check.reason } : { reason: undefined }),
        };
      });
      const failed = result.checks.filter((check) => check.result === "fail");
      const blocked = result.checks.filter((check) => check.result === "blocked");
      // Required: the saved checklist and requested proof. An extra probe the Tester added stays an observation.
      const required = blocked.filter((check) => "proofRequestId" in check || task.brief?.acceptance.some((item) => item.text === check.text));
      // An invalidated run's reported failures stay in its history; earlier problems keep their own results.
      for (const check of restored ? [] : result.checks) {
        const proofRequestId = "proofRequestId" in check && typeof check.proofRequestId === "string" ? check.proofRequestId : undefined;
        const text = check.result === "blocked" ? `Could not verify acceptance check: ${check.text}` : `Failed acceptance check: ${check.text}`;
        const alternate = check.result === "blocked" ? `Failed acceptance check: ${check.text}` : `Could not verify acceptance check: ${check.text}`;
        const earlier = task.findings.find((finding) => proofRequestId ? finding.proofRequestId === proofRequestId : !finding.proofRequestId && (finding.text === text || finding.text === alternate));
        if (earlier) {
          earlier.text = text;
          if (task.repositories) earlier.productIds = check.productIds;
          earlier.status = check.result === "pass" ? "fixed" : check.result === "blocked" ? "unverified" : "open";
          if (check.result === "fail") noteReproduction(task, earlier, Date.now());
          if (check.result === "blocked" && check.reason) earlier.evidence = check.reason;
          else if (check.result === "pass") delete earlier.evidence;
        } else if (check.result === "fail") task.findings.push({
          ...(proofRequestId ? { proofRequestId } : {}),
          ...(task.repositories ? { productIds: check.productIds } : {}),
          id: this.k.id(task.id), text,
          severity: "blocking", raisedBy: by, confirmedBy: [], status: "open",
        });
      }
      // Without checklist items or requested proof, an invalidated run is still unverified.
      const unverified = blocked.length > 0 || !!restored;
      const requiredGap = required.length > 0 || !!restored;
      this.k.log(scope, failed.length || unverified ? "warn" : "done", restored
        ? `Acceptance could not be verified: ${invalid}`
        : unverified
        ? `${blocked.length} acceptance check${blocked.length === 1 ? "" : "s"} could not be verified${failed.length ? `; ${failed.length} failed` : ""}`
        : failed.length ? `${failed.length} acceptance check${failed.length === 1 ? "" : "s"} failed` : staleRun ? "Acceptance passed on an earlier version; the final code still needs acceptance testing" : result.summary, roleId, by);
      endAgentStep(task, {
        outcome: restored && !blocked.length ? "Could not be verified" : unverified ? `${blocked.length} ${blocked.length === 1 ? "check" : "checks"} could not be verified${failed.length ? `; ${failed.length} failed` : ""}` : W.checks(failed.length, result.checks.length),
        reason: restored ? restored.products.length ? "Petrina undid changes during acceptance testing" : "Petrina could not confirm what its cleanup undid" : unverified ? "acceptance not fully verified" : failed.length ? W.checksFailed(failed.length) : staleRun ? "the code changed during acceptance testing; final acceptance is still pending" : W.checksPassed,
      }, Date.now());
      for (const answer of proofAnswers) {
        const request = task.proofRequests!.find(request => request.id === answer.id)!;
        request.proof = { stepId: testerStep!.id, versions: { ...run.versions }, result: answer.result, ...(answer.evidence ? { evidence: answer.evidence } : {}), ...(answer.reason ? { reason: answer.reason } : {}) };
      }
      refreshProofs(task, currentVersions);
      task.testedChanges = { ...run.changes };
      delete task.acceptanceRun;
      delete task.proofRetestReason;
      delete task.repairCheck;
      const testedPatch = (await acceptanceVersion(task, testedVersions)) ?? (await this.updates.patch(scope));
      if (testerStep?.kind === "agent" && testerStep.roleId === roleId) testerStep.acceptancePatch = testedPatch;
      task.testedPatch = testedPatch ?? task.testedPatch;
      if (testedVersions) task.testedVersions = testedVersions;
      task.acceptancePassed = failed.length === 0 && !requiredGap && !staleRun;
      task.acceptanceUnverified = unverified;
      if (!requiredGap) delete task.acceptanceBlocked;
      // Even with delivery approval off, required acceptance that could not be verified waits for the coordinator's decision.
      if (requiredGap && !task.plan!.stages.some((entry) => entry.kind === "gate" && entry.gate === "delivery") && addDeliveryCheck(this.k, task)) {
        this.k.log(scope, "milestone", restored
          ? "Added your delivery check: this acceptance run cannot verify the product, so delivery waits for your decision"
          : `Added your delivery check: ${required.length === 1 ? "a required acceptance check" : `${required.length} required acceptance checks`} could not be verified, so delivery waits for your decision`);
      }
      if (task.repositories && failed.length) {
        // Testing the delivery check started, and repairs of what it found, return to that check. Earlier testing and
        // its repairs go on through the rest of the plan: the owed reviews still run before any delivery decision.
        const final = owedAcceptanceTest(task)?.final === true;
        this.k.finishStep(scope);
        delete task.retest;
        if (beginRepair(this.k, task, "acceptance", task.stageIndex, { final })) return "continue";
        task.acceptanceBlocked = true;
        const planned = task.plan!.stages.some((entry) => entry.kind === "gate" && entry.gate === "delivery");
        // Even with delivery approval off, failures still open wait for the coordinator's explicit decision.
        if (!final && addDeliveryCheck(this.k, task)) {
          if (!planned) this.k.log(scope, "milestone", "Added your delivery check: acceptance still fails, so delivery waits for your decision");
          const reviews = task.plan!.stages.some((entry, index) => index > task.stageIndex && entry.kind === "review-chain");
          this.k.log(scope, "warn", `Acceptance still fails: the builder returns are unavailable or used up. ${reviews ? "The remaining reviews run first, then" : "Next,"} the decision goes to you at your delivery check`);
          task.stageIndex += 1;
          task.sub = 0;
          this.k.commitNow();
          return "continue";
        }
        this.k.log(scope, "warn", "Acceptance still fails: the builder returns are unavailable or used up, so the decision goes to you");
        const gate = task.plan!.stages.findIndex((entry) => entry.kind === "gate" && entry.gate === "delivery");
        task.stageIndex = gate >= 0 ? gate : task.plan!.stages.length;
        task.sub = 0;
        this.k.commitNow();
        if (gate >= 0) return "continue";
        this.k.gate(task, "delivery");
        return "stop";
      }
      if (task.retest) {
        // The final pass before the delivery check: on to the check, or back to the builder with what failed.
        const final = owedAcceptanceTest(task)?.final === true;
        delete task.retest;
        this.k.finishStep(scope);
        const stages = task.plan?.stages ?? [];
        const builder = lastIndexWhere(stages, (entry) => this.k.role(entry.roleId, task)?.result === "build" && entry.kind === "do");
        // A reproduced failure keeps its bounded repair even while another item could not be verified; that item alone sends nothing back.
        if (failed.length && builder >= 0 && (repository.acceptanceReturns ?? 0) < 2) {
          repository.acceptanceReturns = (repository.acceptanceReturns ?? 0) + 1;
          task.stageIndex = builder;
          task.fixing = true;
          this.k.log(scope, "warn", `Sent back to the builder: ${failed.length} acceptance check${failed.length === 1 ? "" : "s"} failed on the final code`);
        } else {
          if (failed.length || requiredGap) {
            task.acceptanceBlocked = true;
            this.k.log(scope, "warn", failed.length
              ? "Acceptance still fails: the builder returns are used up, so the decision goes to you"
              : "Acceptance could not be fully verified, so the decision goes to you");
          }
          // Final testing returns to the delivery check; any other goes on through the planned steps that have not run yet.
          const gate = stages.findIndex((entry) => entry.kind === "gate" && entry.gate === "delivery");
          task.stageIndex = gate >= 0 && final ? gate : task.stageIndex + 1;
        }
        task.sub = 0;
        this.k.commit();
        return "continue";
      }
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
    this.k.finishStep(scope);
    this.k.tracking.endStage(scope, "done");
    if (this.k.rerun(task)) return "continue";
    if (task.repositories && role?.canEdit) {

      await invalidateAcceptance(task, testedVersions);
      const own = task.repositories.find((work) => work.productId === repository.productId)!;
      if (!task.repair) own.completedStages = [...new Set([...own.completedStages, stage.id])];
      if (task.repair) {
        task.repair.index += 1;
        if (task.repair.index < task.repair.products.length) {
          const next = task.repair.products[task.repair.index]!;
          task.activeProductId = next;
          task.fixing = !task.repair.portProducts?.includes(next);
          this.k.commitNow();
          return "continue";
        }
        // A repair of final testing goes back to it; an earlier one is checked by ordinary acceptance testing.
        if (task.repair.kind === "acceptance" && task.repair.final) task.retest = true;
        else if (task.repair.kind === "acceptance") task.repairCheck = true;
        task.stageIndex = task.repair.returnStage;
        delete task.repair;
        task.sub = 0;
        this.k.commitNow();
        return "continue";
      }
      const next = task.repositories.find((work) => !work.completedStages.includes(stage.id));
      if (next) { task.activeProductId = next.productId; this.k.commitNow(); return "continue"; }
    }
    task.stageIndex += 1;
    task.sub = 0;
    this.k.commit();
    return "continue";
  }
}
