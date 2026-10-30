import {
  acceptsAnswer,
  authorProfile,
  ballotOf,
  choosePanel,
  decide,
  endAgentStep,
  engagedTools,
  findingCount,
  findingsNeedingVotes,
  inBallot,
  isRejectedReopenOfVerifiedFix,
  JOURNEY_WORDS,
  openStep,
  panelAnswers,
  planThirdAnswers,
  recordStepResult,
  replacementFor,
  reviewedCode,
  seatRemaining,
  type DeepMutable,
  type Finding,
  type Hunt,
  type Id,
  type PanelCandidate,
  type Stage,
  type Task,
  type VerifierPanel,
  type VerifierSeat,
  type Vote
} from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import type { PendingVerification, VerifierAnswerSource, VerifierCatalog, VerifierRecording, VerifierSelection, VerifierVerdict } from "./ports/verifiers.js";

const listWords = (names: readonly string[]) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
const VERDICT_WORDS: Record<Vote["verdict"], string> = {
  real: "real",
  "not-a-bug": "not a bug",
  nit: "only a nit",
  "pre-existing": "an older bug unrelated to the approved task"
};

/** Saved ballot phases and replacements; native selection, transport and persistence remain effects. */
export class VerifierBallots {
  constructor(private readonly catalog: VerifierCatalog, private readonly selection: VerifierSelection, private readonly recording: VerifierRecording) {}

  /** Save partial or corrected answers before the caller asks for the rest; no unassigned answer counts. */
  recordAnswers(task: RuntimeTask, source: VerifierAnswerSource, verdicts: readonly VerifierVerdict[]): void {
    const toolId = this.catalog.profile(source.profileId)?.toolId;
    if (!toolId || !task.hunt) throw new Error("A verifier answer needs its recorded participant and active ballot.");
    const hunt = task.hunt;
    const assigned = new Set(source.findingIds);
    const older = hunt.panel?.rule === "majority";
    for (const verdict of verdicts) {
      const finding = task.findings.find(entry => entry.id === verdict.id && assigned.has(entry.id));
      if (!finding) continue;
      if (hunt.panel && !acceptsAnswer(hunt.panel, source.place, finding, hunt, toolId)) continue;
      const previous = finding.votes?.findLast(vote => vote.toolId === toolId && (older || (vote.ballot?.seat === source.place.key && inBallot(vote, hunt))));
      if (previous?.by === source.profileId && previous.verdict === verdict.verdict && previous.reason === verdict.reason) continue;
      finding.votes = [
        ...(finding.votes ?? []),
        {
        by: source.profileId,
        toolId,
        plannedProfileId: source.plannedProfileId,
        verdict: verdict.verdict,
        reason: verdict.reason,
        ballot: ballotOf(
        hunt,
        source.place.key
      )
      }
      ];
    }
    recordStepResult(task, { findings: task.findings.filter(finding => assigned.has(finding.id)) });
    this.recording.checkpoint(task);
  }

  /** Settle the completed ballot, retaining historical reasons and unavailable third answers. */
  finish(task: RuntimeTask, pending: PendingVerification): string {
    const ids = new Set(pending.findings.map(finding => finding.id));
    const panel = task.hunt?.panel ?? pending.panel;
    const at = this.recording.now();
    let real = 0;
    let disputed = 0;
    let unresolved = 0;
    for (const finding of task.findings.filter(entry => ids.has(entry.id))) {
      if (!panel || !task.hunt) continue;
      const decision = decide(panel, panelAnswers(panel, finding, task.hunt));
      if (!decision) continue;
      if (decision.verdict === "third") {
        finding.unresolved = {
          at,
          reason: panel.escalations?.[finding.id]?.reason ?? "Both answers said it does not block, and the required third answer could not be had: it stays Important, unresolved.",
          ...reviewedCode(task.hunt)
        };
        unresolved += 1;
        continue;
      }
      if (decision.verdict === "real") {
        real += 1;
        if (decision.disputed.length) disputed += 1;
        const dispute = decision.disputed.map(vote => `${this.catalog.profileName(vote.by)} answered ${VERDICT_WORDS[vote.verdict]}: ${vote.reason}`).join(" ");
        finding.verification = {
          by: decision.vote.by,
          verdict: "real",
          reason: dispute ? `${decision.vote.reason} Disputed: ${dispute}` : decision.vote.reason,
          at
        };
        continue;
      }
      finding.verification = { by: decision.vote.by, verdict: decision.verdict, reason: decision.vote.reason, at };
      if (decision.verdict === "not-a-bug") finding.status = isRejectedReopenOfVerifiedFix(finding) ? "fixed" : "dismissed";
      else if (decision.verdict === "nit") finding.severity = "suggestion";
      else finding.severity = "pre-existing";
    }
    const checked = task.findings.filter(finding => ids.has(finding.id));
    recordStepResult(task, { findings: checked, findingsSettled: true });
    const oneTool = panel?.rule === "bounded" && panel.usable.length === 1;
    const outcome = JOURNEY_WORDS.voted(checked, { disputed, oneTool });
    this.recording.note(task, real || unresolved ? "warn" : "done", outcome);
    this.recording.changed(task);
    return outcome;
  }

