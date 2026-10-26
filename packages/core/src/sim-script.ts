// Scripted responses and believable tool reports for the offline demos. No engine bookkeeping.
import { callOn, type CallAnswer } from "./call.js";
import type { DeepMutable } from "./flow.js";
import type { CheckExecutorFacts, CheckRun, DesignBrief, Id, Objection, Product, Role, Task, TaskKind } from "./model.js";
import type { TaskSource, WorkChoice } from "./source.js";
import type { TurnReport } from "./worklog.js";
import type { SimQuirk } from "./sim-types.js";
import { taskProductIds } from "./repositories.js";
import { commandText } from "./check-commands.js";

/** Opaque offline-model identities, not cryptographic hashes or observed native source identities. */
function modeledIdentity(value: unknown): string {
  const text = JSON.stringify(value);
  return Array.from({ length: 8 }, (_, lane) => hash(`offline-demo:${lane}:${text}`).toString(16).padStart(8, "0")).join("");
}

/** Stable synthetic contents, changed only by a completed demo build. */
export function simVersions(task: Task, buildStep?: Id): Record<Id, string> {
  return Object.fromEntries(taskProductIds(task).map(id => {
    const recorded = task.journey?.findLast(step => step.buildVersions?.[id])?.buildVersions?.[id];
    return [id, buildStep ? modeledIdentity(["version", task.id, id, buildStep])
      : recorded ? /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(recorded) ? recorded : modeledIdentity(["legacy-version", recorded])
      : modeledIdentity(["version", task.id, id, "initial"])];
  }));
}

/** Only a simulated completed check run creates these explicitly modeled observations; no argv is executed. */
export function simCheckSetup(product: Pick<Product, "id" | "checks" | "checkSetup">, tree: string, at: number,
  ids: { before: Id; after: Id }, invalidationId?: Id) {
  const executor: CheckExecutorFacts = { version: 1, adapter: "offline-demo-simulation", contract: 1, launchPolicy: 1,
    platform: "simulated", architecture: "simulated", osRelease: "simulated", runtime: { name: "simulated", version: "1" } };
  const requirements = (product.checkSetup?.requirements ?? []).map(requirement => ({ ...requirement, argv: [...requirement.argv] }));
  const contract = modeledIdentity(["setup", product.checkSetup?.revision ?? "undeclared", requirements]);
  const input = { tree, definition: modeledIdentity(["commands", product.checks, DEMO_CHECKS.map(run => [run.name, run.command])]), contract,
    ...(invalidationId ? { invalidationId } : {}) };
  const empty = { algorithm: "sha256" as const, bytes: 0, digest: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" };
  const identity = { version: 1 as const, contract, executor: modeledIdentity(["executor", executor]),
    prerequisites: requirements.length ? { kind: "declared" as const, observations: modeledIdentity(["empty-modeled-output", requirements.map(requirement => requirement.id)]) } : { kind: "none" as const } };
  const attempt = (position: "before-checks" | "after-checks", id: Id) => ({ id, productId: product.id, queuedAt: at, startedAt: at, endedAt: at,
    lifecycle: "settled" as const, position, input: { ...input }, requirements: requirements.map(requirement => ({ ...requirement, argv: [...requirement.argv] })), executor,
    results: requirements.map(requirement => ({ requirementId: requirement.id, run: { name: requirement.name, command: commandText(requirement.argv), ok: true, ms: 0, output: "",
      execution: { started: true, exit: { status: "reported" as const, code: 0 }, stdout: "eof" as const, stderr: "eof" as const, timedOut: false, cancelled: false,
        cleanup: "not-requested" as const, outputCleanup: "not-requested" as const }, executor, outputIdentity: { stdout: { ...empty }, stderr: { ...empty } } } })),
    afterInput: { ...input, trackedChanged: false }, restoration: "unchanged" as const, identity });
  return { before: attempt("before-checks", ids.before), after: attempt("after-checks", ids.after), executor,
    input, environment: { ...identity, setupAttempts: { ...ids } } };
}

export function simAcceptance(task: Task) {
  return (task.brief?.acceptance ?? []).map((item) => ({ text: item.text, result: "pass" as const,
    evidence: `Demo scenario: ${item.text}. The simulated user flow met this requirement.`,
    productIds: item.productIds ?? taskProductIds(task),
  }));
}

export const DEMO_RISK: Record<TaskKind, { level: "low" | "medium" | "high"; why: string }> = {
  new: { level: "high", why: "A new product: everything it touches is new, sign-in included." },
  feature: { level: "medium", why: "New behaviour in one part of the product." },
  bug: { level: "medium", why: "A fix to how people sign in and pay, in one place." },
  chore: { level: "low", why: "Only words and styles change: nothing can be lost or opened up." },
};
/** Scripted completed-check observations for offline demos, never loaded execution evidence. */
export const DEMO_CHECKS: CheckRun[] = [
  { name: "Type check", command: "bun run typecheck", ok: true, execution: { started: true, exit: { status: "reported", code: 0 }, stdout: "eof", stderr: "eof", timedOut: false, cancelled: false, cleanup: "not-requested", outputCleanup: "not-requested" }, ms: 9_000, output: "No errors." },
  { name: "Tests", command: "bun run test", ok: true, execution: { started: true, exit: { status: "reported", code: 0 }, stdout: "eof", stderr: "eof", timedOut: false, cancelled: false, cleanup: "not-requested", outputCleanup: "not-requested" }, ms: 41_000, output: "212 pass\n0 fail\nRan 212 tests across 31 files." },
  { name: "Build", command: "bun run build", ok: true, execution: { started: true, exit: { status: "reported", code: 0 }, stdout: "eof", stderr: "eof", timedOut: false, cancelled: false, cleanup: "not-requested", outputCleanup: "not-requested" }, ms: 23_000, output: "Built in 22.4s." },
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
export function scriptFor(role: Role | undefined, ctx: ScriptContext): Moment[] {
  return itemsFor(role, ctx).flatMap(([todo, ...actions]): Moment[] => [{ todo }, ...actions.map((action) => ({ action }))]);
}

/** What a design reviewer that keeps objecting raises after the first round. */
export function laterObjections(area: string, round: number): { text: string; blocking: boolean }[] {
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
export function callAnswers(area: string, due: readonly Objection[], call: string, note?: string): CallAnswer[] {
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

export function briefFor(task: DeepMutable<Task>): DeepMutable<DesignBrief> {
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

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function areaFromTitle(title: string): string {
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
export function simReport(seed: string, toolId: Id, model: string, roleId: Id, workMs: number, quirk: SimQuirk): TurnReport {
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
export function demoSource(product: TaskSource["product"], choice: WorkChoice): TaskSource {
  const branch = choice.startFrom.kind === "branch" ? choice.startFrom.name : choice.startFrom.kind === "pull-request" ? "review-fixes" : product.defaultBranch ?? "main";
  const number = choice.startFrom.kind === "pull-request" ? Number(/(?:pull\/|#)?(\d+)\/?$/.exec(choice.startFrom.value)?.[1] ?? 123) : 0;
  const start: TaskSource["start"] = choice.startFrom.kind === "pull-request" ? { kind: "pull-request", number, url: `https://github.com/${product.repo}/pull/${number}`, headRepo: product.repo, branch } : { kind: choice.startFrom.kind, branch };
  return { product, start, destination: { mode: choice.delivery, kind: start.kind === "pull-request" ? "update-pr" : choice.delivery === "local" ? "branch" : choice.delivery === "release" ? "release" : "new-pr", repo: product.repo, branch, remote: product.remote }, confirmed: true };
}
