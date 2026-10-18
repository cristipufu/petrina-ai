import { deliveryLabel, workSummary, type WorkChoice, type TaskSource } from "./source.js";
// A deterministic stand-in for real agents. It drives the same state the real engine
// will: tasks move through their plan, agents report status lines, ask questions,
// request permissions, raise objections and findings, and wait at gates.
// The UI uses it today; the tests use it to pin down scheduling and gate rules.

import { answerByCall, CALL_WORDS, callCheckBody, callOn, dueAnswers, followingCall, type CallAnswer } from "./call.js";
import {
  addAsk,
  AFTER_WORDS,
  beginAgentStep,
  beginPetrinaStep,
  beginYouStep,
  endAgentStep,
  endOpenStep,
  endPetrinaStep,
  endYouStep,
  JOURNEY_WORDS as W,
  openStep,
  recordStepResult,
  settleAsk,
  stepTag,
  syncWait,
  withdrawAsks,
} from "./journey.js";
import { CLEANUP_WORDS, copyNoLongerNeeded } from "./cleanup.js";
import { composePlan } from "./library.js";
import { queueNeighbour, queuePlacement } from "./navigation.js";
import type {
  ActiveAgent,
  CheckRun,
  Column,
  DeliveryMode,
  DesignBrief,
  DesignCall,
  GateKind,
  Id,
  InboxItem,
  InboxKind,
  Objection,
  Product,
  Role,
  RoleChanges,
  ScreenMode,
  Stage,
  State,
  Task,
  TaskKind,
} from "./model.js";
import { balanced, extraSlot, pickStarts, queueOf, slotUses, slotWait, type Candidate } from "./scheduler.js";
import { afterChangesAsked, columnOf, designRoundEnd, gateStatus, gateTitle, noteRoundEnd, reviewRoundEnd, type DeepMutable } from "./flow.js";
import { findingCount } from "./findings.js";
import type { NewTaskInput } from "./commands.js";
import * as library from "./roles.js";
import type { RoleDraft } from "./roles.js";
import { onScreen, SCREEN_HOUR_MS, SCREEN_WORDS, screenAllowed, screenMode, screenQueue, screenReady, screenReason, screenWait } from "./screen.js";
import { productHistory, validateProductSettings, type ProductSettings } from "./products.js";
import { usageView, type UsageRequest, type UsageViewFor } from "./analytics.js";
import { askMomentId, MemoryWorkLog, turnTokens, type AskAnswer, type MomentOutcome, type TurnEnd, type TurnReason, type TurnReport, type WorkMoment, type WorkStageKind } from "./worklog.js";
import { SETUP_STEPS, type SetupStep } from "./setup.js";
import { MAX_STEP_RECORDS, pauseClock, plainTodo, resumeClock, startClock, stepRecord } from "./summary.js";
import { demoHistoryPage, type HistoryQuery } from "./history.js";

type Draft = DeepMutable<State>;
type DraftTask = DeepMutable<Task>;

/** A scripted moment where an agent stops and asks the coordinator something. `screen`: it needs the screen, for `title`. */
export interface Trigger {
  kind: "question" | "permission" | "screen";
  title: string;
  body?: string;
  options?: readonly string[];
  detail?: string;
}

/** Keyed by `taskId|roleId|round|item`: the agent stops when it starts that item of its to-do list. */
export type Triggers = Readonly<Record<string, Trigger>>;

/** How the simulated tools behave for one agent (keyed by `taskId|roleId`), so the demos show every case. */
export interface SimQuirk {
  /** Only for agents on this tool. */
  toolId?: Id;
  /** What the tool actually ran, when it differs from the profile. */
  ran?: { model: string; name: string; effort: string };
  /** The tool changed model or effort during the agent's first turn. */
  changedTo?: { model?: string; effort?: string };
  /** The tool never said what the session ran on. */
  notConfirmed?: boolean;
  /** Codex: helper agents started in the first turn, whose use Codex doesn't report. */
  helpers?: number;
  /** The first turn ends without a token report. */
  noTokens?: boolean;
  /** Claude Code sent only its main figure, without the per-model breakdown. */
  noBreakdown?: boolean;
  /** Claude Code: a second model in the breakdown (a helper agent or compaction). */
  extraModel?: string;
}

/** Turns and stages still open when a simulator stops, so another one can pick them up. */
export interface SimOpenWork {
  turns: readonly [Id, { id: Id; startedAt: number; waitedMs: number; waitingSince?: number; first: boolean }][];
  stages: readonly [Id, { stageId: Id; title: string; kind: WorkStageKind; roleId: Id; round: number; startedAt: number }][];
  runs: readonly [Id, number][];
}

export interface SimOptions {
  triggers?: Triggers;
  /** Work another simulator left open (the demos fast-forward tasks one by one). */
  open?: SimOpenWork;
  /** The work log the simulator writes. A fresh one by default. */
  log?: MemoryWorkLog;
  quirks?: Readonly<Record<string, SimQuirk>>;
  /** Ticks a pull request stays open before the simulated coordinator merges it on GitHub. */
  prMergeAfter?: number;
  /** Milliseconds of simulated time per tick when no clock value is given. */
  tickMs?: number;
  /** Tasks whose design reviewer keeps objecting every round, so the architects end up disagreeing. */
  disagree?: readonly Id[];
  /** Tasks whose working copy cannot be removed at the first try, so Petrina tries again a tick later. */
  lockedCopies?: readonly Id[];
}

/** A new task for the demo: the window's, plus the area its scripted agents talk about. */
export interface NewTask extends NewTaskInput {
  area?: string;
}

export type MessageMode = "queue" | "interrupt";

const PLANNER_PROFILE = "sonnet-medium";
/** Requests are logged when raised and completed by an answer, as the engine does. */
const ASKS: ReadonlySet<string> = new Set(["question", "permission", "plan", "design", "delivery", "disagreement"]);
const DEMO_RISK: Record<TaskKind, { level: "low" | "medium" | "high"; why: string }> = {
  new: { level: "high", why: "A new product: everything it touches is new, sign-in included." },
  feature: { level: "medium", why: "New behaviour in one part of the product." },
  bug: { level: "medium", why: "A fix to how people sign in and pay, in one place." },
  chore: { level: "low", why: "Only words and styles change: nothing can be lost or opened up." },
};
const DEMO_CHECKS: CheckRun[] = [
  { name: "Type check", command: "bun run typecheck", ok: true, ms: 9_000, output: "No errors." },
  { name: "Tests", command: "bun run test", ok: true, ms: 41_000, output: "212 pass\n0 fail\nRan 212 tests across 31 files." },
  { name: "Build", command: "bun run build", ok: true, ms: 23_000, output: "Built in 22.4s." },
];

interface ScriptContext {
  area: string;
  product: string;
  round: number;
  fixing: boolean;
  /** The architect is following the coordinator's call. */
  following: boolean;
  /** The design reviewer keeps objecting every round. */
  objecting: boolean;
}

/** One item of an agent's to-do list, with the actions it takes under it ("Reading the code", "Editing files"). */
type Item = readonly [todo: string, ...actions: string[]];

/** One moment of a scripted agent: it starts the next item of its to-do list, or takes an action under it. */
type Moment = { todo: string } | { action: string };

/** What each role works on, as its own to-do list in plain language, and what it does under each item. */
function itemsFor(role: Role | undefined, ctx: ScriptContext): Item[] {
  const { area, product, round, fixing, following, objecting } = ctx;
  if (role?.added) return role.result === "findings"
    ? [["Reading the design and the acceptance checklist", "Reading the task", "Reading the brief"], [`Going through the change to ${area}`, "Reading the code", "Searching the code"], ["Writing findings", "Writing up the review", "Findings ready"]]
    : [[`Reading what the task needs from the ${role.name.toLowerCase()}`, "Reading the task", "Reading the brief"], [`Working on ${area}`, "Reading the code", "Thinking it through"], ["Writing notes for the squad", "Writing up the notes", "Notes ready"]];
  switch (role?.id) {
    // Only a release has one: Petrina sets the version and publishes it (see `ship`).
    case "release-manager":
      return [
        ["Reading every commit since the previous release", "Reading the release history", "Reading the changes"],
        ["Grouping the changes: new, improved, fixed", "Thinking it through", "Sorting 12 changes"],
        ["Writing the release notes", "Writing up the changes", "Release notes ready"],
      ];
    case "planner":
      return [[`Looking at how ${product} is organised`, "Reading the code", "Searching the code"], ["Choosing who should work on this", "Reading the available roles", "Thinking it through"], ["Writing the plan", "Writing up the stages", "Plan ready"]];
    case "researcher":
      return [[`Looking at how other products handle ${area}`, "Looking something up", "Reading 4 articles"], [`Collecting what users expect from ${area}`, "Reading the research", "Thinking it through"], ["Writing research notes", "Writing up the findings", "Research notes ready"]];
    case "architect":
      if (following) return [["Reading your call", "Reading the brief", "Reading the objections"], [`Updating the ${area} flow to follow it`, "Thinking it through", "Writing the brief"], ["Answering each open objection", "Writing up the answers", "Brief follows your call"]];
      return round === 1
        ? [[`Reading the parts of ${product} this touches`, "Reading the code", "Searching the code"], [`Sketching the ${area} flow`, "Reading the brief", "Thinking it through"], ["Writing the acceptance checklist", "Checking the task", "Writing the brief"], ["Getting the brief ready for review", "Checking the brief", "Design brief ready for review"]]
        : [["Reading the objections", "Reading the brief", "Reading the code"], [`Reworking the ${area} flow`, "Thinking it through", "Writing the brief"], ["Answering each objection", "Writing up the answers", "Updated brief ready"]];
    case "design-reviewer":
      return round === 1
        ? [["Reading the design brief", "Reading the task", "Reading the brief"], [`Looking for gaps in the ${area} flow`, "Reading the code", "Thinking it through"], ["Writing objections", "Writing up the findings", "Objections ready"]]
        : [["Reading the updated brief", "Reading the brief", "Reading the objections"], ["Checking the answer to each objection", "Reading the code", "Thinking it through"], objecting ? ["Writing objections", "Writing up the findings", "Objections ready"] : ["Wrapping up the review", "Checking the answers", "Nothing blocking left"]];
    case "ux-designer":
      return [[`Sketching the ${area} screens`, "Reading the code", "Drawing 3 screens"], ["Checking contrast, spacing and wording", "Reading the brief", "Thinking it through"], ["Writing UI notes", "Writing up the screens", "UI notes ready"]];
    case "builder":
      return fixing
        ? [["Reading the review findings", "Reading the brief", "Reading the code"], ["Fixing the blocking issue", "Editing files", "Running the tests"], ["Checking the fixes", "Ran the tests: 44 passed", "Fixes ready for review"]]
        : [
            ["Setting up a fresh working copy", "Reading the task", "Running a command"],
            [`Updating the ${area} screens`, "Reading the code", "Editing 3 files"],
            [`Connecting ${area} to the backend`, "Searching the code", "Editing files"],
            [`Writing tests for ${area}`, "Editing files", "Ran the tests: 42 passed"],
            ["Writing up the change for review", "Reading the changes", "Change ready for review"],
          ];
    case "tester":
      return [["Starting the app", "Reading the brief", "Running a command"], [`Going through ${area} like a user would`, "Checking the screens", "Took 4 screenshots"], ["Checking every acceptance item", "Running the checks", "Every acceptance check passes"]];
    case "code-reviewer":
      return round === 1
        ? [["Reading the design and the acceptance checklist", "Reading the task", "Reading the brief"], ["Trying to prove “done” wrong", "Reading the code", "Running the tests"], ["Checking no test was weakened or skipped", "Reading the changes", "Searching the code"], ["Writing findings", "Writing up the review", "Findings ready"]]
        : [["Checking the fixes", "Reading the changes", "Reading the code"], ["Re-running the acceptance checks", "Running the tests", "Passed"]];
    default:
      return [["Working", "Reading the task", "Thinking it through"]];
  }
}

/** Every moment of a scripted agent's step, in order. */
function scriptFor(role: Role | undefined, ctx: ScriptContext): Moment[] {
  return itemsFor(role, ctx).flatMap(([todo, ...actions]): Moment[] => [{ todo }, ...actions.map((action) => ({ action }))]);
}

/** What a design reviewer that keeps objecting raises after the first round. */
function laterObjections(area: string, round: number): { text: string; blocking: boolean }[] {
  return round === 2
    ? [
        { blocking: true, text: `The updated brief still does not say what people see in ${area} when a step fails.` },
        { blocking: false, text: `Show progress in ${area} so people know how much is left.` },
      ]
    : [
        { blocking: true, text: `The answer for existing accounts adds a confirmation step to ${area} that slows everyone down.` },
        { blocking: false, text: "Consider a short note telling existing users what changed." },
      ];
}

type Verdict = "accepted" | "rejected";
type Point = Pick<Objection, "id" | "text" | "blocking">;

/** These reply labels still refer to the side, not an objection's subject. */
const REPLY = "(?:['’]s\\s+(?:answers?|notes?|confirmations?)\\b)?";
/** "Accept" or "reject" (of the architect's points, the other way round), or siding with either side. */
const VERDICT = new RegExp(`\\b(accept|reject)(?:s|ed|ing)?\\b(\\s+(?:the\\s+)?(?:design\\s+)?architect\\b${REPLY})?|\\b(sid(?:e|es|ed|ing)\\s+)?with\\s+(?:the\\s+)?(?:design\\s+)?(reviewer|architect)\\b${REPLY}`, "g");
/** Where a sentence breaks into clauses: punctuation, and the words that start a new clause. */
const CLAUSE = /[,:()]|\s[–—-]\s|\s(?=(?:and|plus|but|or|so|because|while|whereas|though|although|since|yet|unless|if|when|whenever|where|whether|then|except|rather\s+than|instead\s+of|apart\s+from|other\s+than)\b)/g;
/** "All but the note" says "all except the note". */
const ALL_BUT = /\b(all|everything|them|points|objections|rest)\s+but\b/g;
/** A clause that sets points apart from the decision it goes with: "not the minor one", "except the note". */
const APART = /^\s*(?:(?:and|but|or)\s+)?(?:not\b(?![\s-]+blocking)|never\b|except(?:\s+for)?\b|apart\s+from\b|other\s+than\b|rather\s+than\b|instead\s+of\b)/;
/** A clause that adds points to the decision before it: "and the minor one". */
const LIST = /^\s*(?:and|plus)\b/;
/** "And the architect to review it" mentions them. It is not a side and it does not name a point. */
const ASIDE_MENTION = /\b(?:reviewer|architect)\s+(?:for|about|to)\b/;
/**
 * A second side with its own point continues the decision: "and the architect on the blocking one",
 * or their answer, note or confirmation with "on", "about", "for" or "to". A side still being taken
 * also names its point with "for" or "about". Accept or reject does not: "and the architect for the
 * blocking one" after those stays a mention.
 */