  /** A vote's places are its step's expected seats, named by place: recorded on the open vote step, never on an ended one. */
  private syncVoterSeats(task: RuntimeTask, seats: readonly VerifierSeat[]): void {
    const step = openStep(task);
    if (step?.kind === "agent" && step.roleId && this.catalog.roleResult(
      step.roleId,
      task
    ) === "votes") step.seats = seats.map((seat) => `verifier:${seat.key}`);
  }

  /**
   * The Important findings to check (raised by a reviewer and not yet backed on a second tool), and the places to admit
   * next. A new ballot saves its bounded panel before anyone starts; the initial places finish first, then targeted third
   * answers, each set in its own journey step.
   */
  next(task: RuntimeTask, stage: Stage): PendingVerification | undefined {
    const hunt = task.hunt;
    const eligible = findingsNeedingVotes(task, id => this.catalog.profile(id)?.toolId);
    let panel: VerifierPanel | undefined = hunt?.panel;
    if (!panel && hunt?.voterProfiles?.length && eligible.length) {
      // An older round admitted one voter per tool: it keeps its places and majority rule until it finishes.
      hunt.panel = this.olderPanel(task, eligible) as DeepMutable<VerifierPanel>;
      panel = hunt.panel;
      delete hunt.voterProfiles;
      delete hunt.voterReplacements;
      this.recording.checkpoint(task);
    }
    if (!panel) {
      if (!eligible.length) return undefined;
      const chosen = this.newPanel(task, stage, eligible);
      if (!chosen) {
        // Nobody can vote yet: leave the panel open until at least one tool is usable, and keep the review waiting.
        const waiting = this.selection.candidates(stage)[0];
        return {
          findings: eligible,
          seats: waiting ? [{
          key: waiting,
          profileId: waiting,
          toolId: this.catalog.profile(waiting)?.toolId ?? "",
          findingIds: eligible.map((finding) => finding.id),
          reason: ""
        }] : [],
          voters: waiting ? [waiting] : []
        };
      }
      panel = chosen.panel;
      // A paused scheduler may ask who would run next before tool checks finish.
      // Keep that preview provisional until work can start; an existing ballot stays durable.
      if (hunt && !this.selection.admissionsClosed(task)) {
        chosen.keep();
        hunt.panel = panel as DeepMutable<VerifierPanel>;
        this.syncVoterSeats(task, panel.seats);
        this.recording.note(
          task,
          "milestone",
          `${panel.seats.length === 1 ? "Verifier" : "Verifiers"}: ${listWords(panel.seats.map((seat) => this.catalog.profileName(seat.profileId)))} check ${findingCount(eligible)}; usable at selection: ${listWords(panel.usable.map((tool) => this.toolName(tool)))}`
        );
        this.recording.checkpoint(task);
      }
    }
    const ids = new Set(panel.seats.flatMap((seat) => seat.findingIds));
    // A finding that became eligible while the initial places still work joins their assignment; it never waits for a later round.
    const joining = eligible.filter((finding) => !ids.has(finding.id));
    if (joining.length && hunt?.panel === panel && panel.escalatedAt === undefined && !this.selection.admissionsClosed(task)) {
      for (const seat of panel.seats as DeepMutable<VerifierSeat>[]) seat.findingIds = [...seat.findingIds, ...joining.map((finding) => finding.id)];
      for (const finding of joining) ids.add(finding.id);
      this.recording.checkpoint(task);
    }
    const findings = task.findings.filter((finding) => ids.has(finding.id) && finding.status === "open" && !finding.verification && !finding.unresolved);
    if (!findings.length) return undefined;
    // Before the round saves its state, the preview reads answers as this stage and round's.
    const ballot = hunt ?? { stageId: stage.id, round: task.rounds[stage.id] ?? 1 };
    const remaining = (seat: VerifierSeat) => seatRemaining(panel, seat, findings, ballot).length > 0;
    const admit = (
      seats: VerifierSeat[],
      phase: VerifierSeat[],
      third?: boolean
    ): PendingVerification => ({
      findings: findings as Task["findings"],
      panel,
      seats,
      voters: seats.map((seat) => this.voterOn(
      task,
      seat
    )),
      phase,
      ...(third ? { third } : {})
    });
    const initial = panel.seats.filter((seat) => !seat.third);
    if (initial.some(remaining)) {
      if (hunt?.panel === panel && !this.selection.admissionsClosed(task)) this.replaceStalled(task, stage, panel, findings, initial);
      return admit(initial.filter(remaining), initial);
    }
    if (panel.rule === "bounded" && panel.escalatedAt === undefined) {
      const plan = this.thirdAnswers(task, stage, panel, findings, ballot);
      if (hunt?.panel !== panel || this.selection.admissionsClosed(task)) return admit(plan.seats, plan.seats, true);
      this.escalate(task, panel, findings, plan);
    }
    const third = panel.seats.filter((seat) => seat.third);
    if (third.some(remaining) && hunt?.panel === panel && !this.selection.admissionsClosed(task)) this.replaceStalled(task, stage, panel, findings, third);
    return admit(third.filter(remaining), third, true);
  }

