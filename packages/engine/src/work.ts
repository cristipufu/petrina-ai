// "do" stages: one role on one profile. The builder commits and answers findings, the shipper delivers,
// the tester checks acceptance, and any other role hands back notes.

import type { Task } from "@petrina/core";
import * as git from "./git.js";
import { formatFindings } from "./prompts.js";
import { BuildResult, NotesResult, ShipResult, TestResult } from "./roles.js";
import { Kernel, type MStage, type MTask } from "./kernel.js";
import type { Turns } from "./turn.js";
import type { Context } from "./context.js";
import type { GuideKeeper } from "./guide-keeper.js";
import type { Shipping } from "./shipping.js";

export class Work {
  constructor(private readonly k: Kernel, private readonly turns: Turns, private readonly context: Context, private readonly guide: GuideKeeper, private readonly shipping: Shipping) {}

  async runDo(task: MTask, stage: MStage, signal: AbortSignal): Promise<"continue" | "stop"> {
    const roleId = stage.roleId;
    const profileId = stage.profileIds[0] ?? "opus-xhigh";
    const role = this.k.role(roleId);
    const sections = () => this.context.sectionsFor(task, roleId);

    if (roleId === "builder") {
      if (task.miss) await this.guide.proposeGuideLine(task, signal);
      // In a fix round the builder answers every finding it was given, by id.
      const given = task.fixing ? task.findings.filter((finding) => finding.status === "open" && finding.severity !== "pre-existing") : [];
      const result = await this.turns.turn(task, roleId, profileId, sections, BuildResult, signal, {
        check: (value) => {
          const missing = given.filter((finding) => !value.answers.some((answer) => answer.id === finding.id));
          return missing.length ? `answer every finding by id in "answers" (fixed, or not fixed and why), and these have none:\n${formatFindings(missing as Task["findings"])}` : undefined;
        },
      });
      const label = this.k.describe(roleId, profileId);
      const sha = await git.commitAll(task.worktree!, `${task.title}${task.fixing ? " (review fixes)" : ""}\n\n${result.summary}\n\n${result.changes.map((change) => `- ${change}`).join("\n")}\n\nBuilt by Petrina: ${label}`);
      task.report = { summary: result.summary, changes: result.changes, ...(result.tests ? { tests: result.tests } : {}) };
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
      this.k.log(task, "done", sha ? `Build done: ${result.summary}` : "Build done, with no changes to the code", roleId, profileId);
    } else if (roleId === "shipper") {
      // Shipping is never repeated blindly: after an interruption, look for the delivery first.
      if (task.shipping && !task.shipping.again) return this.shipping.checkDelivery(task, signal);
      await this.shipping.startShipping(task, signal);
      const result = await this.turns.turn(task, roleId, profileId, sections, ShipResult, signal);
      await this.shipping.verifyDelivery(task, result);
      return "stop";
    } else if (roleId === "tester") {
      const result = await this.turns.turn(task, roleId, profileId, sections, TestResult, signal);
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
    if (this.k.rerun(task)) return "continue";
    task.stageIndex += 1;
    task.sub = 0;
    this.k.commit();
    return "continue";
  }
}
