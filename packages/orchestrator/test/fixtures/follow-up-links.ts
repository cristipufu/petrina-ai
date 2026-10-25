import { BUILT_IN_ROLES, DEFAULT_PROFILES, createTaskState, matchPrompt, roleForTask, type DeepMutable, type Finding, type Id, type MatchAnswer, type NewTaskInput, type Product } from "@petrina/core";
import { FollowUpLinks } from "../../src/follow-up-links.js";
import type { FollowUpLinkHost, FollowUpLinkState } from "../../src/ports/follow-up-links.js";
import { ReviewReports } from "../../src/review-reports.js";
import { VerifierBallots } from "../../src/verifier-ballots.js";
import type { RuntimeTask } from "../../src/model.js";
import { restoreRepositoryState } from "../../src/repository-context.js";

export const STEPS = "Open the page and choose About.";
export const EVIDENCE = "The same retired page opened on the previous version.";
export const STAGE = { id: "review", kind: "review-chain" as const, title: "Review", roleId: "code-reviewer", profileIds: ["opus-high", "sol-high"], maxRounds: 2 };

export function older(id: string, text: string, extra: Partial<Finding> = {}): DeepMutable<Finding> {
  return { id, text, severity: "pre-existing", status: "open", raisedBy: "opus-high", roleId: "code-reviewer", confirmedBy: [], steps: STEPS, evidence: EVIDENCE, ...structuredClone(extra) } as DeepMutable<Finding>;
}

/** Explicit identity answers only; the actual application controller decides which credits may land. */
export function groupByBug(prompt: string): MatchAnswer {
  const reports = [...prompt.matchAll(/^- Report \[([^\]]+)\]\n  Problem: (.*)$/gm)];
  const cards = [...prompt.matchAll(/^- Card \[([^\]]+)\]: (.*)$/gm)];
  const bugOf = (text: string) => /^bug-([a-z0-9]+)/.exec(text)?.[1];
  const grouped = new Map<string, string[]>();
  for (const match of reports) {
    const bug = bugOf(match[2] ?? "");
    if (!bug) continue;
    grouped.set(bug, [...(grouped.get(bug) ?? []), match[1]!]);
  }
  return { groups: [...grouped].map(([bug, keys]) => {
    const card = cards.find(entry => bugOf(entry[2] ?? "") === bug);
    return card ? { keys, cardId: card[1]! } : { keys };
  }) };
}

/** Private records/effects. It makes no filesystem, SQLite, scheduling or native-session claim. */
export function followUpLinksFixture(answer: (prompt: string) => MatchAnswer | Promise<MatchAnswer> = groupByBug, withNotes = false) {
  const products: DeepMutable<Product>[] = [{ id: "shop", name: "Shop", repo: "local/shop", tone: "blue" }, ...(withNotes ? [{ id: "notes", name: "Notes", repo: "local/notes", tone: "green" as const }] : [])];
  const state: FollowUpLinkState = { tasks: [], products };
  const archived = new Map<Id, RuntimeTask>(), holds = new Map<Id, number>(), prompts: string[] = [], effects: string[] = [];
  let sequence = 0, stopped = false;
  const now = () => 1_000_000;
  const id = (prefix: string) => `${prefix}-${++sequence}`;
  const task = (id: Id) => state.tasks.find(task => task.id === id) ?? archived.get(id);
  const unexpected = (name: string): never => { throw new Error(`Unexpected follow-up effect: ${name}`); };
  const host: FollowUpLinkHost = {
    current: () => state, task, stopped: () => stopped, id, now,
    hold(id) { holds.set(id, (holds.get(id) ?? 0) + 1); return () => { const left = holds.get(id)! - 1; if (left) holds.set(id, left); else holds.delete(id); }; },
    track: work => work, taskIdTaken: id => !!task(id),
    checkpoint() { effects.push("checkpoint"); }, changed(task) { effects.push(`changed:${task.id}`); }, saveArchived(task) { archived.set(task.id, task); effects.push(`archive:${task.id}`); },
    atomic: work => work(),
    async match(ask) { const prompt = matchPrompt(ask); prompts.push(prompt); return answer(prompt); },
    picturePresent: () => unexpected("picture presence"), keepPicture: async () => unexpected("picture copy"), dropCreditedPicture: () => unexpected("credited picture removal"), discardPreparedPicture: async () => unexpected("prepared picture rollback"),
  };
  const links = new FollowUpLinks(host);
  const newTask = (input: NewTaskInput): RuntimeTask => {
    const value = createTaskState(input, products, { id: id("task"), timelineId: id("created"), now: now(), priority: state.tasks.length });
    restoreRepositoryState(value); state.tasks.push(value); return value;
  };
  const taskOf = (productId: Id, title: string, findings: DeepMutable<Finding>[]) => {
    const value = newTask({ productId, title, description: "Look at an older bug", backlog: true });
    value.findings = findings; value.rounds = { review: 1 }; return value;
  };
  const finish = (task: RuntimeTask) => { task.state = "done"; task.column = "done"; task.finishedAt = now(); return links.noteDone(task); };
  const cards = () => state.tasks.filter(task => task.followUp);
  const reports = new ReviewReports({ roles: () => BUILT_IN_ROLES, hasPendingReviewers: () => unexpected("review settlement"), id: task => id(task.id), now, verdict() {}, note() {} });
  const profiles = DEFAULT_PROFILES;
  const ballots = new VerifierBallots({ profile: id => profiles.find(profile => profile.id === id), profileName: id => id, toolName: id => id, roleResult: (id, task) => roleForTask(BUILT_IN_ROLES, id, task)?.result },
    { candidates: () => ["sol-high", "grok-high"], resolve: (_task, id) => { const profile = profiles.find(profile => profile.id === id); if (!profile) return unexpected(`profile ${id}`); return { kind: "selected", profile }; }, admissionsClosed: () => false },
    { checkpoint() {}, changed() {}, note() {}, now });
  return { state, products, host, links, task, newTask, taskOf, finish, cards, reports, ballots, prompts, effects, holds, now, shop: "shop", notes: withNotes ? "notes" : "",
    cardFor: (bug: string) => cards().filter(task => task.title.startsWith(`bug-${bug}`)),
    archiveObservation(value: RuntimeTask) { archived.set(value.id, value); state.tasks = state.tasks.filter(task => task !== value); },
    stop() { stopped = true; return links.stop(); },
  };
}