  private toolName(toolId: Id): string {
    return this.catalog.toolName(toolId);
  }

  /** The actual tool of a finding's author, or of the reviewer whose current reproduction reopened it. Unknown stays unknown. */
  private authorTool(finding: Finding): Id | undefined {
    const author = authorProfile(finding);
    return author ? this.catalog.profile(author)?.toolId : undefined;
  }

  /** The tools a verifier choice resolves on now, one per actual tool, in the stable order: stand-ins on the same tool included. */
  private usableVoters(task: RuntimeTask, stage: Stage): PanelCandidate[] {
    const tools = new Set<Id>();
    return this.selection.candidates(stage).flatMap((id) => {
      const choice = this.selection.resolve(task, id);
      if (!choice || choice.kind !== "selected" || tools.has(choice.profile.toolId)) return [];
      tools.add(choice.profile.toolId);
      return [{ toolId: choice.profile.toolId, profileId: choice.profile.id, usableNow: true }];
    });
  }

  /**
   * A new ballot's bounded panel. Usage, model and capacity choices resolve first: a tool already unavailable is not
   * reserved for later, while a full slot still waits for its place. Answers this ballot already proved keep their places.
   */
  private newPanel(task: RuntimeTask, stage: Stage, findings: Task["findings"]): { panel: VerifierPanel; keep: () => void } | undefined {
    const recovered = this.recoveredAnswers(task, findings);
    const panel = choosePanel({
      candidates: this.usableVoters(task, stage),
      recovered: recovered.candidates,
      findings: findings.map((finding) => ({ id: finding.id, ...(this.authorTool(finding) ? { author: this.authorTool(finding)! } : {}) })),
      name: (tool) => this.toolName(tool),
    });
    return panel ? { panel, keep: recovered.keep } : undefined;
  }

