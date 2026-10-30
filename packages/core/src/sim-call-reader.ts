// Plain-language coordinator call parser and objection answer generator for offline demos.
import type { CallAnswer } from "./call.js";
import type { Id, Objection } from "./model.js";

type Verdict = "accepted" | "rejected";
type Point = Pick<Objection, "id" | "text" | "blocking">;

/** These reply labels still refer to the side, not an objection's subject. */
const REPLY = "(?:['’]s\\s+(?:answers?|notes?|confirmations?)\\b)?";
/** "Accept" or "reject" (of the architect's points, the other way round), or siding with either side. */
const VERDICT = new RegExp(
  `\\b(accept|reject)(?:s|ed|ing)?\\b(\\s+(?:the\\s+)?(?:design\\s+)?architect\\b${REPLY})?|\\b(sid(?:e|es|ed|ing)\\s+)?with\\s+(?:the\\s+)?(?:design\\s+)?(reviewer|architect)\\b${REPLY}`,
  "g",
);
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
const EMPHASIS = new RegExp(
  `\\b${EMPHASIS_WORDS}\\b(?=[\\s.!?;,:()–—-]*$|\\s+(?:(?:do\\s+)?not\\s+|never\\s+|don't\\s+)?(?:accept|reject|side\\s+with)\\b)`,
  "g",
);
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
const NAMING = new Set([
  "a",
  "an",
  "the",
  "and",
  "plus",
  "also",
  "too",
  "as",
  "well",
  "both",
  "one",
  "ones",
  "point",
  "points",
  "objection",
  "objections",
  "issue",
  "about",
  "for",
  "of",
  "on",
  "in",
  "to",
  "with",
  "its",
  "s",
  "reviewer",
  "architect",
  "minor",
  "blocking",
  "blocker",
  "blockers",
  "non",
  "suggestion",
  "suggestions",
  "nice",
  "have",
  "only",
  "just",
  "all",
  "everything",
  "else",
  "rest",
  "other",
  "others",
]);
/** Words in the reviewer's objections that never name one: everyday words, and words about the brief rather than its subject. */
const PLAIN = [
  "already",
  "answer",
  "brief",
  "changed",
  "consider",
  "does",
  "down",
  "everyone",
  "happens",
  "have",
  "know",
  "last",
  "left",
  "much",
  "people",
  "show",
  "still",
  "that",
  "this",
  "updated",
  "what",
  "when",
];

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
    const ownWord = (word: string) =>
      word.length >= 4 && !PLAIN.includes(word) && known.some((other) => word === other || `${word}s` === other || word === `${other}s`);
    const ordinary = (word: string, index: number) =>
      !!described?.length && index > about && described.some((point) => wordsOf(point.text).includes(word));
    return words.every((word, index) => NAMING.has(word) || ownWord(word) || ordinary(word, index));
  };
  /**
   * Descriptions use the same point names as decisions and lists, including "confirmation step"
   * or "suggestion". Only a name touching "that/which" can own the description: punctuation or
   * a verb between them leaves it about the choice. Remove it once, before reading any clauses,
   * so joined names and exceptions work exactly like their plain counterparts.
   */
  const withoutPointDetails = (sentence: string) =>
    sentence.replace(POINT_DETAIL, (detail, at: number) => {
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
      .replace(INDEPENDENT, (clause) => (independent ? " " : clause));
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
        pieces.push({
          text: `${part.slice(0, at)} ${object}`,
          verdict: accepts !== !!turned ? "accepted" : "rejected",
          siding: !verb[1],
          unclear: UNCLEAR.test(besides),
          refers,
          needsPoint: /^\s*(?:it\s*)?[,:()–—-][\s,:()–—-]*$/.test(object),
        });
        continuation = `${turned ? "not " : ""}${verb[1] ?? "side with"}`;
      });
    });
    const here = new Map<Id, Verdict>();
    const every = new Set<Verdict>();
    const referenced = new Set<Id>();
    // Removing the emphasis must not turn the contradictory "without exception, except ..." into a clear call.
    const openSaying = ACTION_OPEN.test(text);
    let unclear =
      UNCERTAIN.test(text) || openSaying || /\bwithout\s+exception\b[\s,:()–—-]*(?:except|apart\s+from|other\s+than)\b/.test(sentence);
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
      const before = at === first ? pieces.slice(0, at).map((other) => other.text) : (leading.get(at) ?? []);
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
      const listed = after
        .filter((clause) => LIST.test(clause) && !APART.test(clause) && nameOnly(clause) && !ASIDE_MENTION.test(clause))
        .flatMap((clause) => named(clause) ?? []);
      const topic = before
        .map((clause) => clause.replace(/^\s*(?:(?:and|plus)\s+)?regarding\s+/, ""))
        .filter((clause) => !APART.test(clause) && !OPEN.test(clause) && nameOnly(clause))
        .flatMap((clause) => named(clause) ?? []);
      // A name immediately after punctuation is still the decision's object, not an explanation.
      const adjacent = after.find((clause) => /[a-z]/.test(clause));
      const attached = own?.length === 0 && piece.needsPoint && adjacent && nameOnly(adjacent) ? named(adjacent) : [];
      let points =
        own === undefined || attached === undefined
          ? undefined
          : own.length || listed.length || attached.length
            ? [...own, ...listed, ...attached]
            : topic;
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
    if (corrected) {
      return {
        id,
        status: corrected,
        byCall: tagged !== undefined,
        answer:
          corrected === "accepted"
            ? `Changed the ${area} flow in the brief to cover it, as your note says.`
            : `Took this out of the ${area} flow, as your note says.`,
      };
    }
    if (note !== undefined && (status === "accepted" || status === "rejected")) {
      const kept = tagged !== undefined;
      const answer =
        status === "accepted"
          ? kept
            ? `Changed the ${area} flow in the brief to your note, still following your call.`
            : `Changed the ${area} flow in the brief to your note. It still covers this.`
          : kept
            ? `Still left out of the ${area} flow after your note, as your call says.`
            : "Still out of scope after your note. Kept in risks.";
      return { id, status, byCall: kept, answer };
    }
    const decided = byCall.get(id);
    if (decided) {
      return {
        id,
        status: decided,
        byCall: true,
        answer:
          decided === "accepted"
            ? `Changed the ${area} flow in the brief to follow your call.`
            : `Left this out of the ${area} flow, as your call says.`,
      };
    }
    return blocking
      ? { id, status: "accepted", byCall: false, answer: "Your call does not speak to this one. Changed the design to cover it." }
      : { id, status: "rejected", byCall: false, answer: "Out of scope for this task. Added to risks." };
  });
}
