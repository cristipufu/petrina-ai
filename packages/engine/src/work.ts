// "do" stages: one role on one profile. The builder answers findings, brings work up to date and writes a pull
// request's description, and Petrina keeps its work as one commit; the tester checks acceptance, and any other
// role hands back notes. The delivery step is Petrina's own (shipping.ts).

import type { Task } from "@petrina/core";
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
    const profileId = stage.profileIds[0] ?? "opus-xhigh";
    const role = this.k.role(roleId);
    const sections = () => this.context.sectionsFor(task, roleId);

    if (roleId === "builder") {
      if (task.miss) await this.guide.proposeGuideLine(task, signal);
      const updating = task.updating;
      if (updating) await this.updates.reopen(task);
      // In a fix round the builder answers every finding it was given, by id.
      const given = task.fixing ? task.findings.filter((finding) => finding.status === "open" && finding.severity !== "pre-existing") : [];
      // Fix rounds and updates go back to its own conversation, except when it is asked to step back and rethink.
      const own = task.builderSession;
      const back = (task.fixing || updating) && own?.stageId === stage.id && own.profileId === profileId && !(task.fixing && stepBack(task as unknown as Task)) ? own : undefined;
      const result = await this.turns.turn(task, roleId, profileId, sections, BuildResult, signal, {
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
      this.learnings.note(task, result.learnings, roleId, profileId);
      // One commit per task: the builder's work joins the branch's one commit, under its title.
      const sha = await git.commitAll(task.worktree!, this.updates.message(task));
      if (updating) {
        // Up to date now. The change itself was reviewed already: the next review round looks only at the port.
        delete task.updating;
        delete task.reviewedSha;
        delete task.hunt;
        if (updating.head) task.portReview = { from: updating.from, head: updating.head, onto: updating.onto, files: updating.files };
        this.k.log(task, "done", `Brought up to date with main: ${result.summary}`, roleId, profileId);
      }
      await this.updates.fold(task);
      // The next fix round or update goes back to this conversation.
      const conversation = task.conversation;
      if (conversation?.briefed && conversation.roleId === roleId) task.builderSession = { stageId: stage.id, profileId, toolId: conversation.toolId, model: conversation.model, sessionId: conversation.sessionId };
      if (task.fixing) {
        const at = Date.now();
        for (const answer of result.answers) {
          const finding = given.find((entry) => entry.id === answer.id && entry.status === "open");
          if (!finding) continue;
          finding.answer = { fixed: answer.fixed, text: answer.text, at };
          if (answer.fixed) finding.status = "fixed";
        }
        task.fixing = false;
      }
      if (!updating) this.k.log(task, "done", sha ? `Build done: ${result.summary}` : "Build done, with no changes to the code", roleId, profileId);
    } else if (roleId === "tester") {
      const result = await this.turns.turn(task, roleId, profileId, sections, TestResult, signal);
      this.learnings.note(task, result.learnings, roleId, profileId);
      if (task.brief) task.brief.acceptance = task.brief.acceptance.map((item) => ({ ...item, met: result.checks.find((check) => check.text === item.text)?.pass ?? item.met }));
      const failed = result.checks.filter((check) => !check.pass);
      for (const check of failed) task.findings.push({ id: this.k.id(task.id), text: `Failed acceptance check: ${check.text}`, severity: "blocking", raisedBy: profileId, confirmedBy: [], status: "open" });
      this.k.log(task, failed.length ? "warn" : "done", failed.length ? `${failed.length} acceptance check${failed.length === 1 ? "" : "s"} failed` : result.summary, roleId, profileId);
    } else {
      const result = await this.turns.turn(task, roleId, profileId, sections, NotesResult, signal);
      this.k.say(task, "agent", [result.summary, ...result.notes.map((note) => `• ${note}`)].join("\n"), roleId, profileId);
      this.k.log(task, "done", `${role?.name ?? roleId} done: ${result.summary}`, roleId, profileId);
    }
    if (role && !role.canEdit && task.worktree && !(await git.isClean(task.worktree))) {
      await git.discardChanges(task.worktree);
      this.k.log(task, "warn", `Undid changes from ${role.name}, which is read-only`);
    }
    this.k.finishStep(task);
    this.k.tracking.endStage(task, "done");
    if (this.k.rerun(task)) return "continue";
    task.stageIndex += 1;
    task.sub = 0;
    this.k.commit();
    return "continue";
  }
}
