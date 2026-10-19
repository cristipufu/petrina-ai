import { beginRepair, productsFor, versionsOf, acceptanceVersion, invalidateAcceptance } from "./repositories.js";
// "do" stages: one role on one profile. The builder answers findings, brings work up to date and writes a pull
// request's description, and Petrina keeps its work as one commit; the tester checks acceptance, and any other
// role hands back notes. The delivery step is Petrina's own (shipping.ts).

import { endAgentStep, lastIndexWhere, JOURNEY_WORDS as W, openStep, type Task } from "@petrina/core";
import * as git from "./git.js";
import { formatFindings } from "./prompts.js";
import { BuildResult, NotesResult, stepBack, TestResult, TEXT_LIMITS } from "./roles.js";
import { Kernel, type MStage, type MTask } from "./kernel.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import type { GuideKeeper } from "./guide-keeper.js";
import type { Updates } from "./update.js";
import type { Learnings } from "./learnings.js";

/** A pull request's description must fit where GitHub puts it, beside Petrina's own part: the builder shortens it, never Petrina. */
function tooLong(value: { description?: string | undefined }): string | undefined {
  if (value.description && value.description.length > TEXT_LIMITS.description) return `"description" is longer than a pull request can take (${TEXT_LIMITS.description} characters). Shorten it, then end with the result block.`;
  return undefined;
}