  /**
   * Answers to this stage, round and reviewed code saved before a panel was: they count before more work is chosen.
   * An older answer without ballot details counts only when this round's own vote step recorded it on this input.
   */
  private recoveredAnswers(task: RuntimeTask, findings: Task["findings"]): { candidates: PanelCandidate[]; keep: () => void } {
    const hunt = task.hunt;
    if (!hunt) return { candidates: [], keep: () => {} };
    const recorded = (finding: Finding, vote: Vote) => !!hunt.input?.digest && (task.journey ?? []).some((step) => step.stageId === hunt.stageId && step.round === hunt.round && step.reviewInput?.digest === hunt.input!.digest && this.catalog.roleResult(
      step.roleId ?? "",
      task
    ) === "votes" &&
      [
        ...(step.result?.findings ?? []),
        ...(step.agentResults ?? []).flatMap((entry) => entry.findings ?? [])
      ].some((copy) => copy.id === finding.id && copy.votes?.some((saved) => !saved.ballot && saved.toolId === vote.toolId && saved.by === vote.by && saved.verdict === vote.verdict && saved.reason === vote.reason)));
    const proven = (finding: Finding, vote: Vote) => !!vote.toolId && (vote.ballot ? inBallot(vote, hunt) : recorded(finding, vote));
    const places = new Map<Id, Id>();
    for (const finding of findings) for (const vote of finding.votes ?? []) if (proven(
      finding,
      vote
    ) && !places.has(vote.toolId!)) places.set(
      vote.toolId!,
      vote.plannedProfileId ?? vote.by
    );
    return {
      candidates: [...places].map(([toolId, profileId]) => ({ toolId, profileId })),
      // Proven answers are attributed to their tool's kept place, so the saved panel counts them as this ballot's.
      keep: () => {
        for (const finding of findings) if (finding.votes?.some((vote) => proven(
          finding,
          vote
        ))) finding.votes = finding.votes.map((vote) => proven(
          finding,
          vote
        ) ? {
          ...vote,
          ballot: ballotOf(
          hunt,
          places.get(vote.toolId!)!
        )
        } : vote);
      },
    };
  }

  /** An older round's saved electorate, as places with its original majority rule. */
  private olderPanel(task: RuntimeTask, findings: Task["findings"]): VerifierPanel {
    const hunt = task.hunt!;
    const planned = hunt.voterProfiles!;
    const toolOf = (id: Id) => this.catalog.profile(id)?.toolId ?? id;
    return {
      rule: "majority",
      usable: [...new Set(planned.map(toolOf))],
      seats: planned.map((id) => ({
        key: id,
        profileId: id,
        toolId: toolOf(id),
        findingIds: findings.map((finding) => finding.id),
        reason: "Kept the place this ballot admitted before bounded panels, with its original rule.",
        ...(hunt.voterReplacements?.[id] ? { replaced: hunt.voterReplacements[id]! } : {})
      })),
    };
  }

  /** The profile that would start on a place now: a same-tool model stand-in, or the planned profile while it waits. */
  private voterOn(task: RuntimeTask, seat: VerifierSeat): Id {
    const choice = this.selection.resolve(task, seat.profileId);
    // A full model keeps this tool's seat. The vote waits instead of settling on the other tools.
    if (choice?.kind === "capacity") return seat.profileId;
    // Once admitted, a missing independent tool cannot be replaced by a finished partner's answer.
    return choice && choice.kind === "selected" && choice.profile.toolId === seat.toolId ? choice.profile.id : seat.profileId;
  }

  /**
   * A place whose tool cannot continue may move to a currently usable tool independent of every finding it still owes,
   * preferring tools that reported none of them. A cap, a pause or a drain never makes a usable place disappear,
   * a completed partner never covers it, and its saved answers remain. `phase`: every place of one step. Each place keeps
   * its own seat, conversation and working copy, so a tool that finished another place may take this one; a tool still
   * working another unfinished place finishes that first.
   */
  private replaceStalled(task: RuntimeTask, stage: Stage, panel: VerifierPanel, findings: Task["findings"], phase: readonly VerifierSeat[]): void {
    const hunt = task.hunt!;
    let changed = false;
    for (const seat of phase as DeepMutable<VerifierSeat>[]) {
      const owed = seatRemaining(panel, seat, findings, hunt);
      if (!owed.length) continue;
      const choice = this.selection.resolve(task, seat.profileId);
      if (choice?.kind === "capacity") continue;
      if (choice && choice.kind === "selected" && choice.profile.toolId === seat.toolId) continue;
      const busy = new Set(phase.filter((other) => other !== seat && seatRemaining(panel, other, findings, hunt).length).map((other) => other.toolId));
      const alternatives = this.usableVoters(task, stage).filter((candidate) => candidate.toolId !== seat.toolId && !busy.has(candidate.toolId));
      const replacement = replacementFor(
        owed,
        (id) => engagedTools(
        panel,
        findings.find((finding) => finding.id === id)!,
        hunt,
        seat
      ),
        alternatives,
        owed.map((id) => panel.authors?.[id])
      );
      if (!replacement) continue;
      const reason = `${this.catalog.profileName(seat.profileId)} could not finish verification (${choice && choice.kind !== "selected" ? choice.waiting : "selection did not retain its tool"}). ${this.catalog.profileName(replacement.profileId)} takes its required seat on a different tool; saved votes remain.`;
      seat.replaced = { from: seat.profileId, reason };
      seat.profileId = replacement.profileId;
      seat.toolId = replacement.toolId;
      this.recording.note(task, "milestone", reason);
      changed = true;
    }
    if (!changed) return;
    this.syncVoterSeats(task, phase);
    this.recording.checkpoint(task);
  }