const PERSON = "(?:the\\s+)?(?:design\\s+)?(?:reviewer|architect)";
const REPLY_WORD = "['’]s\\s+(?:answers?|notes?|confirmations?)";
const SIDE_PREP = "on|about|for|to";
const SIDE_TOPIC = new RegExp(`^(\\s*(?:and|plus)\\s+)(${PERSON}(?:${REPLY_WORD}\\s+(?:${SIDE_PREP})|\\s+on)\\b)`);
const SIDE_CONTINUED = new RegExp(`^(\\s*(?:and|plus)\\s+)(${PERSON}(?:${REPLY_WORD}\\s+(?:${SIDE_PREP})|\\s+(?:on|about|for))\\b)`);
/** A clause that leaves open what it names: "or the minor one", "if the step is optional". */
const OPEN = /^\s*(?:or|if|unless|when|whenever|where|whether)\b/;
/** Words just before a decision that turn it round: "don't accept", "never reject", "refuse to accept". */
const NEGATED = /(?:\bnot|\bnever|\bcannot|n['’]t|\brefuse[sd]?\s+to|\brather\s+than|\binstead\s+of)\s+(?:(?:ever|to)\s+)?$/;
/** Other negatives and words for only some of the points leave a decision unclear. */
const UNCLEAR = /\b(?:not|no|none|neither|nor|never|nothing|cannot|without|refuse[sd]?|against|any|some|most|few|half|partly|partially)\b|n['’]t\b|\bone\s+of\b/;
/**
 * Doubt, alternatives and conditions qualify the whole sentence, including a detached aside.
 * "Either way" is emphasis, like "regardless". "While" is a condition unless it starts another
 * decision ("while rejecting", "while accepting", "while siding", "while keeping"). "While the
 * note stays", "while it remains" and "while the note is optional" decide nothing, and "stays"
 * inside a parallel decision does not.
 */
const WHILE_ACTION = "accepting|rejecting|siding|keeping";
const UNCERTAIN = new RegExp(`\\b(?:either(?!\\s+way\\b)|or|alternatively|maybe|perhaps|possibly|might|may|if|unless|when|whenever|where|whether|provided|assuming)\\b|\\b(?:in\\s+case|as\\s+long\\s+as)\\b|\\bwhile\\b(?!\\s+(?:${WHILE_ACTION})\\b)`);
/**
 * Words that leave the choice open. Modifiers and the contractions "it's" / "it’s" use the same
 * rule as "it is". A relative description directly on a named point is handled separately below;
 * a detached "that is optional" or "which helps" still leaves the decision open.
 */
const OPEN_STATE = "(?:(?:still|now)\\s+)?(?:left\\s+open|(?:an?\\s+)?(?:optional(?:\\s+choice)?|open(?:\\s+question)?))";
const OPEN_SAYING = `(?:(?:is|are|remains|stays)\\s+${OPEN_STATE}|(?:(?:still|now)\\s+)?helps)`;
const POINT_DETAIL = new RegExp(`\\b(?:that|which)\\s+(?:(?:still|now)\\s+)?${OPEN_SAYING}\\b`, "g");
const ACTION_OPEN = new RegExp(`\\b(?:${OPEN_SAYING}|optionally)\\b`);
/** These complete phrases reinforce a decision after its point or just before a directive. */
const EMPHASIS_WORDS = "(?:in\\s+any\\s+case|no\\s+matter\\s+what|without\\s+exception)";
const EMPHASIS = new RegExp(`\\b${EMPHASIS_WORDS}\\b(?=[\\s.!?;,:()–—-]*$|\\s+(?:(?:do\\s+)?not\\s+|never\\s+|don't\\s+)?(?:accept|reject|side\\s+with)\\b)`, "g");
/** An aside in commas, parentheses or dashes must not separate "not" or "never" from its decision. */
const EMPHASIS_ASIDE = new RegExp(`,\\s*${EMPHASIS_WORDS}\\s*,|\\(\\s*${EMPHASIS_WORDS}\\s*\\)|\\s[–—-]\\s+${EMPHASIS_WORDS}\\s+[–—-](?=\\s|$)`, "g");
/** A complete "whether or not ... stays" aside says the decision does not depend on it staying. */
const INDEPENDENT = /(?:,\s*|\s+)whether\s+or\s+not\s+(.+?)\s+stays\b(?=[\s.!?;]*$|\s*,)/;
/** Words for every point. */
const EVERY = /\b(?:all|both|everything|every|each|them|rest|others|points|objections)\b/;
/** "Every one of the points" and "each single one of them" mean all, rather than the uncertain "one of them". */
const EVERY_ONE = /\b(every|each)\s+(?:(?:single|last)\s+)?one\s+of\s+(?:them|the\s+(?:points|objections))\b/g;
const NOT_BLOCKING = /\bnot[\s-]+blocking\b|\bnon[\s-]*blocking\b|\bminor\b|\bsuggestions?\b|\bnice[\s-]+to[\s-]+have\b/g;
const BLOCKING = /\bblock(?:ing|ers?)\b/;
/** Words a name for points can have besides the points' own words: "the minor one", "the point about", "the rest". */
const NAMING = new Set(["a", "an", "the", "and", "plus", "also", "too", "as", "well", "both", "one", "ones", "point", "points", "objection", "objections", "issue", "about", "for", "of", "on", "in", "to", "with", "its", "s", "reviewer", "architect", "minor", "blocking", "blocker", "blockers", "non", "suggestion", "suggestions", "nice", "have", "only", "just", "all", "everything", "else", "rest", "other", "others"]);
/** Words in the reviewer's objections that never name one: everyday words, and words about the brief rather than its subject. */
const PLAIN = ["already", "answer", "brief", "changed", "consider", "does", "down", "everyone", "happens", "have", "know", "last", "left", "much", "people", "show", "still", "that", "this", "updated", "what", "when"];

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
/** Two words that stand for each other: the same, or one is the other with more letters ("note" and "notes"). */
const same = (word: string, other: string): boolean => word.startsWith(other) || other.startsWith(word);

/**
 * How the demo architect reads the coordinator's words: the objections they plainly decide, each accepted or
 * rejected. Anything it cannot read for sure it leaves alone, so a misreading is never taken for the call.
 *
 * Each "accept" or "reject" (of the reviewer's points; of the architect's, the other way round), or siding with the
 * reviewer or the architect, decides the points its clause names: by "blocking", by "minor" or "not blocking", or by
 * a word only that point uses (never the feature's name). "All", "both" or "the rest", and siding that names no
 * point, decide what the sentence leaves. A clause with no decision only adds to the one before it when it is just
 * a name: "and the short note" adds it, as does "and the note about what changed" ("and the rest" adds what is left),
 * "not the minor one", "except the note" or "all but the note" give it the other decision, and a name before a decision
 * says what it is about ("Regarding the blocking point, reject it"). Punctuation can separate a decision from its point,
 * and a second side with its own point continues the decision ("and the architect on the blocking one", and "for" or
 * "about" when the side continues, or their answer, note or confirmation "on", "about", "for" or "to" a point).
 * Mentioning the architect "to", "for" or "about" something, without continuing a side or that reply, is not a side.
 * Any other clause only explains. "Not", "never" or "refuse to" just before a decision
 * turns it round. A decision that names no point decides nothing ("I accept that"), and a sentence decides nothing when
 * any part of it is unclear: a question, other negatives ("accept neither"), some of the points ("one of them"), "or",
 * doubt or a condition ("while the note stays", "while it remains", "rejecting it is optional", "it is optional to reject", "it's optional to reject", "optionally reject", "rejecting it is open", "which is optional", "that is optional" after a comma, "while keeping that helps"; "while rejecting", "the note that helps", "the note which helps", "the point that still helps" and "either way" are not), or two decisions
 * for the same point. Later sentences win over earlier ones; "it" in a later decision refers to the preceding
 * sentence's single decided point. An unclear reference
 * withdraws the earlier decisions it could mean.
 */
export function readCall(words: string, objections: readonly Point[], area: string): Map<Id, Verdict> {
  const plain = [...PLAIN, ...wordsOf(area)];
  const known = objections.flatMap((objection) => wordsOf(objection.text));
  const marks = new Map(
    objections.map((objection) => {
      const others = objections.filter((other) => other.id !== objection.id).flatMap((other) => wordsOf(other.text));
      return [objection.id, wordsOf(objection.text).filter((word) => ![...plain, ...others].some((other) => same(word, other)))];
    }),
  );
  /** The points a clause names. Naming the kind wins, and its words only narrow it down; words alone that name more than one leave it unclear. */
  const named = (clause: string): Point[] | undefined => {
    const rest = clause.replace(NOT_BLOCKING, " ");
    const said = wordsOf(clause);
    const kinds = objections.filter((objection) => (objection.blocking ? BLOCKING.test(rest) : rest !== clause));
    const marked = objections.filter((objection) => marks.get(objection.id)!.some((word) => said.some((other) => same(word, other))));
    const both = kinds.filter((objection) => marked.includes(objection));
    return both.length ? both : kinds.length ? kinds : marked.length > 1 ? undefined : marked;
  };
  /**
   * A bare name uses the objection's words (or their plurals), never verb prefixes like "shorten" for "short".
   * Ordinary words may follow "about": "the note about what changed".
   */
  const nameOnly = (clause: string) => {
    const words: string[] = clause.match(/[a-z]+/g) ?? [];
    const about = words.indexOf("about");
    const described = about < 0 ? undefined : named(clause);
    const ownWord = (word: string) => word.length >= 4 && !PLAIN.includes(word) && known.some((other) => word === other || `${word}s` === other || word === `${other}s`);
    const ordinary = (word: string, index: number) => !!described?.length && index > about && described.some((point) => wordsOf(point.text).includes(word));
    return words.every((word, index) => NAMING.has(word) || ownWord(word) || ordinary(word, index));
  };
  /**
   * Descriptions use the same point names as decisions and lists, including "confirmation step"
   * or "suggestion". Only a name touching "that/which" can own the description: punctuation or
   * a verb between them leaves it about the choice. Remove it once, before reading any clauses,
   * so joined names and exceptions work exactly like their plain counterparts.
   */
  const withoutPointDetails = (sentence: string) => sentence.replace(POINT_DETAIL, (detail, at: number) => {
    const before = sentence.slice(0, at).match(/(?:[a-z]+\s+)+$/)?.[0].trim().split(/\s+/) ?? [];
    const describesPoint = before.some((_, index) => {
      const name = before.slice(index).join(" ");
      return nameOnly(name) && !!named(name)?.length;
    });
    return describesPoint ? " " : detail;
  });
  const decided = new Map<Id, Verdict>();
  let previous: Point[] = [];
  for (const sentence of words.toLowerCase().match(/[^.!?;\n]+[.!?;\n]*/g) ?? []) {
    // A following alternative withdraws the preceding sentence's decisions too.
    if (/^\s*(?:or|alternatively)\b/.test(sentence)) {
      for (const point of previous) decided.delete(point.id);
      previous = [];
      continue;
    }
    if (sentence.includes("?")) {
      previous = [];
      continue;
    }
    // The sentence in pieces: a clause without a decision, or one decision with its part of the clause.
    const described = withoutPointDetails(sentence.replace(/\bit['’]s\b/g, "it is"));
    const aside = described.match(INDEPENDENT)?.[1];
    const independent = aside === "it" || (aside && nameOnly(aside) && !!named(aside)?.length);
    const text = described
      .replace(ALL_BUT, "$1 except")
      .replace(EVERY_ONE, "$1")
      .replace(EMPHASIS_ASIDE, " ")
      .replace(EMPHASIS, " ")
      .replace(INDEPENDENT, (clause) => independent ? " " : clause);
    const starts = [0, ...[...text.matchAll(CLAUSE)].map((cut) => cut.index! + cut[0].length)];
    const pieces: { text: string; verdict?: Verdict; siding?: boolean; unclear?: boolean; refers?: boolean; needsPoint?: boolean }[] = [];
    let siding = false;
    let continuation: string | undefined;
    starts.forEach((start, at) => {
      const raw = text.slice(start, starts[at + 1]);
      // Emphasis can end a clause too; an exception after "without exception" is still unclear.
      const following = starts[at + 1] === undefined ? "" : text.slice(starts[at + 1], starts[at + 2]);
      const emphasized = APART.test(following) && ![...following.matchAll(VERDICT)].length ? raw : raw.replace(EMPHASIS, " ");
      const continuedSide = /^(?:not\s+)?side with$/.test(continuation ?? "");
      const joining = continuedSide ? SIDE_CONTINUED : SIDE_TOPIC;
      const clause = continuation
        ? emphasized.replace(joining, (_match, join: string, words: string) => `${join}${continuation} ${words}`)
        : emphasized;
      const verbs = [...clause.matchAll(VERDICT)].filter((verb) => {
        siding ||= !!verb[3];
        // "But with the architect" continues siding; "after talking with the architect" does not.
        const prefix = clause.slice(0, verb.index).replace(NEGATED, "");
        return !!verb[1] || !!verb[3] || (siding && /^\s*(?:(?:and|plus|but)\s+)?$/.test(prefix));
      });
      if (!verbs.length) pieces.push({ text: clause });
      const cuts = verbs.map((verb, nth) => (nth === 0 ? 0 : verb.index! - (clause.slice(0, verb.index).match(NEGATED)?.[0].length ?? 0)));
      verbs.forEach((verb, nth) => {
        const part = clause.slice(cuts[nth], cuts[nth + 1]);
        const at = verb.index! - cuts[nth]!;
        const turned = part.slice(0, at).match(NEGATED)?.[0] ?? "";
        const besides = `${part.slice(0, at - turned.length)} ${part.slice(at + verb[0].length)}`.replace(NOT_BLOCKING, " ");
        const accepts = (verb[1] === "accept") !== !!verb[2] || verb[4] === "reviewer";
        const object = part.slice(at + verb[0].length);
        const refers = !!verb[1] && !verb[2] && /^\s+it[^\w]*$/.test(object);
        // Reply labels belong to the side, not the point: the architect's "notes" do not name the short note.
        pieces.push({ text: `${part.slice(0, at)} ${object}`, verdict: accepts !== !!turned ? "accepted" : "rejected", siding: !verb[1], unclear: UNCLEAR.test(besides), refers, needsPoint: /^\s*(?:it\s*)?[,:()–—-][\s,:()–—-]*$/.test(object) });
        continuation = `${turned ? "not " : ""}${verb[1] ?? "side with"}`;
      });
    });
    const here = new Map<Id, Verdict>();
    const every = new Set<Verdict>();
    const referenced = new Set<Id>();
    // Removing the emphasis must not turn the contradictory "without exception, except ..." into a clear call.
    const openSaying = ACTION_OPEN.test(text);
    let unclear = UNCERTAIN.test(text) || openSaying || /\bwithout\s+exception\b[\s,:()–—-]*(?:except|apart\s+from|other\s+than)\b/.test(sentence);
    const decide = (points: readonly Point[] | undefined, verdict: Verdict) => {
      if (!points) unclear = true;
      for (const objection of points ?? []) {
        if (here.has(objection.id) && here.get(objection.id) !== verdict) unclear = true;
        here.set(objection.id, verdict);
      }
    };
    const first = pieces.findIndex((piece) => piece.verdict);
    const leading = new Map<number, string[]>();
    pieces.forEach((piece, at) => {
      const verdict = piece.verdict;
      if (!verdict) return;
      if (piece.unclear) unclear = true;
      const next = pieces.findIndex((other, later) => later > at && other.verdict);
      const before = at === first ? pieces.slice(0, at).map((other) => other.text) : leading.get(at) ?? [];
      let after = pieces.slice(at + 1, next < 0 ? undefined : next).map((other) => other.text);
      const hasTopic = before.some((clause) => nameOnly(clause.replace(/^\s*(?:(?:and|plus)\s+)?regarding\s+/, "")) && !!named(clause)?.length);
      // In "the minor one, side with the reviewer, and the blocking one, side with the architect",
      // the final bare name introduces the next side; it is not a list added to the previous one.
      if (next >= 0 && named(pieces[next]!.text)?.length === 0 && !EVERY.test(pieces[next]!.text) && (!piece.needsPoint || piece.siding || hasTopic)) {
        let boundary = after.length;
        while (boundary > 0) {
          const name = after[boundary - 1]!.replace(/^\s*(?:(?:and|plus)\s+)?regarding\s+/, "");
          if (APART.test(name) || OPEN.test(name) || !nameOnly(name)) break;
          boundary -= 1;
        }
        const introduction = after.slice(boundary);
        if (pieces[next]!.siding || hasTopic || introduction.some((clause) => /^\s*(?:(?:and|plus)\s+)?(?:for|regarding)\b/.test(clause))) {
          leading.set(next, introduction);
          after = after.slice(0, boundary);
        }
      }
      for (const clause of [...before, ...after]) {
        const name = clause.replace(APART, "");
        // An unfamiliar aside must not drop an earlier "don't" or "never" and reverse the decision.
        if (NEGATED.test(clause.replace(/[,:()–—\s-]+$/, " "))) unclear = true;
        if (name === clause || named(name)?.length === 0) continue;
        if (!nameOnly(name)) unclear = true;
        else decide(named(name), verdict === "accepted" ? "rejected" : "accepted");
      }
      const own = named(piece.text);
      const listed = after.filter((clause) => LIST.test(clause) && !APART.test(clause) && nameOnly(clause) && !ASIDE_MENTION.test(clause)).flatMap((clause) => named(clause) ?? []);
      const topic = before.map((clause) => clause.replace(/^\s*(?:(?:and|plus)\s+)?regarding\s+/, "")).filter((clause) => !APART.test(clause) && !OPEN.test(clause) && nameOnly(clause)).flatMap((clause) => named(clause) ?? []);
      // A name immediately after punctuation is still the decision's object, not an explanation.
      const adjacent = after.find((clause) => /[a-z]/.test(clause));
      const attached = own?.length === 0 && piece.needsPoint && adjacent && nameOnly(adjacent) ? named(adjacent) : [];
      let points = own === undefined || attached === undefined ? undefined : own.length || listed.length || attached.length ? [...own, ...listed, ...attached] : topic;
      if (points?.length === 0 && piece.refers) {
        const unambiguous = previous.length === 1 && [...before, ...after].every((clause) => named(clause)?.length === 0);
        for (const objection of unambiguous ? previous : objections) referenced.add(objection.id);
        points = unambiguous ? previous : undefined;
      }
      if (points?.length !== 0) decide(points, verdict);
      else if (piece.siding || EVERY.test(piece.text)) every.add(verdict);
      if (after.some((clause) => LIST.test(clause) && nameOnly(clause) && named(clause)?.length === 0 && EVERY.test(clause))) every.add(verdict);
    });
    if (unclear || every.size > 1) {
      for (const id of referenced) decided.delete(id);
      previous = [];
      continue;
    }
    for (const objection of objections) if (!here.has(objection.id) && every.size) here.set(objection.id, [...every][0]!);
    for (const [id, verdict] of here) decided.set(id, verdict);
    previous = objections.filter((objection) => here.has(objection.id));
  }
  return decided;
}

/**
 * How the demo architect answers the objections it owes after a call. The call decides those its words decide. The
 * architect answers the rest in its own name: blocking ones accepted, the others rejected. After changes asked for
 * at the check, the note's words can change any decision, and the other decisions stand.
 */
function callAnswers(area: string, due: readonly Objection[], call: string, note?: string): CallAnswer[] {
  const byCall = readCall(call, due, area);
  const byNote = note === undefined ? new Map<Id, Verdict>() : readCall(note, due, area);
  return due.map(({ id, blocking, status, call: tagged }): CallAnswer => {
    const corrected = byNote.get(id);
    if (corrected) return { id, status: corrected, byCall: tagged !== undefined, answer: corrected === "accepted" ? `Changed the ${area} flow in the brief to cover it, as your note says.` : `Took this out of the ${area} flow, as your note says.` };
    if (note !== undefined && (status === "accepted" || status === "rejected")) {
      const kept = tagged !== undefined;
      const answer =
        status === "accepted"
          ? kept ? `Changed the ${area} flow in the brief to your note, still following your call.` : `Changed the ${area} flow in the brief to your note. It still covers this.`
          : kept ? `Still left out of the ${area} flow after your note, as your call says.` : "Still out of scope after your note. Kept in risks.";
      return { id, status, byCall: kept, answer };
    }
    const decided = byCall.get(id);
    if (decided) return { id, status: decided, byCall: true, answer: decided === "accepted" ? `Changed the ${area} flow in the brief to follow your call.` : `Left this out of the ${area} flow, as your call says.` };
    return blocking
      ? { id, status: "accepted", byCall: false, answer: "Your call does not speak to this one. Changed the design to cover it." }
      : { id, status: "rejected", byCall: false, answer: "Out of scope for this task. Added to risks." };
  });
}

function briefFor(task: DraftTask): DeepMutable<DesignBrief> {
  return {
    summary: callOn(task as unknown as Task, task.stageIndex) ? `How ${task.area} should work after this change, following your call.` : `How ${task.area} should work after this change, agreed by both architects.`,
    forUsers: [`${capitalize(task.area)} works the way the task describes`, "Nothing changes for people who do not use it"],
    areas: [capitalize(task.area), "Settings"],
    acceptance: [
      { text: `A user can complete ${task.area} without help` },
      { text: "Existing users see no difference unless they opt in" },
      { text: "Works on phone-sized screens" },
    ],
    risks: ["Edge cases with very old accounts"],
  };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export class Simulator {
  private state: State;
  private readonly listeners = new Set<() => void>();
  private readonly triggers: Triggers;
  private readonly prMergeAfter: number;
  private readonly tickMs: number;
  private readonly work: MemoryWorkLog;
  private readonly quirks: Readonly<Record<string, SimQuirk>>;
  private readonly openTurns = new Map<Id, { id: Id; startedAt: number; waitedMs: number; waitingSince?: number; first: boolean }>();
  private readonly openStages = new Map<Id, { stageId: Id; title: string; kind: WorkStageKind; roleId: Id; round: number; startedAt: number }>();
  private readonly stageRuns = new Map<Id, number>();
  private serial = 0;
  private readonly disagree: ReadonlySet<Id>;
  private readonly lockedCopies: ReadonlySet<Id>;

  constructor(state: State, options: SimOptions = {}) {
    this.state = state;
    this.triggers = options.triggers ?? {};
    this.disagree = new Set(options.disagree ?? []);
    this.lockedCopies = new Set(options.lockedCopies ?? []);
    this.prMergeAfter = options.prMergeAfter ?? 12;
    this.tickMs = options.tickMs ?? 40_000;
    this.work = options.log ?? new MemoryWorkLog(state.work?.since ?? state.now);
    this.quirks = options.quirks ?? {};
    this.serial = this.work.size();
    for (const [taskId, turn] of options.open?.turns ?? []) this.openTurns.set(taskId, { ...turn });
    for (const [taskId, stage] of options.open?.stages ?? []) this.openStages.set(taskId, { ...stage });
    for (const [stageId, runs] of options.open?.runs ?? []) this.stageRuns.set(stageId, runs);
    if (!state.work) this.state = { ...state, work: { version: 0, since: this.work.since() } };
  }

  getState = (): State => this.state;

  /** The simulator's work log (the demos read and shape it). */
  get workLog(): MemoryWorkLog {
    return this.work;
  }

  /** What is still open, moved `delta` milliseconds in time. */
  openWork(delta = 0): SimOpenWork {
    return {
      turns: [...this.openTurns.entries()].map(([taskId, turn]) => [taskId, { ...turn, startedAt: turn.startedAt + delta, ...(turn.waitingSince !== undefined ? { waitingSince: turn.waitingSince + delta } : {}) }]),
      stages: [...this.openStages.entries()].map(([taskId, stage]) => [taskId, { ...stage, startedAt: stage.startedAt + delta }]),
      runs: [...this.stageRuns.entries()],
    };
  }

  /** The numbers for one view, the same way the engine works them out. */
  usage<R extends UsageRequest>(request: R): UsageViewFor<R> {
    return usageView(this.work, request, { now: this.state.now, state: this.state });
  }

  historyPage(query: HistoryQuery) { return demoHistoryPage(this.state, query); }
  taskDetails(taskId: Id): Task | undefined { return this.state.tasks.find((task) => task.id === taskId); }
  async previewImage(_taskId: Id, _path: string): Promise<{ mime: string; data: string }> {
    throw new Error("This image is unavailable in the demo.");
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Advance every running agent by one step, merge old pull requests, retry removing working copies, and start what fits in the pool. */
  tick(now?: number): void {
    this.update((d) => {
      d.now = now ?? d.now + this.tickMs;
      for (const task of d.tasks) {
        if (task.state === "running") this.step(d, task);
        else if (task.state === "pr-open" || (task.state === "cancelled" && task.pr?.state === "open")) this.agePullRequest(d, task);
        else if (task.cleanup?.error) this.removeCopy(d, task);
      }
      this.schedule(d);
    });
  }

  // ── Coordinator actions ────────────────────────────────────────────────────

  answer(itemId: Id, answer: string): void {
    this.resolve(itemId, (d, task, item) => {
      settleAsk(task, item.id, "answered", d.now, answer);
      this.say(d, task, "you", answer);
      this.log(d, task, "you", `You answered: ${answer}`);
      this.say(d, task, "agent", `Thanks. Going with: ${answer}.`, item.roleId, item.profileId);
      this.unblock(d, task);
    }, "answered");
  }

  /** The agent goes with its own recommendation (the first option). */
  decideForMe(itemId: Id): void {
    const item = this.state.inbox.find((entry) => entry.id === itemId);
    const pick = item?.options?.[0];
    if (!item || !pick) return;
    this.resolve(itemId, (d, task) => {
      settleAsk(task, itemId, "decided", d.now, pick);
      this.log(d, task, "you", `You let the agent decide. It chose: ${pick}`);
      this.say(d, task, "agent", `I'll go with: ${pick}.`, item.roleId, item.profileId);
      this.unblock(d, task);
    }, "decided");
  }

  allow(itemId: Id, _scope: "once" | "always" = "once"): void {
    this.resolve(itemId, (d, task, item) => {
      settleAsk(task, item.id, "allowed", d.now);
      this.log(d, task, "you", `You allowed: ${item.title}`);
      this.say(d, task, "agent", "Thanks, continuing.", item.roleId, item.profileId);
      this.unblock(d, task);
    }, "allowed");
  }

  deny(itemId: Id, note?: string): void {
    this.resolve(itemId, (d, task, item) => {
      settleAsk(task, item.id, "denied", d.now, note);
      this.log(d, task, "you", note ? `You said no: ${note}` : `You said no to: ${item.title}`);
      if (note) this.say(d, task, "you", note);
      this.say(d, task, "agent", "Understood. I'll find a way without it.", item.roleId, item.profileId);
      this.unblock(d, task);
    }, "denied");
  }

  /** Approve a gate (plan, design, delivery) or settle a disagreement with the architect's position. */
  approve(itemId: Id): void {
    this.resolve(itemId, (d, task, item) => {
      switch (item.kind) {
        case "plan":
          task.confirmWork = false;
          if (task.source) task.source.confirmed = true;
          this.log(d, task, "you", "You approved the plan");
          endYouStep(task, { outcome: W.approved, reason: W.youApproved }, d.now);
          this.continueAfterGate(d, task);
          break;
        case "design":
          this.log(d, task, "you", "You approved the design");
          endYouStep(task, { outcome: W.approved, reason: W.youApproved }, d.now);
          this.continueAfterGate(d, task);
          break;
        case "disagreement":
          this.log(d, task, "you", "You sided with the architect");
          endYouStep(task, { outcome: W.sided, reason: W.youSided }, d.now);
          for (const objection of task.objections) {
            if (objection.status !== "open") continue;
            objection.status = "rejected";
            objection.decidedBy = "coordinator";
          }
          task.brief = briefFor(task);
          this.advance(d, task);
          break;
        case "delivery":
          this.log(d, task, "you", "You approved the delivery");
          endYouStep(task, { outcome: W.approved, reason: W.youApproved }, d.now);
          // After review rounds ran out, the check was raised on the delivery stage itself.
          this.continueAfterGate(d, task, this.stage(task)?.kind === "gate");
          break;
        case "guide": {
          const product = d.products.find((entry) => entry.id === task.productId);
          if (product && item.body) product.reviewGuide = [...(product.reviewGuide ?? []), { text: item.body, at: d.now, fromTask: task.id }];
          this.log(d, task, "you", `You added to the review guide: ${item.body ?? ""}`);
          break;
        }
        case "learnings": {
          const product = d.products.find((entry) => entry.id === task.productId);
          const lessons = (item.body ?? "").split("\n").map((line) => line.replace(/^- /, "").trim()).filter(Boolean);
          if (product) product.learnings = [...(product.learnings ?? []), ...lessons.map((text) => ({ text, at: d.now, fromTask: task.id }))];
          this.log(d, task, "you", `You added ${lessons.length === 1 ? "a lesson" : `${lessons.length} lessons`} to AGENTS.md`);
          break;
        }
        case "screen":
          if (task.screen && !task.screen.granted) {
            task.screen.allowed = true;
            this.log(d, task, "you", SCREEN_WORDS.allowedNow);
          }
          break;
        default:
          break;
      }
    }, "approved");
  }

  /** "Add the ticked ones": the lessons of an offer the coordinator keeps, by their place in it. */
  addLessons(itemId: Id, keep: number[]): void {
    this.resolve(itemId, (d, task, item) => {
      const product = d.products.find((entry) => entry.id === task.productId);
      const lessons = (item.body ?? "")
        .split("\n")
        .map((line) => line.replace(/^- /, "").trim())
        .filter(Boolean)
        .filter((_, index) => keep.includes(index));
      if (product) product.learnings = [...(product.learnings ?? []), ...lessons.map((text) => ({ text, at: d.now, fromTask: task.id }))];
      this.log(d, task, "you", lessons.length ? `You added ${lessons.length === 1 ? "a lesson" : `${lessons.length} lessons`} to AGENTS.md` : "You left AGENTS.md as it is");
    });
  }

  /** "Not this time" on an offer: the review guide, or AGENTS.md, stays as it is. */
  decline(itemId: Id): void {
    this.resolve(itemId, (d, task, item) => this.log(d, task, "you", item.kind === "learnings" ? "You left AGENTS.md as it is" : "You left the review guide as it is"));
  }

  /**
   * Send a gate back with a note: the design goes back to the architects, a delivery back to the builder,
   * a plan back to the planner. On a disagreement the note is the coordinator's call, which settles the design.
   */
  requestChanges(itemId: Id, note: string): void {
    this.resolve(itemId, (d, task, item) => {
      const call = item.kind === "disagreement";
      this.log(d, task, "you", call ? CALL_WORDS.made(note) : `You asked for changes: ${note}`);
      this.say(d, task, "you", note);
      endYouStep(task, call ? { outcome: W.madeCall, reason: W.yourCall, tone: "back" } : { outcome: W.changes, reason: W.changesAsked, tone: "back" }, d.now);
      task.notes = [...(task.notes ?? []), { at: d.now, text: note }];
      afterChangesAsked(task, item.kind, note, d.now);
      task.state = "waiting";
      task.statusLine = "Waiting for a free slot";
      task.column = this.columnFor(d, task);
    }, "changes");
  }

  /** First run's demo: a product picked from the made-up clones. */
  addProduct(product: Product): void {
    this.update((d) => {
      if (d.products.some((entry) => entry.id === product.id)) return;
      d.products.push(JSON.parse(JSON.stringify(product)) as Draft["products"][number]);
      this.work.recordProduct({ id: product.id, name: product.name, repo: product.repo, addedAt: d.now });
      this.wrote(d);
    });
  }

  /** First run's demo: the furthest screen reached. */
  setSetupStep(step: SetupStep): void {
    const order = (value: SetupStep | undefined) => SETUP_STEPS.findIndex((entry) => entry.id === (value ?? "welcome"));
    this.update((d) => {
      if (d.setup && !d.setup.done && order(step) > order(d.setup.step)) d.setup.step = step;
    });
  }

  /** First run's demo: "Skip setup". */
  skipSetup(): void {
    this.update((d) => {
      if (d.setup) d.setup.done = true;
    });
  }

  /** First run's demo: Start adds the task and finishes setup. Sent again, it finds the same task. */
  startFirstTask(input: NewTask & { clientId: Id }): Id {
    const known = this.state.tasks.find((task) => task.clientId === input.clientId);
    if (known) return known.id;
    const id = this.addTask(input);
    this.update((d) => {
      const task = d.tasks.find((entry) => entry.id === id);
      if (task) task.clientId = input.clientId;
      if (d.setup) {
        d.setup.done = true;
        d.setup.firstTaskId ??= id;
      }
    });
    return id;
  }

  /** First run's demo: the board's one-time tip. */
  dismissTip(): void {
    this.update((d) => {
      if (d.setup) d.setup.tipDismissed = true;
    });
  }

  /** Change what "ready" means for a product, and whether the coordinator checks first. */
  setProductDelivery(productId: Id, delivery: DeliveryMode, approveDelivery: boolean): void {
    const product = this.state.products.find((entry) => entry.id === productId);
    if (product) this.updateProduct(productId, { name: product.name, delivery, approveDelivery });
  }

  updateProduct(productId: Id, settings: ProductSettings): void {
    const validated = validateProductSettings(settings, this.state.products, productId);
    this.update((d) => {
      const product = d.products.find((entry) => entry.id === productId);
      if (!product) throw new Error("This product is no longer in Petrina.");
      Object.assign(product, validated);
      // The permanent list keeps the latest name, so a removed product shows under the name it last had.
      this.work.recordProduct({ id: product.id, name: product.name, repo: product.repo });
    });
  }

  removeProduct(productId: Id): void {
    const { unfinished } = productHistory(this.state.tasks, productId);
    if (unfinished) throw new Error(`${unfinished} task${unfinished === 1 ? " must" : "s must"} finish or be cancelled before this product can be removed.`);
    this.update((d) => {
      const product = d.products.find((entry) => entry.id === productId);
      // Its entry stays, marked removed, so its history keeps its name and its id is never reused.
      if (product) this.work.recordProduct({ id: product.id, name: product.name, repo: product.repo, removedAt: d.now });
      const ids = new Set(d.tasks.filter((task) => task.productId === productId).map((task) => task.id));
      d.inbox = d.inbox.filter((item) => !ids.has(item.taskId));
      d.tasks = d.tasks.filter((task) => !ids.has(task.id));
      d.products = d.products.filter((entry) => entry.id !== productId);
      this.wrote(d);
    });
  }

  setToolCap(toolId: Id, cap: number): void {
    this.update((d) => {
      d.pool.toolCaps[toolId] = Math.max(1, Math.min(12, Math.round(cap)));
      this.schedule(d);
    });
  }

  setPoolLimit(limit: number): void {
    this.update((d) => {
      d.pool.limit = Math.max(1, Math.min(12, Math.round(limit)));
      this.schedule(d);
    });
  }

  setPoolPaused(paused: boolean): void {
    this.update((d) => {
      d.pool.paused = paused;
      this.schedule(d);
    });
  }

  /** "Agents may use the screen". Off never stops the agent on the screen; nobody new gets it. */
  setScreenUse(mode: ScreenMode): void {
    this.update((d) => {
      d.pool.screen = mode === "hour" ? { mode, until: d.now + SCREEN_HOUR_MS } : { mode };
      this.schedule(d);
    });
  }

  /** Allow now: this request may use the screen, one agent at a time. */
  allowScreen(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (!task.screen || task.screen.granted || task.screen.allowed) return;
      task.screen.allowed = true;
      this.log(d, task, "you", SCREEN_WORDS.allowedNow);
      this.schedule(d);
    });
  }

  /** "Allow the screen for this task", even while the switch is off. */
  setTaskScreen(taskId: Id, allowed: boolean): void {
    this.updateTask(taskId, (d, task) => {
      if (task.state === "done" || task.state === "cancelled" || (task.screenAllowed === true) === allowed) return;
      if (allowed) task.screenAllowed = true;
      else delete task.screenAllowed;
      this.log(d, task, "you", allowed ? SCREEN_WORDS.taskOn : SCREEN_WORDS.taskOff);
      this.schedule(d);
    });
  }

  /** Put a queued task at `index` in the queue (0 is the top). */
  moveInQueue(taskId: Id, index: number): void {
    this.update((d) => {
      const queue = queueOf(d.tasks as Task[]).map((task) => task.id);
      const from = queue.indexOf(taskId);
      if (from < 0) return;
      queue.splice(from, 1);
      queue.splice(Math.max(0, Math.min(queue.length, index)), 0, taskId);
      queue.forEach((id, position) => {
        const task = d.tasks.find((entry) => entry.id === id);
        if (task) task.priority = position;
      });
      this.schedule(d);
    });
  }

  moveToTop(taskId: Id): void {
    this.moveInQueue(taskId, 0);
  }

  placeInQueue(taskId: Id, anchorId: Id, side: "before" | "after"): number {
    const queue = queueOf(this.getState().tasks).map((task) => task.id);
    const index = queuePlacement(queue, taskId, anchorId, side);
    if (index === undefined) return -1;
    const hidden = Math.max(0, Math.abs(queue.indexOf(taskId) - queue.indexOf(anchorId)) - 1);
    this.moveInQueue(taskId, index);
    return hidden;
  }

  moveVisibleInQueue(taskId: Id, visibleIds: Id[], direction: -1 | 1): number {
    const queue = queueOf(this.getState().tasks).map((task) => task.id);
    const anchor = queueNeighbour(queue, visibleIds, taskId, direction);
    return anchor ? this.placeInQueue(taskId, anchor, direction < 0 ? "before" : "after") : -1;
  }

  setHeld(taskId: Id, held: boolean): void {
    this.updateTask(taskId, (d, task) => {
      task.held = held;
      this.log(d, task, "you", held ? "You put it on hold" : "You released the hold");
      this.schedule(d);
    });
  }

  /** Start this task only after the given tasks have landed. An empty list removes the wait. */
  setAfter(taskId: Id, after: readonly Id[]): void {
    const ids = [...new Set(after)];
    const state = this.state;
    if (!state.tasks.some((task) => task.id === taskId)) throw new Error("Unknown task");
    for (const id of ids) {
      if (id === taskId) throw new Error("A task cannot wait for itself");
      if (!state.tasks.some((task) => task.id === id)) throw new Error(`Unknown task: ${id}`);
    }
    // No loops: none of the tasks it waits for may (indirectly) wait for it.
    const reaches = (from: Id, seen = new Set<Id>()): boolean => {
      if (from === taskId) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return (state.tasks.find((task) => task.id === from)?.after ?? []).some((next) => reaches(next, seen));
    };
    if (ids.some((id) => reaches(id))) throw new Error("That would make tasks wait for each other");
    this.updateTask(taskId, (d, task) => {
      task.after = ids;
      const find = (id: Id) => d.tasks.find((entry) => entry.id === id);
      // The wait is a step of its own on the journey, so what is said about it belongs to it.
      syncWait(task, ids.map((id) => find(id)!).filter((other) => other.state !== "done" && other.state !== "cancelled"), find, d.now);
      this.log(d, task, "you", ids.length ? AFTER_WORDS.starts(ids.map((id) => find(id)!.title)) : AFTER_WORDS.none);
      this.schedule(d);
    });
  }

  pause(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (!["running", "needs-you", "waiting"].includes(task.state)) return;
      this.endTurn(d, task, "stopped");
      task.state = "paused";
      task.holdsSlot = false;
      // Resuming starts the step fresh.
      delete task.todo;
      delete task.stepClock;
      task.statusLine = "Paused by you";
      withdrawAsks(task, d.inbox.filter((item) => item.taskId === taskId && item.blocking).map((item) => item.id), d.now);
      this.releaseScreen(d, task);
      d.inbox = d.inbox.filter((item) => item.taskId !== taskId || !item.blocking);
      this.log(d, task, "you", "You paused it");
      this.schedule(d);
    });
  }

  resume(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      if (task.state !== "paused") return;
      const pendingGate = d.inbox.some((item) => item.taskId === task.id && !item.blocking);
      task.state = pendingGate ? "needs-you" : "waiting";
      task.statusLine = pendingGate ? "Waiting for you" : "Waiting for a free slot";
      this.log(d, task, "you", "You resumed it");
      this.schedule(d);
    });
  }

  cancel(taskId: Id): void {
    this.updateTask(taskId, (d, task) => {
      this.endTurn(d, task, "stopped");
      this.endStage(d, task, "cancelled");
      this.moment(d, task, { kind: "task-end", outcome: "cancelled" });
      task.state = "cancelled";
      task.column = "done";
      task.holdsSlot = false;
      delete task.agent;
      this.releaseScreen(d, task);
      delete task.todo;
      delete task.stepClock;
      task.finishedAt = d.now;
      task.statusLine = "Cancelled";
      d.inbox = d.inbox.filter((item) => item.taskId !== task.id);
      endOpenStep(task, { outcome: openStep(task)?.kind === "agent" ? W.stopped : W.cancelled, end: "cancelled" }, d.now);
      this.log(d, task, "you", "You cancelled it");
      // Only started tasks have a working copy to remove.
      if (task.startedAt !== undefined) this.removeCopy(d, task);
      this.schedule(d);
    });
  }

  /**
   * Message the agent working on a task. Queued messages are delivered when the agent
   * finishes its current step; an interrupt is delivered now.
   */
  sendMessage(taskId: Id, text: string, mode: MessageMode = "queue"): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.updateTask(taskId, (d, task) => {
      if (mode === "interrupt" && task.agent && task.state === "running") {
        this.say(d, task, "system", "You interrupted the current step");
        this.deliver(d, task, trimmed, true);
        return;
      }
      task.queued.push({ id: this.id(d, task.id), text: trimmed, at: d.now });
    });
  }

  removeQueued(taskId: Id, messageId: Id): void {
    this.updateTask(taskId, (_d, task) => {
      if (task.queued.some((message) => message.id === messageId && Object.values(message.recipients ?? {}).some(Boolean))) return;
      task.queued = task.queued.filter((message) => message.id !== messageId);
    });
  }

  /**
   * Swap the profile on a stage that has not started yet. `list` picks the author/doers
   * (`profileIds`) or the reviewers of a converge stage (`reviewerProfileIds`).
   */
  setStageProfile(taskId: Id, stageId: Id, list: "profileIds" | "reviewerProfileIds", index: number, profileId: Id): void {
    this.updateTask(taskId, (d, task) => {
      const at = task.plan?.stages.findIndex((stage) => stage.id === stageId) ?? -1;
      const stage = task.plan?.stages[at];
      if (!stage || at <= task.stageIndex || !d.profiles.some((profile) => profile.id === profileId)) return;
      const profiles = stage[list];
      if (!profiles || index < 0 || index >= profiles.length) return;
      profiles[index] = profileId;
      this.log(d, task, "you", `You changed who works on “${stage.title}”`);
    });
  }

  /** Add one more reviewer to a review chain that has not started yet. */
  addReviewer(taskId: Id, stageId: Id, profileId: Id): void {
    this.updateTask(taskId, (d, task) => {
      const at = task.plan?.stages.findIndex((stage) => stage.id === stageId) ?? -1;
      const stage = task.plan?.stages[at];
      if (!stage || stage.kind !== "review-chain" || at <= task.stageIndex || !d.profiles.some((profile) => profile.id === profileId)) return;
      // Reviewers you add from the plan are code reviewers.
      if (stage.roleIds) stage.roleIds = [...stage.profileIds.map((_, position) => library.reviewerAt(stage, position)), "code-reviewer"];
      stage.profileIds.push(profileId);
      this.log(d, task, "you", `You added a reviewer to “${stage.title}”`);
    });
  }

  // ── The role library ───────────────────────────────────────────────────────

  /** Change a role for this session of the demo. Like the engine, it refuses what the squad does not allow, in plain words. */
  saveRole(roleId: Id, draft: RoleDraft): void {
    this.changeRoles((changes) => library.editRole(changes, roleId, draft));
  }

  /** Add a role: the demo planner uses it from the next task it plans. */
  addRole(draft: RoleDraft): Id {
    let created = "";
    this.changeRoles((changes) => {
      const added = library.addRole(changes, draft);
      created = added.roleId;
      return added.changes;
    });
    return created;
  }

  resetRole(roleId: Id): void {
    this.changeRoles((changes) => library.resetRole(changes, roleId));
  }

  removeRole(roleId: Id): void {
    this.changeRoles((changes) => library.removeRole(changes, roleId, this.state.tasks.some((task) => library.planUses(task, roleId))));
  }

  private changeRoles(change: (changes: RoleChanges) => RoleChanges): void {
    // Checked before anything changes: a refused change leaves the roles as they were.
    const next = change(this.state.roleChanges ?? library.NO_ROLE_CHANGES);
    this.update((d) => {
      d.roleChanges = next as Draft["roleChanges"];
      d.roles = library.libraryRoles(next) as Draft["roles"];
    });
  }

  async setTaskStart(taskId: Id, choice: WorkChoice): Promise<void> {
    this.updateTask(taskId, (d, task) => {
      const product = d.products.find((entry) => entry.id === choice.productId);
      if (!product) throw new Error("Add the product first.");
      task.workChoice = choice;
      task.productId = choice.productId;
      task.delivery = choice.delivery;
      task.source = demoSource(product, choice);
      for (const stage of task.plan?.stages ?? []) if (stage.kind === "do" && stage.roleId === "release-manager") stage.title = deliveryLabel(task);
      delete task.workError;
    });
  }

  addTask(input: NewTask): Id {
    let created = "";
    this.update((d) => {
      const queue = queueOf(d.tasks as Task[]);
      const id = this.id(d, "task");
      created = id;
      const top = input.position === "top";
      const product = d.products.find((entry) => entry.id === input.productId) ?? d.products[0];
      const choice: WorkChoice = { productId: product?.id ?? "", startFrom: input.startFrom ?? { kind: "default" }, delivery: input.delivery ?? product?.delivery ?? "pull-request" };
      d.tasks.push({
        id,
        productId: product?.id ?? input.productId,
        workChoice: choice,
        confirmWork: !input.productId || choice.startFrom.kind === "pull-request",
        ...(product ? { source: demoSource(product, choice) } : {}),
        title: input.title.trim(),
        description: input.description?.trim() ?? "",
        area: input.area?.trim() || areaFromTitle(input.title),
        kind: input.kind ?? "feature",
        priority: top ? -1 : queue.length,
        held: false,
        state: input.backlog ? "backlog" : "queued",
        column: input.backlog ? "backlog" : "queue",
        holdsSlot: false,
        approvePlan: input.approvePlan ?? false,
        delivery: input.delivery ?? product?.delivery ?? "pull-request",
        approveDelivery: input.approveDelivery ?? product?.approveDelivery ?? true,
        stageIndex: -1,
        rounds: {},
        sub: 0,
        fixing: false,
        statusLine: input.backlog ? "Review the request before queueing" : "In the queue",
        createdAt: d.now,
        timeline: [{ id: this.id(d, id), at: d.now, text: input.backlog ? "You added it to the backlog" : "You added it to the queue", tone: "you" }],
        session: [],
        queued: [],
        objections: [],
        findings: [],
        prAge: 0,
      });
      if (top) {
        queueOf(d.tasks as Task[]).forEach((task, position) => {
          const entry = d.tasks.find((candidate) => candidate.id === task.id);
          if (entry) entry.priority = position;
        });
      }
      this.schedule(d);
    });
    return created;
  }

  queueTask(taskId: Id): void {
    this.update((d) => {
      const task = d.tasks.find((entry) => entry.id === taskId);
      if (!task || task.state !== "backlog") return;
      task.priority = queueOf(d.tasks).length;
      task.state = "queued"; task.column = "queue"; task.held = false; task.statusLine = "In the queue";
      this.log(d, task, "you", "You reviewed the request and queued it for work");
      this.schedule(d);
    });
  }

  moveToBacklog(taskId: Id): void {
    this.update((d) => {
      const task = d.tasks.find((entry) => entry.id === taskId);
      if (!task || task.state !== "queued" || task.startedAt !== undefined) return;
      task.state = "backlog"; task.column = "backlog"; task.held = false; task.statusLine = "Review the request before queueing";
      this.log(d, task, "you", "You moved it to the backlog for review");
    });
  }

  updateBacklog(taskId: Id, changes: { title: string; description: string }): void {
    this.update((d) => {
      const task = d.tasks.find((entry) => entry.id === taskId);
      if (!task || task.state !== "backlog") throw new Error("Only backlog requests can be edited before work starts.");
      const title = changes.title.trim();
      if (!title || title.length > 200 || changes.description.length > 8000) throw new Error("Give the task a title and a shorter request.");
      task.title = title; task.description = changes.description.trim(); task.area = areaFromTitle(title);
      this.log(d, task, "you", "You updated the backlog request");
    });
  }

  // ── Engine internals ───────────────────────────────────────────────────────

  private update(change: (draft: Draft) => void): void {
    // State is plain JSON, so a JSON round trip is a full, environment-neutral copy.
    const draft = JSON.parse(JSON.stringify(this.state)) as Draft;
    change(draft);
    this.state = draft as unknown as State;
    for (const listener of this.listeners) listener();
  }

  private updateTask(taskId: Id, change: (draft: Draft, task: DraftTask) => void): void {
    this.update((d) => {
      const task = d.tasks.find((entry) => entry.id === taskId);
      if (task) change(d, task);
    });
  }

  /** `answer`: how the coordinator answered an agent or a checkpoint, for the work log. An offer (the review guide, AGENTS.md) has none. */
  private resolve(itemId: Id, change: (draft: Draft, task: DraftTask, item: DeepMutable<InboxItem>) => void, answer?: AskAnswer): void {
    this.update((d) => {
      const item = d.inbox.find((entry) => entry.id === itemId);
      const task = item && d.tasks.find((entry) => entry.id === item.taskId);
      if (!item || !task) return;
      d.inbox = d.inbox.filter((entry) => entry.id !== itemId);
      if (answer && ASKS.has(item.kind)) this.answered(d, task, item, answer);
      change(d, task, item);
      this.schedule(d);
    });
  }

  private id(d: Draft, prefix: string): Id {
    d.seq += 1;
    return `${prefix}-${d.seq}`;
  }

  private log(d: Draft, task: DraftTask, tone: Task["timeline"][number]["tone"], text: string, roleId?: Id, profileId?: Id): void {
    const step = stepTag(task);
    task.timeline.push({ id: this.id(d, task.id), at: d.now, text, tone, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}), ...(step ? { step } : {}) });
  }

  private say(d: Draft, task: DraftTask, from: Task["session"][number]["from"], text: string, roleId?: Id, profileId?: Id): void {
    const step = stepTag(task);
    task.session.push({ id: this.id(d, task.id), at: d.now, from, text, ...(roleId ? { roleId } : {}), ...(profileId ? { profileId } : {}), ...(step ? { step } : {}) });
  }

  private stage(task: DraftTask): DeepMutable<Stage> | undefined {
    return task.stageIndex < 0 ? undefined : task.plan?.stages[task.stageIndex];
  }

  private round(task: DraftTask): number {
    const stage = this.stage(task);
    return stage ? (task.rounds[stage.id] ?? 1) : 1;
  }

  /** The call the architect is following, while it works on the design stage the call settled. */
  private following(task: DraftTask): DesignCall | undefined {
    return task.sub === 0 ? followingCall(task as unknown as Task) : undefined;
  }

  private columnFor(d: Draft, task: DraftTask): Column {
    return columnOf(task as unknown as Task, d.roles as Role[]);
  }

  /** The profile the planner runs on, kept in the state so a queued task's journey can name it. */
  private planner(d: Draft): Id {
    return d.planner ?? PLANNER_PROFILE;
  }

  /** Who should be working right now, given the stage and the sub-step. */
  private nextAgent(task: DraftTask): { roleId: Id; profileId: Id } | undefined {
    if (task.stageIndex < 0) return { roleId: "planner", profileId: task.plan?.plannerProfileId ?? this.state.planner ?? PLANNER_PROFILE };
    const stage = this.stage(task);
    if (!stage) return undefined;
    switch (stage.kind) {
      case "do":
        return stage.profileIds[0] ? { roleId: stage.roleId, profileId: stage.profileIds[0] } : undefined;
      case "converge":
        if (task.sub === 0) return stage.profileIds[0] ? { roleId: stage.roleId, profileId: stage.profileIds[0] } : undefined;
        return stage.reviewerRoleId && stage.reviewerProfileIds?.[0]
          ? { roleId: stage.reviewerRoleId, profileId: stage.reviewerProfileIds[0] }
          : undefined;
      case "review-chain": {
        const profileId = stage.profileIds[task.sub];
        return profileId ? { roleId: library.reviewerAt(stage, task.sub), profileId } : undefined;
      }
      case "gate":
        return undefined;
    }
  }

  private startAgent(d: Draft, task: DraftTask): void {
    const next = this.nextAgent(task);
    if (!next) return;
    const toolId = d.profiles.find((profile) => profile.id === next.profileId)?.toolId ?? "unknown";
    const waiting = slotWait(d as State, { taskId: task.id, toolId });
    if (waiting) {
      task.state = "waiting";
      task.holdsSlot = false;
      delete task.agent;
      delete task.helpers;
      task.column = this.columnFor(d, task);
      task.statusLine = waiting;
      return;
    }
    const current = this.stage(task);
    // A review round starts with Petrina's own run of the product's checks, as the engine's does.
    const round = this.round(task);
    if (current?.kind === "review-chain" && (task.hunt?.stageId !== current.id || task.hunt.round !== round)) {
      this.runChecks(d, task);
      task.hunt = { stageId: current.id, round, reported: {}, findings: task.findings.length };
    }
    // Back from waiting for the screen: the same agent picks up where it left off, on the screen.
    const screen = task.screen?.granted && !task.screen.heard && task.screen.roleId === next.roleId ? task.screen : undefined;
    // A review round's reviewers share its step on the journey; each joins it as it starts.
    beginAgentStep(task, current?.kind === "review-chain" ? current.roleId : next.roleId, next.profileId, d.now, current?.kind === "review-chain" ? current.profileIds : undefined);
    // Claude Code and Codex have known sandbox states; other tools keep their own setup.
    const agent: ActiveAgent = { ...next, since: d.now, step: screen?.step ?? 0, ...(["claude-code", "codex"].includes(toolId) ? { sandbox: { on: true as const } } : {}) };
    task.agent = agent;
    // Reviewers look at the change together, as the engine's do: the ones still to report work beside this
    // one, each in a slot of its own while the pool and its tool allow.
    delete task.helpers;
    for (const [index, profileId] of (current?.kind === "review-chain" ? current.profileIds.slice(task.sub + 1) : []).entries()) {
      const tool = d.profiles.find((profile) => profile.id === profileId)?.toolId ?? "unknown";
      if (!extraSlot(d as State, tool)) break;
      task.helpers = [...(task.helpers ?? []), { roleId: library.reviewerAt(current!, task.sub + 1 + index), profileId, since: d.now, step: 0 }];
    }
    // Each start is a fresh one: a step started again after a pause leaves no record.
    delete task.todo;
    task.stepAttempts = (task.stepAttempts ?? 0) + 1;
    task.stepClock = startClock(task as unknown as Task, next.roleId, d.now);
    task.state = "running";
    task.holdsSlot = true;
    task.column = this.columnFor(d, task);
    const role = d.roles.find((entry) => entry.id === next.roleId)?.name ?? next.roleId;
    if (screen) {
      screen.heard = true;
      task.statusLine = SCREEN_WORDS.using(screen.reason);
      this.say(d, task, "system", `${role} picked up where it left off`, next.roleId, next.profileId);
      this.log(d, task, "milestone", SCREEN_WORDS.pickedUp, next.roleId, next.profileId);
      this.openTurn(d, task, "continue");
      return;
    }
    task.statusLine = `${role} is starting`;
    this.say(d, task, "system", `${role} joined`, next.roleId, next.profileId);
    this.log(d, task, "milestone", `${role} started`, next.roleId, next.profileId);
    this.beginStage(d, task);
    this.openTurn(d, task, "first");
  }

  private step(d: Draft, task: DraftTask): void {
    const agent = task.agent;
    if (!agent) return;

    const message = task.queued.shift();
    if (message) {
      this.deliver(d, task, message.text);
      return;
    }

    const product = d.products.find((entry) => entry.id === task.productId)?.name ?? "the product";
    const round = this.round(task);
    const following = !!this.following(task);
    const moments = scriptFor(d.roles.find((role) => role.id === agent.roleId), { area: task.area, product, round, fixing: task.fixing, following, objecting: this.disagree.has(task.id) });
    const moment = moments[agent.step];
    if (moment === undefined) {
      this.finish(d, task);
      return;
    }

    // As with real agents: the to-do item goes on the timeline, actions are the status line and the session's activity.
    agent.step += 1;
    if ("action" in moment) {
      task.statusLine = moment.action;
      this.say(d, task, "activity", moment.action, agent.roleId, agent.profileId);
      return;
    }
    const todo = plainTodo(moment.todo);
    if (todo) task.todo = todo;
    this.log(d, task, "status", todo ?? moment.todo, agent.roleId, agent.profileId);
    const item = moments.slice(0, agent.step).filter((entry) => "todo" in entry).length - 1;
    const trigger = this.triggers[`${task.id}|${agent.roleId}|${round}|${item}`] ?? this.triggers[`${task.id}|${agent.roleId}|${round}|${agent.step - 1}`];
    if (trigger?.kind === "screen") this.askScreen(d, task, trigger.title);
    else if (trigger) this.ask(d, task, trigger);
  }

  /** The agent did what it could in the background and needs the screen. */
  private askScreen(d: Draft, task: DraftTask, text: string): void {
    const agent = task.agent;
    if (!agent) return;
    const reason = screenReason(text);
    this.endTurn(d, task, "finished");
    task.screen = { reason, at: d.now, roleId: agent.roleId, profileId: agent.profileId, step: agent.step };
    this.log(d, task, "status", SCREEN_WORDS.asked(reason), agent.roleId, agent.profileId);
    const free = !onScreen(d.tasks as Task[]) && !screenQueue(d.tasks as Task[]).some((other) => screenAllowed(other, d.pool, d.now));
    if (screenAllowed(task as Task, d.pool, d.now) && free) {
      task.screen.granted = true;
      task.screen.heard = true;
      task.statusLine = SCREEN_WORDS.using(reason);
      this.log(d, task, "milestone", SCREEN_WORDS.using(reason), agent.roleId, agent.profileId);
      this.openTurn(d, task, "continue");
      return;
    }
    task.state = "waiting";
    task.holdsSlot = false;
    delete task.agent;
    delete task.helpers;
    this.syncScreen(d);
  }

  /** Screen requests and their quiet inbox items follow the active request. */
  private syncScreen(d: Draft): void {
    if (d.pool.screen && d.pool.screen.mode !== screenMode(d.pool, d.now)) d.pool.screen = { mode: "off" };
    for (const task of d.tasks) {
      const wait = screenWait(task as Task, d as State, d.now);
      const item = d.inbox.find((entry) => entry.taskId === task.id && entry.kind === "screen");
      if (wait === "ask" && !item) {
        const request = task.screen!;
        d.inbox.push({ id: this.id(d, "inbox"), taskId: task.id, kind: "screen", title: SCREEN_WORDS.needs(request.reason), body: SCREEN_WORDS.body, at: request.at, blocking: false, roleId: request.roleId, profileId: request.profileId });
      } else if (wait !== "ask" && item) d.inbox = d.inbox.filter((entry) => entry !== item);
      if (wait === "ask") task.statusLine = SCREEN_WORDS.needs(task.screen!.reason);
      else if (wait === "turn") task.statusLine = SCREEN_WORDS.turn;
      else if (task.state === "waiting" && task.screen && !task.screen.granted) task.statusLine = "Waiting for a free slot";
    }
  }

  /** The step ended, was paused or cancelled: free the screen. */
  private releaseScreen(d: Draft, task: DraftTask): void {
    delete task.screen;
    d.inbox = d.inbox.filter((item) => !(item.taskId === task.id && item.kind === "screen"));
  }

  private deliver(d: Draft, task: DraftTask, text: string, interrupt = false): void {
    if (this.openTurns.has(task.id)) {
      this.endTurn(d, task, interrupt ? "interrupted" : "finished");
      this.openTurn(d, task, "message");
    }
    this.say(d, task, "you", text);
    this.log(d, task, "you", `You said: ${text}`);
    this.say(d, task, "agent", "Got it. I'll take that into account from here.", task.agent?.roleId, task.agent?.profileId);
  }

  /** Petrina's own run of the product's checks, before a review round's reviewers. In the demo they pass. */
  private runChecks(d: Draft, task: DraftTask): void {
    beginPetrinaStep(task, "checks", d.now);
    task.checks = { at: d.now, results: DEMO_CHECKS };
    this.log(d, task, "done", `Checks passed: ${DEMO_CHECKS.map((run) => run.name).join(", ")}`);
    endPetrinaStep(task, { outcome: W.checks(0, DEMO_CHECKS.length), reason: W.checksPassed }, d.now);
  }

  private ask(d: Draft, task: DraftTask, trigger: Trigger): void {
    if (trigger.kind === "screen") return;
    const agent = task.agent;
    // A question ends the agent's turn; a permission is answered inside it, and the wait is not work.
    if (trigger.kind === "question") this.endTurn(d, task, "finished");
    else {
      const open = this.openTurns.get(task.id);
      if (open) open.waitingSince = d.now;
    }
    const id = this.raise(d, task, trigger.kind, trigger.title, true, trigger);
    addAsk(task, { id, kind: trigger.kind, title: trigger.title, at: d.now });
    task.statusLine = trigger.kind === "question" ? "Waiting for your answer" : "Waiting for your permission";
    if (task.stepClock) task.stepClock = pauseClock(task.stepClock, d.now);
    this.say(d, task, "agent", trigger.title, agent?.roleId, agent?.profileId);
    this.log(d, task, "warn", trigger.kind === "question" ? `Asked you: ${trigger.title}` : `Asked your permission: ${trigger.title}`, agent?.roleId, agent?.profileId);
  }

  private raise(
    d: Draft,
    task: DraftTask,
    kind: InboxKind,
    title: string,
    blocking: boolean,
    extra: { body?: string; options?: readonly string[]; detail?: string } = {},
  ): Id {
    task.state = "needs-you";
    const agent = task.agent;
    const id = this.id(d, "inbox");
    d.inbox.push({
      id,
      taskId: task.id,
      kind,
      title,
      at: d.now,
      blocking,
      ...(agent ? { roleId: agent.roleId, profileId: agent.profileId } : {}),
      ...(extra.body ? { body: extra.body } : {}),
      ...(extra.options ? { options: [...extra.options] } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
    });
    if (ASKS.has(kind)) this.askMoment(d, task, d.inbox.at(-1)!);
    return id;
  }

  private unblock(d: Draft, task: DraftTask): void {
    if (task.state !== "needs-you") return;
    task.state = task.holdsSlot ? "running" : "waiting";
    task.statusLine = task.holdsSlot ? "Back to work" : "Waiting for a free slot";
    if (task.holdsSlot && task.stepClock) task.stepClock = resumeClock(task.stepClock, d.now);
  }

  /** The agent finished its step list: hand the result to the stage. */
  private finish(d: Draft, task: DraftTask): void {
    const agent = task.agent;
    if (!agent) return;
    this.endTurn(d, task, "finished");
    this.releaseScreen(d, task);
    this.finishStep(d, task);

    if (task.stageIndex < 0) {
      task.plan = composePlan(task, library.activeRoles(d.roles)) as DeepMutable<NonNullable<Task["plan"]>>;
      task.risk = DEMO_RISK[task.kind];
      const count = task.plan.stages.filter((stage) => stage.kind !== "gate").length;
      this.log(d, task, "milestone", `Plan ready: ${count} stages. ${task.plan.rationale}`, agent.roleId, agent.profileId);
      this.say(d, task, "agent", task.plan.rationale, agent.roleId, agent.profileId);
      this.endStage(d, task, "done");
      endAgentStep(task, { outcome: W.planned(count), reason: W.planReady }, d.now);
      if (task.approvePlan || task.confirmWork) this.gate(d, task, "plan");
      else this.advance(d, task);
      return;
    }

    const stage = this.stage(task);
    if (!stage) return;
    const round = this.round(task);

    if (stage.kind === "do" && agent.roleId === "release-manager") {
      this.endStage(d, task, "delivered");
      this.ship(d, task);
      return;
    }

    if (stage.kind === "do") {
      if (agent.roleId === "builder" && task.fixing) {
        let count = 0;
        for (const finding of task.findings) {
          if (finding.status !== "open" || finding.severity === "pre-existing") continue;
          const fixed = finding.severity === "blocking";
          finding.answer = { fixed, text: fixed ? "Fixed, with a test for addresses with a plus sign." : "Kept as is: the current message matches the rest of the product.", at: d.now };
          if (fixed) finding.status = "fixed";
          if (fixed) count += 1;
        }
        task.fixing = false;
        this.log(d, task, "done", "Fixed the blocking findings", agent.roleId, agent.profileId);
        endAgentStep(task, { outcome: W.fixed(count), reason: W.fixesReady }, d.now);
      } else {
        this.log(d, task, "done", `${stage.title} done`, agent.roleId, agent.profileId);
        endAgentStep(
          task,
          agent.roleId === "builder" ? { outcome: W.built, reason: W.readyForReview } : agent.roleId === "tester" ? { outcome: W.checks(0, task.brief?.acceptance.length ?? 0), reason: W.checksPassed } : { outcome: W.wroteNotes, reason: W.notesReady },
          d.now,
        );
      }
      this.endStage(d, task, "done");
      this.advance(d, task);
      return;
    }

    if (stage.kind === "converge") {
      const call = this.following(task);
      if (call) {
        // The call's words decide the objections they speak to; the architect answers the rest itself. None is left open.
        // After changes asked for at the check, it answers them all again: the note can correct a decision, and the notes match the updated brief.
        const revising = !task.objections.some((objection) => objection.status === "open");
        const note = revising ? task.notes?.at(-1)?.text : undefined;
        const answers = callAnswers(task.area, dueAnswers(task.objections as Task["objections"], call), call.text, note);
        task.objections = answerByCall(task.objections as Task["objections"], call, answers) as DraftTask["objections"];
        recordStepResult(task, { objections: task.objections.filter((objection) => answers.some((answer) => answer.id === objection.id) || call.open.includes(objection.id)) });
        task.brief = briefFor(task);
        this.log(d, task, "done", revising ? CALL_WORDS.revised : CALL_WORDS.updated, agent.roleId, agent.profileId);
        this.log(d, task, "done", CALL_WORDS.settled);
        this.endStage(d, task, "settled");
        endAgentStep(task, { outcome: W.followed, reason: W.followsCall }, d.now);
        this.advance(d, task);
        return;
      }
      if (task.sub === 0) {
        const due = task.objections.filter((objection) => objection.status === "open").map((objection) => objection.id);
        for (const objection of task.objections) {
          if (objection.status !== "open") continue;
          objection.status = objection.blocking ? "accepted" : "rejected";
          objection.answer = objection.blocking ? "Changed the design to cover it." : "Out of scope for this task. Added to risks.";
        }
        this.log(d, task, "done", round === 1 ? "Design brief ready" : "Answered every objection", agent.roleId, agent.profileId);
        recordStepResult(task, { objections: task.objections.filter((objection) => due.includes(objection.id)) });
        endAgentStep(task, round === 1 ? { outcome: W.wroteBrief, reason: W.briefReady } : { outcome: W.answeredAll, reason: W.objectionsAnswered }, d.now);
        task.sub = 1;
        this.startAgent(d, task);
        return;
      }
      // A round that raised objections is logged once, even when it settles.
      let logged = false;
      if (round === 1 || this.disagree.has(task.id)) {
        const raised =
          round === 1
            ? [
                { blocking: true, text: `What happens to ${task.area} for people who already have an account? The brief does not say.` },
                { blocking: false, text: `Consider remembering the last choice in ${task.area} on this device.` },
              ]
            : laterObjections(task.area, round);
        const before = task.objections.length;
        for (const objection of raised) task.objections.push({ id: this.id(d, task.id), round, raisedBy: agent.profileId, status: "open", ...objection });
        recordStepResult(task, { objections: task.objections.slice(before) });
        const blocking = raised.filter((objection) => objection.blocking).length;
        this.log(d, task, "warn", `Raised ${raised.length} objections, ${blocking} blocking`, agent.roleId, agent.profileId);
        this.designRound(d, task, stage, round, raised.length, blocking);
        logged = true;
        endAgentStep(task, blocking ? { outcome: W.objections(raised.length, blocking), reason: W.blocking(blocking), tone: "back" } : { outcome: W.objections(raised.length, 0), reason: W.noBlocking }, d.now);
        const end = designRoundEnd(blocking, round, stage as Stage);
        if (end === "disagreement") {
          this.moment(d, task, { kind: "design-end", outcome: "to-you", rounds: round, roleId: stage.roleId, ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}) });
          this.endStage(d, task, "to-you");
          this.gateDisagreement(d, task);
          return;
        }
        if (end === "next round") {
          task.rounds[stage.id] = round + 1;
          task.sub = 0;
          this.startAgent(d, task);
          return;
        }
      }
      task.brief = briefFor(task);
      this.log(d, task, "done", "Design settled: no blocking objections", agent.roleId, agent.profileId);
      if (!logged) recordStepResult(task, { objections: [] });
      endAgentStep(task, { outcome: W.objections(0, 0), reason: W.noBlocking }, d.now);
      if (!logged) this.designRound(d, task, stage, round, 0, 0);
      this.moment(d, task, { kind: "design-end", outcome: "settled", rounds: round, roleId: stage.roleId, ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}) });
      this.endStage(d, task, "settled");
      this.advance(d, task);
      return;
    }

    if (stage.kind === "review-chain") {
      const added = d.roles.find((role) => role.id === agent.roleId)?.added;
      if (added) {
        if (round === 1) task.findings.push({ id: this.id(d, task.id), text: `Check ${task.area} with real data before the next release.`, severity: "suggestion", roleId: agent.roleId, raisedBy: agent.profileId, confirmedBy: [], status: "open" });
        this.log(d, task, "done", "Nothing blocking", agent.roleId, agent.profileId);
      } else if (round === 1 && task.sub === 0) {
        task.findings.push({
          id: this.id(d, task.id),
          text: `${capitalize(task.area)} fails when the email address contains a plus sign, and no test covers it.`,
          where: `${capitalize(task.area)} form`,
          severity: "blocking",
          raisedBy: agent.profileId,
          confirmedBy: [],
          status: "open",
        });
        this.log(d, task, "warn", "1 important", agent.roleId, agent.profileId);
        this.moment(d, task, { kind: "verdict", verdict: "fail", roleId: agent.roleId, profileId: agent.profileId, count: 1, blocking: 1 });
      } else if (round === 1) {
        for (const finding of task.findings) if (finding.status === "open") finding.confirmedBy.push(agent.profileId);
        task.findings.push({
          id: this.id(d, task.id),
          text: "Show a clearer message when the email is not valid.",
          severity: "suggestion",
          raisedBy: agent.profileId,
          confirmedBy: [],
          status: "open",
        });
        task.findings.push({
          id: this.id(d, task.id),
          text: "The sign-in page has no limit on attempts. It was like this before the change.",
          severity: "pre-existing",
          raisedBy: agent.profileId,
          confirmedBy: [],
          status: "open",
        });
        this.log(d, task, "warn", "1 nit, 1 follow-up; confirmed 1", agent.roleId, agent.profileId);
        const blocking = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking" && finding.confirmedBy.includes(agent.profileId)).length;
        this.moment(d, task, { kind: "verdict", verdict: blocking ? "fail" : "pass", roleId: agent.roleId, profileId: agent.profileId, count: 2 + blocking, blocking });
      } else {
        this.log(d, task, "done", "Nothing to fix", agent.roleId, agent.profileId);
        this.moment(d, task, { kind: "verdict", verdict: "pass", roleId: agent.roleId, profileId: agent.profileId, count: 0, blocking: 0 });
      }

      if (task.sub + 1 < stage.profileIds.length) {
        task.sub += 1;
        this.startAgent(d, task);
        return;
      }

      const open = task.findings.filter((finding) => finding.status === "open" && finding.severity === "blocking");
      const end = reviewRoundEnd(task as unknown as Task, stage as Stage, round);
      noteRoundEnd(task, stage.id, open.length);
      // The round's step says what its reviewers raised, and where the work goes.
      const raised = task.findings.slice(task.hunt?.findings ?? 0);
      recordStepResult(task, { findings: raised });
      delete task.hunt;
      endAgentStep(
        task,
        { outcome: findingCount(raised), ...(end.kind === "send back" ? { reason: W.sentBack(end.open), tone: "back" } : end.kind === "used up" ? { reason: W.stillOpen(end.open), tone: "back" } : { reason: W.reviewPassed }) },
        d.now,
      );
      if (end.kind === "send back") {
        task.rounds[stage.id] = round + 1;
        task.stageIndex = end.builder;
        task.sub = 0;
        task.fixing = true;
        this.log(d, task, "warn", `Sent back to the builder: ${findingCount(open)}`);
        this.moment(d, task, { kind: "review-end", outcome: "sent-back", stageId: stage.id, stageTitle: stage.title, stageKind: stage.kind, round });
        this.endStage(d, task, "sent-back", stage.id);
        this.startAgent(d, task);
        return;
      }
      this.log(d, task, end.kind === "used up" ? "warn" : "done", end.kind === "used up" ? `Review rounds used up: ${findingCount(open)} still open` : `Review passed: ${findingCount(task.findings.filter((finding) => finding.status === "open"))}`);
      this.moment(d, task, { kind: "review-end", outcome: end.kind === "used up" ? "rounds-used" : "passed" });
      this.endStage(d, task, end.kind === "used up" ? "rounds-used" : "passed");
      // With blocking findings left, the coordinator always looks before anything ships, as in the engine.
      const next = task.plan?.stages[task.stageIndex + 1];
      if (end.kind === "used up" && next && next.kind !== "gate") {
        delete task.helpers;
        task.stageIndex += 1;
        task.sub = 0;
        this.gate(d, task, "delivery");
        return;
      }
      this.advance(d, task);
    }
  }

  /** The step handed back its result: a short record of it, unless it was started again, and a clean start for the next one. */
  private finishStep(d: Draft, task: DraftTask): void {
    if (task.stepClock && task.stepAttempts === 1) task.steps = [...(task.steps ?? []), stepRecord(task.stepClock, d.now)].slice(-MAX_STEP_RECORDS);
    delete task.todo;
    delete task.stepClock;
    delete task.stepAttempts;
  }

  private advance(d: Draft, task: DraftTask): void {
    delete task.helpers;
    task.stageIndex += 1;
    task.sub = 0;
    delete task.agent;
    const stage = this.stage(task);
    if (!stage) {
      this.openPullRequest(d, task);
      return;
    }
    if (stage.kind === "gate" && stage.gate) {
      this.gate(d, task, stage.gate);
      return;
    }
    if (this.petrinaDelivers(task)) {
      this.ship(d, task);
      return;
    }
    this.startAgent(d, task);
  }

  /** Pull requests and commits to main need no agent: Petrina publishes them itself, as the engine does. A release's notes come from the Release Manager first. */
  private petrinaDelivers(task: DraftTask): boolean {
    const stage = this.stage(task);
    return task.delivery !== "release" && stage?.kind === "do" && stage.roleId === "release-manager";
  }

  private gate(d: Draft, task: DraftTask, gate: GateKind): void {
    delete task.agent;
    delete task.helpers;
    beginYouStep(task, gate, d.now);
    task.holdsSlot = false;
    task.statusLine = gateStatus(task as unknown as Task, gate);
    const body = gate === "design" ? callCheckBody(task as unknown as Task) : task.source && (gate === "plan" || gate === "delivery") ? workSummary(task.source) : undefined;
    this.raise(d, task, gate, gateTitle(task as unknown as Task, gate), false, body ? { body } : {});
    task.column = this.columnFor(d, task);
  }

  private gateDisagreement(d: Draft, task: DraftTask): void {
    delete task.agent;
    beginYouStep(task, "call", d.now);
    task.holdsSlot = false;
    task.statusLine = "The architects disagree. Your call";
    this.raise(d, task, "disagreement", `The architects disagree on “${task.title}”`, false, { body: CALL_WORDS.disagreement });
  }

  private continueAfterGate(d: Draft, task: DraftTask, advance = true): void {
    if (advance) task.stageIndex += 1;
    task.sub = 0;
    const stage = this.stage(task);
    if (!stage) {
      this.openPullRequest(d, task);
      return;
    }
    if (stage.kind === "gate" && stage.gate) {
      this.gate(d, task, stage.gate);
      return;
    }
    if (this.petrinaDelivers(task)) {
      this.ship(d, task);
      return;
    }
    task.state = "waiting";
    task.statusLine = "Waiting for a free slot";
    task.column = this.columnFor(d, task);
  }

  private openPullRequest(d: Draft, task: DraftTask): void {
    beginPetrinaStep(task, "delivery", d.now);
    const product = d.products.find((entry) => entry.id === task.productId);
    const number = 100 + (d.seq % 900);
    task.pr = { number, url: `https://github.com/${product?.repo ?? "owner/repo"}/pull/${number}`, state: "open", openedAt: d.now };
    task.state = "pr-open";
    task.holdsSlot = false;
    delete task.agent;
    task.prAge = 0;
    task.statusLine = `Pull request #${number} is open. Merge it on GitHub when you are happy`;
    task.column = "ready";
    this.log(d, task, "status", "Petrina pushed the branch");
    this.log(d, task, "done", `Petrina opened pull request #${number}, and checked it on GitHub`);
    this.moment(d, task, { kind: "task-end", outcome: "delivered" });
    endPetrinaStep(task, { outcome: W.openedPr(number) }, d.now);
  }

  /** Petrina publishes it, the way the task asks: with the builder's text, or the Release Manager's notes. */
  private ship(d: Draft, task: DraftTask): void {
    if (task.agent) {
      this.log(d, task, "done", "Ready to publish", "release-manager", task.agent.profileId);
      endAgentStep(task, { outcome: W.notes, reason: W.releaseNotesReady }, d.now);
    }
    if (task.source?.start.kind === "pull-request") {
      const start = task.source.start;
      beginPetrinaStep(task, "delivery", d.now);
      task.pr = { number: start.number, url: start.url, state: "open", openedAt: d.now };
      delete task.agent;
      task.holdsSlot = false;
      task.state = "pr-open";
      task.column = "ready";
      task.prAge = 0;
      task.statusLine = `Updated PR #${start.number}. Merge it on GitHub when you are happy`;
      this.log(d, task, "done", `Updated PR #${start.number} in ${start.headRepo} · ${start.branch}`);
      this.moment(d, task, { kind: "task-end", outcome: "delivered" });
      endPetrinaStep(task, { outcome: `Updated pull request #${start.number}` }, d.now);
      return;
    }
    if (task.delivery === "pull-request") {
      this.openPullRequest(d, task);
      return;
    }
    const product = d.products.find((entry) => entry.id === task.productId);
    beginPetrinaStep(task, "delivery", d.now);
    delete task.agent;
    task.holdsSlot = false;
    task.state = "done";
    task.column = "done";
    task.finishedAt = d.now;
    this.moment(d, task, { kind: "task-end", outcome: "delivered" });
    if (task.delivery === "release") {
      const tag = `v1.${(d.seq % 40) + 1}.0`;
      task.release = { tag, url: `https://github.com/${product?.repo ?? "owner/repo"}/releases/tag/${tag}` };
      task.statusLine = `Released ${tag}`;
      this.log(d, task, "status", `Petrina pushed main and the tag ${tag}`);
      this.log(d, task, "done", `Petrina published release ${tag}, and checked it on GitHub`);
      endPetrinaStep(task, { outcome: W.released(tag) }, d.now);
    } else {
      const sha = (d.seq * 2654435761).toString(16).slice(0, 7);
      task.landed = { branch: task.source?.destination.branch ?? product?.defaultBranch ?? "main", sha };
      task.statusLine = `Committed to ${task.landed.branch} (${sha})`;
      this.log(d, task, "done", `Petrina moved ${task.landed.branch} forward to it (${sha}), and checked the main copy`);
      endPetrinaStep(task, { outcome: W.movedMain(task.landed.branch) }, d.now);
    }
    this.removeCopy(d, task);
  }

  private agePullRequest(d: Draft, task: DraftTask): void {
    task.prAge += 1;
    if (!task.pr || task.prAge < this.prMergeAfter) return;
    task.pr.state = "merged";
    if (task.state !== "cancelled") {
      task.state = "done";
      task.column = "done";
      task.finishedAt = d.now;
      task.statusLine = `Merged #${task.pr.number} on GitHub`;
    }
    this.log(d, task, "done", `Merged on GitHub (#${task.pr.number})`);
    this.moment(d, task, { kind: "task-end", outcome: "merged" });
    this.removeCopy(d, task);
  }

  /** A finished task's working copy goes, to free disk space. One with an open pull request stays. */
  private removeCopy(d: Draft, task: DraftTask): void {
    if (!copyNoLongerNeeded(task as unknown as Task) || task.cleanup?.removedAt !== undefined) return;
    if (this.lockedCopies.has(task.id) && !task.cleanup?.error) {
      task.cleanup = { error: CLEANUP_WORDS.locked };
      this.log(d, task, "warn", CLEANUP_WORDS.failed(CLEANUP_WORDS.locked));
      return;
    }
    task.cleanup = { removedAt: d.now };
    this.log(d, task, "done", CLEANUP_WORDS.removed);
  }

  // ── The work log ─────────────────────────────────────────────────────────

  private wrote(d: Draft): void {
    d.work = { version: (d.work?.version ?? 0) + 1, since: d.work?.since ?? this.work.since() };
  }

  private entryId(prefix: string): Id {
    this.serial += 1;
    return `${prefix}-${this.serial}`;
  }

  private stageContext(task: DraftTask): { stageId: Id; title: string; kind: WorkStageKind; roleId: Id } {
    const stage = this.stage(task);
    if (!stage) return { stageId: `${task.id}:plan`, title: "Planning", kind: "plan", roleId: "planner" };
    return { stageId: stage.id, title: stage.title, kind: stage.kind, roleId: stage.roleId };
  }

  private moment(d: Draft, task: DraftTask, moment: Omit<WorkMoment, "id" | "at" | "taskId" | "productId">, when: { id?: Id; at?: number } = {}): void {
    const open = this.openStages.get(task.id);
    const context = open ?? this.stageContext(task);
    this.work.addMoment({
      id: when.id ?? this.entryId(`${task.id}-m`),
      at: when.at ?? d.now,
      taskId: task.id,
      productId: task.productId,
      ...(moment.kind === "task-end" ? {} : { stageId: context.stageId, stageTitle: context.title, stageKind: context.kind, round: context.kind === "converge" || context.kind === "review-chain" ? this.round(task) : (open?.round ?? this.round(task)) }),
      ...moment,
    });
    this.wrote(d);
  }

  private beginStage(d: Draft, task: DraftTask): void {
    const context = this.stageContext(task);
    const open = this.openStages.get(task.id);
    if (open?.stageId === context.stageId) return;
    if (open) this.endStage(d, task, "done");
    const runs = (this.stageRuns.get(context.stageId) ?? 0) + 1;
    this.stageRuns.set(context.stageId, runs);
    const stage = this.stage(task);
    const round = stage && (stage.kind === "converge" || stage.kind === "review-chain") ? (task.rounds[stage.id] ?? 1) : runs;
    this.openStages.set(task.id, { ...context, round, startedAt: d.now });
    this.moment(d, task, { kind: "stage-start", roleId: context.roleId });
  }

  private endStage(d: Draft, task: DraftTask, outcome: MomentOutcome, stageId?: Id): void {
    const open = this.openStages.get(task.id);
    if (!open || (stageId && open.stageId !== stageId)) return;
    const workMs = this.work
      .turns({ taskId: task.id })
      .filter((turn) => turn.stageId === open.stageId && turn.startedAt >= open.startedAt)
      .reduce((sum, turn) => sum + (turn.workMs ?? 0), 0);
    this.moment(d, task, { kind: "stage-end", outcome, roleId: open.roleId, durationMs: d.now - open.startedAt, workMs });
    this.openStages.delete(task.id);
  }

  private designRound(d: Draft, task: DraftTask, stage: DeepMutable<Stage>, round: number, objections: number, blocking: number): void {
    this.moment(d, task, {
      kind: "design-round",
      roleId: stage.roleId,
      ...(stage.profileIds[0] ? { profileId: stage.profileIds[0] } : {}),
      ...(stage.reviewerRoleId ? { peerRoleId: stage.reviewerRoleId } : {}),
      ...(stage.reviewerProfileIds?.[0] ? { peerProfileId: stage.reviewerProfileIds[0] } : {}),
      round,
      count: objections,
      blocking,
    });
  }

  /** The coordinator answered something: how long it took and what it was. */
  private answered(d: Draft, task: DraftTask, item: DeepMutable<InboxItem>, answer: AskAnswer): void {
    this.askMoment(d, task, item, answer);
    if (item.kind === "question" && task.agent) this.openTurn(d, task, "answer");
    const open = this.openTurns.get(task.id);
    if (item.kind === "permission" && open?.waitingSince !== undefined) {
      open.waitedMs += d.now - open.waitingSince;
      delete open.waitingSince;
    }
  }

  private askMoment(d: Draft, task: DraftTask, item: DeepMutable<InboxItem>, answer?: AskAnswer): void {
    const ask = item.kind === "question" ? "question" : item.kind === "permission" ? "permission" : "checkpoint";
    this.moment(d, task, { kind: "ask", ask, ...(answer ? { answer, durationMs: Math.max(0, d.now - item.at) } : {}), ...(item.roleId ? { roleId: item.roleId } : {}), ...(item.profileId ? { profileId: item.profileId } : {}) }, { id: askMomentId(task.id, item.id), at: item.at });
  }

  private openTurn(d: Draft, task: DraftTask, reason: TurnReason): void {
    const agent = task.agent;
    if (!agent) return;
    this.endTurn(d, task, "finished");
    const profile = d.profiles.find((entry) => entry.id === agent.profileId);
    const toolId = profile?.toolId ?? "unknown";
    const quirk = this.quirkFor(task.id, agent.roleId, toolId);
    const open = this.openStages.get(task.id);
    const context = open ?? { ...this.stageContext(task), round: this.round(task) };
    // Design and review rounds come from the stage; a do stage's round is which run of it this is.
    const round = context.kind === "converge" || context.kind === "review-chain" ? this.round(task) : context.round;
    const asked = profile?.modelId ?? profile?.model;
    const ran = quirk.notConfirmed ? undefined : (quirk.ran ?? (asked ? { model: asked, name: toolId === "codex" ? asked : (profile?.model ?? asked), effort: profile?.effort ?? "high" } : undefined));
    const id = this.entryId(`${task.id}-turn`);
    const first = !this.work.turns({ taskId: task.id }).some((turn) => turn.roleId === agent.roleId);
    this.work.addTurn({
      id,
      taskId: task.id,
      productId: task.productId,
      stageId: context.stageId,
      stageTitle: context.title,
      stageKind: context.kind,
      round,
      fixing: task.fixing,
      roleId: agent.roleId,
      toolId,
      profileId: agent.profileId,
      ...(asked ? { modelAsked: asked } : {}),
      ...(profile?.model ? { modelAskedName: profile.model } : {}),
      ...(profile?.effort ? { effortAsked: profile.effort } : {}),
      ...(ran ? { modelRan: ran.model, modelRanName: ran.name, effortRan: ran.effort } : {}),
      ...(first && quirk.changedTo?.model ? { modelChangedTo: quirk.changedTo.model } : {}),
      ...(first && quirk.changedTo?.effort ? { effortChangedTo: quirk.changedTo.effort } : {}),
      sessionId: `${task.id}-agent-${agent.since}`,
      reason,
      startedAt: d.now,
      mainOnly: false,
      helpers: 0,
    });
    this.openTurns.set(task.id, { id, startedAt: d.now, waitedMs: 0, first });
    this.wrote(d);
  }

  private quirkFor(taskId: Id, roleId: Id, toolId: Id): SimQuirk {
    const quirk = this.quirks[`${taskId}|${roleId}`];
    return quirk && (!quirk.toolId || quirk.toolId === toolId) ? quirk : {};
  }

  private endTurn(d: Draft, task: DraftTask, end: TurnEnd): void {
    const open = this.openTurns.get(task.id);
    if (!open) return;
    this.openTurns.delete(task.id);
    const turn = this.work.turn(open.id);
    if (!turn) return;
    const waited = open.waitedMs + (open.waitingSince !== undefined ? d.now - open.waitingSince : 0);
    const workMs = Math.max(0, d.now - open.startedAt - waited);
    const quirk = this.quirkFor(task.id, turn.roleId, turn.toolId);
    const reported = end === "finished" || end === "interrupted";
    const silent = !reported || (open.first && quirk.noTokens);
    const helpers = open.first ? (quirk.helpers ?? 0) : 0;
    const report = silent ? undefined : simReport(`${open.id}|${turn.profileId}`, turn.toolId, turn.modelChangedTo ?? turn.modelRan ?? turn.modelAsked ?? "", turn.roleId, workMs, open.first ? quirk : {});
    const counted = turnTokens({ toolId: turn.toolId, ...(report ? { report } : {}), ...(turn.modelRanName ? { model: turn.modelRanName } : {}), rerouted: turn.toolId === "codex" && turn.modelChangedTo !== undefined, helpers });
    this.work.endTurn(open.id, { end, endedAt: d.now, workMs, mainOnly: counted.mainOnly, helpers, ...(counted.tokens ? { tokens: counted.tokens } : {}) }, counted.lines);
    this.wrote(d);
  }

  /** Fill free slots: tasks already in progress first (the tool with more of its limit left first), then the queue, in priority order. */
  private schedule(d: Draft): void {
    this.syncScreen(d);
    const toolOf = new Map(d.profiles.map((profile) => [profile.id, profile.toolId]));
    const find = (id: Id) => d.tasks.find((entry) => entry.id === id);
    // A task waiting for others to land stays out of the running and says what it waits for.
    const blocked = (task: DraftTask): boolean => {
      const waitingFor = (task.after ?? []).map(find).filter((other): other is DraftTask => !!other && other.state !== "done" && other.state !== "cancelled");
      syncWait(task, waitingFor, find, d.now);
      if (!waitingFor.length) {
        if (task.state === "queued" && task.statusLine.startsWith("Waiting for “")) task.statusLine = task.held ? "On hold" : "In the queue";
        return false;
      }
      task.statusLine = AFTER_WORDS.waiting(waitingFor.map((other) => other.title));
      return true;
    };
    const inProgress = d.tasks.filter((task) => task.state === "waiting").sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const continuing: Candidate[] = [];
    for (const task of inProgress) {
      if (blocked(task)) continue;
      // Waiting for the screen: for the coordinator's OK, or its turn. Its status line says which.
      if (!screenReady(task as Task, d as State, d.now)) continue;
      const next = this.nextAgent(task);
      if (next) {
        const candidate = { taskId: task.id, toolId: toolOf.get(next.profileId) ?? "unknown" };
        task.statusLine = slotWait(d as State, candidate) ?? "Waiting for a free slot";
        continuing.push(candidate);
      }
    }
    const candidates = balanced(continuing, d.pool, d.now);
    for (const queued of queueOf(d.tasks as Task[])) {
      const task = find(queued.id)!;
      // On hold too, a task stops waiting the moment the tasks it waits for land; it just does not start.
      if (blocked(task) || task.held) continue;
      candidates.push({ taskId: task.id, toolId: toolOf.get(this.planner(d)) ?? "unknown" });
    }

    const starts = pickStarts({ candidates, inUse: slotUses(d as unknown as State), pool: d.pool, now: d.now });
    for (const taskId of starts) {
      const task = d.tasks.find((entry) => entry.id === taskId);
      if (!task) continue;
      if (task.state === "queued") {
        task.startedAt = d.now;
        task.stageIndex = -1;
        this.log(d, task, "milestone", "Started from the queue");
      }
      // The screen is this agent's from now until its step ends.
      const asked = task.screen && !task.screen.granted ? task.screen : undefined;
      if (asked) asked.granted = true;
      this.startAgent(d, task);
      if (asked && task.state !== "running") delete asked.granted;
    }
  }
}