export class Work {
  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly context: Context, private readonly guide: GuideKeeper, private readonly updates: Updates, private readonly learnings: Learnings) {}

  async runDo(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const roleId = stage.roleId;
    const profileId = (task.repositories && this.k.role(stage.roleId)?.result === "build" ? task.plan?.products?.find((owner) => owner.productId === task.productId)?.builderProfileId : undefined) ?? stage.profileIds[0] ?? "opus-xhigh";
    let by = profileId;
    const used = (id: string) => (by = id);
    const role = task.conversation?.roleId === roleId && task.conversation.role ? task.conversation.role : this.k.role(roleId);
    if (task.repositories && role?.canEdit && (task.pr || task.release || task.landed)) throw new Error("This product has already been delivered. Its confirmed work is preserved; any further repair needs a separately reviewed follow-up.");
    const sections = () => this.context.sectionsFor(task, roleId);

    if (role?.result === "build") {
      if (task.miss) await this.guide.proposeGuideLine(task, signal);
      const updating = task.updating;
      const sourceName = task.source?.start.kind === "pull-request" ? `PR #${task.source.start.number}` : task.source?.start.branch ?? "main";
      if (updating) await this.updates.reopen(task);
      // In a fix round the builder answers every finding it was given, by id.
      const given = task.fixing ? task.findings.filter((finding) => finding.status === "open" && finding.severity !== "pre-existing" && (!task.repositories || finding.productIds?.includes(task.productId))) : [];
      // Fix rounds and updates go back to its own conversation, except when it is asked to step back and rethink.
      const own = task.builderSession;
      const back = (task.fixing || updating) && own?.stageId === stage.id && (own.plannedProfileId ?? own.profileId) === profileId && !(task.fixing && stepBack(task as unknown as Task)) ? own : undefined;
      const builderStep = openStep(task);
      if (task.fixing && builderStep?.kind === "agent" && builderStep.roleId === roleId) builderStep.builderConversation = back ? "resumed" : "new";
      const result = await this.turns.turn(task, roleId, profileId, sections, BuildResult, signal, {
        used,
        check: async (value) => {
          const missing = given.filter((finding) => !value.answers.some((answer) => answer.id === finding.id));
          if (missing.length) return `answer every finding by id in "answers" (fixed, or not fixed and why), and these have none:\n${formatFindings(missing as Task["findings"])}`;
          const marked = updating ? await git.withMarkers(task.worktree!, updating.files) : [];
          if (marked.length) return `these files still have git's conflict markers: ${marked.join(", ")}. Resolve them, run the checks again, then end with the result block.`;
          return tooLong(value);
        },
        ...(back ? { resume: { sessionId: back.sessionId, toolId: back.toolId, model: back.model } } : {}),
      });
      // A pull request's description: the builder's latest, or what it wrote before when it hands back none this time.
      const description = result.description?.trim() || task.report?.description;
      task.report = {
        summary: result.summary,
        changes: result.changes,
        ...(result.tests ? { tests: result.tests } : {}),
        ...(result.title ? { title: result.title } : {}),
        ...(description ? { description } : {}),
      };
      await this.learnings.note(task, result.learnings, roleId, by);
      // One commit per task: the builder's work joins the branch's one commit, under its title.
      const sha = await git.commitAll(task.worktree!, this.updates.message(task));
      if (updating) {
        // A first review, an unreviewed fix, or work beyond the conflicts needs the whole planned review.
        // Check the saved code too: older updates recorded a head without recording any completed review.
        const reviewed = updating.head && task.reviewedTree && task.reviewedTree === await git.treeOf(task.worktree!, updating.head);
        const merged = reviewed ? await git.mergeTree(task.worktree!, updating.onto, updating.head) : undefined;
        const portOnly = merged && (await git.changedFiles(task.worktree!, merged.tree, await git.head(task.worktree!))).every((file) => updating.files.includes(file));
        delete task.updating;
        delete task.reviewedSha;
        delete task.hunt;
        delete task.portReview;
        if (portOnly && updating.head) task.portReview = { from: updating.from, head: updating.head, onto: updating.onto, files: updating.files };
        else delete task.reviewedTree;
        this.k.log(task, "done", `Brought up to date with ${sourceName}: ${result.summary}`, roleId, by);
      } else delete task.reviewedTree;
      await this.updates.fold(task);
      if (task.checks) task.checks.current = task.checks.tree === await git.treeOf(task.worktree!);
      // The next fix round or update goes back to the conversation that really completed this build.
      const conversation = task.conversation;
      if (conversation?.briefed && conversation.roleId === roleId) task.builderSession = { stageId: stage.id, profileId: by, plannedProfileId: profileId, toolId: conversation.toolId, model: conversation.model, sessionId: conversation.sessionId, ...(conversation.context ? { context: conversation.context } : {}) };
      const fixing = task.fixing;
      let fixed = 0;
      if (fixing) {
        const at = Date.now();
        for (const answer of result.answers) {
          const finding = given.find((entry) => entry.id === answer.id && entry.status === "open");
          if (!finding) continue;
          finding.answer = { fixed: answer.fixed, text: answer.text, at };
          if (task.repositories) {
            finding.answers = { ...finding.answers, [task.productId]: finding.answer };
            // Shared work stays open until every owner has answered, then combined review verifies it.
            if (answer.fixed && finding.raisedBy !== "petrina" && finding.productIds?.length === 1) finding.status = "fixed";
          } else if (answer.fixed) finding.status = "fixed";
          if (answer.fixed) fixed += 1;
        }
        task.fixing = false;
      }
      if (!updating) this.k.log(task, "done", sha ? `Build done: ${result.summary}` : "Build done, with no changes to the code", roleId, by);
      endAgentStep(
        task,
        updating ? { outcome: W.broughtUpToDate, reason: sourceName === "main" ? W.upToDate : `up to date with ${sourceName}` } : fixing ? { outcome: W.fixed(fixed), reason: W.fixesReady } : { outcome: sha ? W.built : W.unchanged, reason: W.readyForReview },
        Date.now(),
      );
    } else if (role?.result === "checks") {
      let testedVersions = task.repositories ? await versionsOf(task) : undefined;
      const rawResult = await this.turns.turn(task, roleId, profileId, sections, TestResult, signal, {
        used,
        check: (value) => {
          const missing = task.brief?.acceptance.filter((item) => !value.checks.some((check) => check.text === item.text));
          return missing?.length ? `Report pass, fail, or blocked for every acceptance item, using its exact text. For blocked checks, include a reason naming what prevented verification. These are missing:\n${missing.map((item) => `- ${item.text}`).join("\n")}` : undefined;
        },
      });
      if (role.canEdit) { await this.k.saveRoleEdits(task, roleId, profileId); this.k.saveRepository(task); testedVersions = task.repositories ? await versionsOf(task) : undefined; }
      const result = { ...rawResult, checks: rawResult.checks.map((check) => {
        const productIds = productsFor(task, "productIds" in check ? check.productIds : undefined);
        if (task.repositories && !productIds.length) return { ...check, productIds: [], result: "blocked" as const, reason: "Together: no valid affected products were assigned. The coordinator must resolve ownership." };
        if (check.result !== "blocked" && !check.evidence) return { ...check, productIds, result: "blocked" as const, reason: "The agent did not record how it verified this item." };
        return { ...check, productIds };
      }) };
      const testerStep = openStep(task);
      if (testerStep?.kind === "agent" && testerStep.roleId === roleId) {
        testerStep.acceptanceChecks = result.checks.map((check) => ({ text: check.text, result: check.result, ...(check.evidence ? { evidence: check.evidence } : {}), ...("reason" in check && check.reason ? { reason: check.reason } : {}) }));
      }
      await this.learnings.note(task, result.learnings, roleId, by);
      if (task.brief) task.brief.acceptance = task.brief.acceptance.map((item) => {
        const check = result.checks.find((entry) => entry.text === item.text);
        if (!check) return item;
        return {
          ...item,
          ...(task.repositories ? { productIds: check.productIds, versions: Object.fromEntries(check.productIds.map((id) => [id, testedVersions![id]!])) } : {}),
          met: check.result === "pass" ? true : check.result === "fail" ? false : undefined,
          verification: check.result === "pass" ? "passed" : check.result === "fail" ? "failed" : "blocked",
          ...(check.result === "blocked" && check.reason ? { reason: check.reason } : { reason: undefined }),
        };
      });
      const failed = result.checks.filter((check) => check.result === "fail");
      const blocked = result.checks.filter((check) => check.result === "blocked");
      for (const check of result.checks) {
        const text = check.result === "blocked" ? `Could not verify acceptance check: ${check.text}` : `Failed acceptance check: ${check.text}`;
        const alternate = check.result === "blocked" ? `Failed acceptance check: ${check.text}` : `Could not verify acceptance check: ${check.text}`;
        const earlier = task.findings.find((finding) => finding.text === text || finding.text === alternate);
        if (earlier) {
          earlier.text = text;
          if (task.repositories) earlier.productIds = check.productIds;
          earlier.status = check.result === "pass" ? "fixed" : check.result === "blocked" ? "unverified" : "open";
          if (check.result === "blocked" && check.reason) earlier.evidence = check.reason;
          else if (check.result === "pass") delete earlier.evidence;
        } else if (check.result === "fail") task.findings.push({
          ...(task.repositories ? { productIds: check.productIds } : {}),
          id: this.k.id(task.id), text,
          severity: "blocking", raisedBy: by, confirmedBy: [], status: "open",
        });
      }
      const unverified = blocked.length > 0;
      this.k.log(task, failed.length || unverified ? "warn" : "done", unverified
        ? `${blocked.length} acceptance check${blocked.length === 1 ? "" : "s"} could not be verified${failed.length ? `; ${failed.length} failed` : ""}`
        : failed.length ? `${failed.length} acceptance check${failed.length === 1 ? "" : "s"} failed` : result.summary, roleId, by);
      endAgentStep(task, {
        outcome: unverified ? `${blocked.length} ${blocked.length === 1 ? "check" : "checks"} could not be verified${failed.length ? `; ${failed.length} failed` : ""}` : W.checks(failed.length, result.checks.length),
        reason: unverified ? "acceptance not fully verified" : failed.length ? W.checksFailed(failed.length) : W.checksPassed,
      }, Date.now());
      task.testedPatch = (await acceptanceVersion(task)) ?? (await this.updates.patch(task)) ?? task.testedPatch;
      if (testedVersions) task.testedVersions = testedVersions;
      task.acceptancePassed = failed.length === 0 && !unverified;
      task.acceptanceUnverified = unverified;
      if (!unverified) delete task.acceptanceBlocked;
      if (task.repositories && failed.length) {
        this.k.finishStep(task);
        delete task.retest;
        if (beginRepair(this.k, task, "acceptance", task.stageIndex)) return "continue";
        task.acceptanceBlocked = true;
        this.k.log(task, "warn", "Acceptance still fails: the builder returns are unavailable or used up, so the decision goes to you");
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
        delete task.retest;
        this.k.finishStep(task);
        const stages = task.plan?.stages ?? [];
        const builder = lastIndexWhere(stages, (entry) => entry.roleId === "builder" && entry.kind === "do");
        if (failed.length && !unverified && builder >= 0 && (task.acceptanceReturns ?? 0) < 2) {
          task.acceptanceReturns = (task.acceptanceReturns ?? 0) + 1;
          task.stageIndex = builder;
          task.fixing = true;
          this.k.log(task, "warn", `Sent back to the builder: ${failed.length} acceptance check${failed.length === 1 ? "" : "s"} failed on the final code`);
        } else {
          if (failed.length || unverified) {
            task.acceptanceBlocked = true;
            this.k.log(task, "warn", unverified
              ? "Acceptance could not be fully verified, so the decision goes to you"
              : "Acceptance still fails: the builder returns are used up, so the decision goes to you");
          }
          const gate = stages.findIndex((entry) => entry.kind === "gate" && entry.gate === "delivery");
          task.stageIndex = gate >= 0 ? gate : task.stageIndex + 1;
        }
        task.sub = 0;
        this.k.commit();
        return "continue";
      }
    } else {
      const result = await this.turns.turn(task, roleId, profileId, sections, NotesResult, signal, { used });
      const handed = { ...(task.repositories && role?.canEdit ? { productId: task.productId } : {}), at: Date.now(), profileId: by, stageId: stage.id, roleId, roleName: task.conversation?.role?.name ?? role?.name ?? roleId, title: stage.title, summary: result.summary, notes: result.notes };
      task.handedBack = [...(task.handedBack ?? []).filter((entry) => entry.stageId !== stage.id || entry.productId !== handed.productId), handed];
      this.k.say(task, "agent", [result.summary, ...result.notes.map((note) => `• ${note}`)].join("\n"), roleId, by);
      this.k.log(task, "done", `${role?.name ?? roleId} done: ${result.summary}`, roleId, by);
      endAgentStep(task, { outcome: W.wroteNotes, reason: W.notesReady }, Date.now());
    }
    if (role?.result !== "build") await this.k.saveRoleEdits(task, roleId, by);
    this.k.finishStep(task);
    this.k.tracking.endStage(task, "done");
    if (this.k.rerun(task)) return "continue";
    if (task.repositories && role?.canEdit) {
      this.k.saveRepository(task);
      await invalidateAcceptance(task);
      const own = task.repositories.find((work) => work.productId === task.productId)!;
      if (!task.repair) own.completedStages = [...new Set([...own.completedStages, stage.id])];
      if (task.repair) {
        task.repair.index += 1;
        if (task.repair.index < task.repair.products.length) {
          this.k.selectRepository(task, task.repair.products[task.repair.index]!);
          task.fixing = true;
          this.k.commitNow();
          return "continue";
        }
        if (task.repair.kind === "acceptance") task.retest = true;
        task.stageIndex = task.repair.returnStage;
        delete task.repair;
        task.sub = 0;
        this.k.commitNow();
        return "continue";
      }
      const next = task.repositories.find((work) => !work.completedStages.includes(stage.id));
      if (next) { this.k.selectRepository(task, next.productId); this.k.commitNow(); return "continue"; }
    }
    task.stageIndex += 1;
    task.sub = 0;
    this.k.commit();
    return "continue";
  }
}