  /** The findings whose two completed answers both said they do not block, and who gives each its third answer. */
  private thirdAnswers(task: RuntimeTask, stage: Stage, panel: VerifierPanel, findings: Task["findings"], ballot: Pick<Hunt, "stageId" | "round" | "input">) {
    const needs = findings.flatMap((finding) => {
      const answers = panelAnswers(panel, finding, ballot);
      return decide(
        panel,
        answers
      )?.verdict === "third" ? [{
        id: finding.id,
        answered: answers.map((vote) => vote.toolId!),
        ...(panel.authors?.[finding.id] ? { author: panel.authors[finding.id]! } : {})
      }] : [];
    });
    if (!needs.length) return { seats: [], escalations: {} };
    // Any ready tool that has not answered a finding may give its third answer when it can start now. Only a tool
    // usable when the panel was saved is waited for: one already left out then is never a required tie-breaker.
    const tools = new Set<Id>();
    const suppliers = this.selection.candidates(stage).flatMap((id) => {
      const toolId = this.catalog.profile(id)?.toolId;
      if (!toolId || tools.has(toolId)) return [];
      tools.add(toolId);
      const choice = this.selection.resolve(task, id);
      const usableNow = !!choice && choice.kind === "selected" && choice.profile.toolId === toolId;
      if (!usableNow && !panel.usable.includes(toolId)) return [];
      return [{ toolId, profileId: usableNow ? choice.profile.id : id, usableNow }];
    });
    return planThirdAnswers({ findings: needs, suppliers, name: (tool) => this.toolName(tool) });
  }

  /** Save the third answers once the initial places finished, and close the first pair's step with what it decided. */
  private escalate(task: RuntimeTask, panel: VerifierPanel, findings: Task["findings"], plan: ReturnType<VerifierBallots["thirdAnswers"]>): void {
    const hunt = task.hunt!;
    const saved = panel as DeepMutable<VerifierPanel>;
    saved.seats = [...saved.seats, ...plan.seats as DeepMutable<VerifierSeat>[]];
    saved.escalatedAt = this.recording.now();
    if (Object.keys(plan.escalations).length) saved.escalations = plan.escalations;
    // A third place is named on its own and starts clean, never in an earlier place's conversation.
    for (const seat of plan.seats) {
      if (hunt.work) delete hunt.work[`verifier:${seat.key}`];
      if (hunt.screenTurns) delete hunt.screenTurns[`vote-${seat.key}`];
    }
    const voting = (entry: { roleId: Id }) => this.catalog.roleResult(entry.roleId, task) === "votes";
    if (plan.seats.length) {
      task.capacityResume = task.capacityResume?.filter((entry) => !voting(entry));
      task.capacityRetries = task.capacityRetries?.filter((entry) => !voting(entry));
      task.capacityPaused = task.capacityPaused?.filter((entry) => !voting(entry));
    }
    for (const [id, escalation] of Object.entries(plan.escalations)) this.recording.note(
      task,
      escalation.unresolved ? "warn" : "milestone",
      `${findings.find((finding) => finding.id === id)?.text.slice(0, 80) ?? id}: ${escalation.reason}`
    );
    const asked = plan.seats.reduce((count, seat) => count + seat.findingIds.length, 0);
    const open = openStep(task);
    if (asked && open?.kind === "agent" && open.roleId && this.catalog.roleResult(open.roleId, task) === "votes") {
      const real = findings.filter((finding) => decide(panel, panelAnswers(panel, finding, hunt))?.verdict === "real").length;
      endAgentStep(
        task,
        {
        outcome: JOURNEY_WORDS.firstAnswers(
        findings.length,
        real,
        Object.keys(plan.escalations).length
      ),
        reason: JOURNEY_WORDS.thirdAnswer(asked)
      },
        this.recording.now()
      );
    }
    this.recording.checkpoint(task);
  }

}