function areaFromTitle(title: string): string {
  const words = title.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return words.slice(-2).join(" ") || "this part";
}

function hash(text: string): number {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

const FULL_MODEL: Record<string, string> = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5", fable: "claude-fable-5-1" };

/** Believable token figures for a simulated turn: mostly input reused from the cache, as with the real tools. */
function simReport(seed: string, toolId: Id, model: string, roleId: Id, workMs: number, quirk: SimQuirk): TurnReport {
  const minutes = Math.max(0.3, workMs / 60_000);
  const jitter = (salt: string) => 0.6 + (hash(`${seed}|${salt}`) % 800) / 1000;
  const heavy = roleId === "builder" ? 1.6 : roleId === "code-reviewer" ? 1.1 : roleId === "planner" ? 0.5 : 0.8;
  const scale = minutes * heavy;
  if (toolId === "codex") {
    const output = Math.round(1000 * scale * jitter("out"));
    const counts = { input: Math.round(2800 * scale * jitter("in")), cacheRead: Math.round(30_000 * scale * jitter("cache")), cacheWrite: 0, output, reasoning: Math.round(output * 0.4 * jitter("reason")) };
    return { main: counts, models: [{ model, counts }] };
  }
  const counts = { input: Math.round(900 * scale * jitter("in")), cacheRead: Math.round(38_000 * scale * jitter("cache")), cacheWrite: Math.round(3400 * scale * jitter("write")), output: Math.round(800 * scale * jitter("out")) };
  if (quirk.noBreakdown) return { main: counts };
  const main = FULL_MODEL[model] ?? model;
  const helper = quirk.extraModel ?? (roleId === "builder" && hash(seed) % 3 === 0 ? "claude-haiku-5-5" : undefined);
  const models = [{ model: main, counts }];
  if (helper) {
    const share = 0.08 + (hash(`${seed}|helper`) % 100) / 1000;
    models.push({ model: helper, counts: { input: Math.round(counts.input * share), cacheRead: Math.round(counts.cacheRead * share), cacheWrite: Math.round(counts.cacheWrite * share), output: Math.round(counts.output * share * 1.5) } });
  }
  // The main figure counts the main agent loop only, so it is smaller than the breakdown. Petrina never adds the two.
  return { main: { ...counts, output: Math.round(counts.output * 0.9) }, models };
}

/** The demo shows resolved choices without contacting GitHub. */
function demoSource(product: TaskSource["product"], choice: WorkChoice): TaskSource {
  const branch = choice.startFrom.kind === "branch" ? choice.startFrom.name : choice.startFrom.kind === "pull-request" ? "review-fixes" : product.defaultBranch ?? "main";
  const number = choice.startFrom.kind === "pull-request" ? Number(/(?:pull\/|#)?(\d+)\/?$/.exec(choice.startFrom.value)?.[1] ?? 123) : 0;
  const start: TaskSource["start"] = choice.startFrom.kind === "pull-request" ? { kind: "pull-request", number, url: `https://github.com/${product.repo}/pull/${number}`, headRepo: product.repo, branch } : { kind: choice.startFrom.kind, branch };
  return { product, start, destination: { mode: choice.delivery, kind: start.kind === "pull-request" ? "update-pr" : choice.delivery === "local" ? "branch" : choice.delivery === "release" ? "release" : "new-pr", repo: product.repo, branch, remote: product.remote }, confirmed: true };
}
