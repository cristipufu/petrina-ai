// What a notification says. Plain words: what is needed, for which task and product, and who is
// asking. Never the command behind a permission, the error of a stuck task, or a link: those stay
// in the app, since notifications can show on the lock screen and stay in the system's history.

import type { InboxItem, InboxKind, State } from "@petrina/core";

/** Where a click on a notification, or View on an in-app message, leads. */
export type Target = { kind: "item"; id: string } | { kind: "inbox" };

/** One notification, or one in-app message. */
export interface Notice {
  title: string;
  /** Shown under the title, one per line. */
  lines: readonly string[];
  /** The inbox items it is about: one, or two or more for a summary. */
  itemIds: readonly string[];
  target: Target;
}

const QUESTION_MAX = 140;
const REQUEST_MAX = 100;
const NAME_MAX = 60;

/** Markdown links keep their words; every web address, with or without a scheme, becomes "a link". */
const MARKDOWN_LINK = /\[([^\]\n]*)\]\([^)\s]*\)/g;
const TRAILING = /[.,;:!?)\]}'"]+$/;

// A name ending in one of these is an address on its own: example.com, shop.example.co.uk,
// my-app.vercel.app. Left out, so file names and code stay readable: country codes that are also
// everyday file types (README.md, setup.py, main.rs, run.sh, model.pt) and ones that read as code
// (item.id, Object.is). Those still count as addresses with a scheme, www. or a path.
const COUNTRY =
  "ad ae af ag ai al ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bm bn bo br bs bt bw by bz ca cd cf cg ch ci ck cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg er es et eu fi fj fk fm fo fr ga ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu ie il im io iq ir it je jm jo jp ke kg kh ki km kn kp kr kw ky kz lb lc li lk lr ls lt lu lv ly ma mc me mg mh mn mp mq mr ms mt mu mv mw mx my mz na ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pn pr pw qa ro ru rw sa sb sc sd se sg si sk sl sm sn sr ss st su sv sx sy sz tc td tg th tj tk tl tm tn to tr tt tv tw tz ua ug uk us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw";
const GENERIC = "com net org edu gov info biz app dev xyz club online tech website news blog localhost lan internal test example invalid arpa onion";
const TLD = `(?:${`${GENERIC} ${COUNTRY}`.split(" ").join("|")})`;
const LABELS = String.raw`(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+`;
const REST = String.raw`[^\s<>"'\`]*`;
const PORT_PATH = String.raw`(?::\d{1,5})?(?:[/?#]${REST})?`;
const IPV4 = String.raw`(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)`;
const HEX = String.raw`[0-9a-f]{1,4}`;
const IPV6 = String.raw`\[[0-9a-f.]*:[0-9a-f.]*:[0-9a-f:.]*\]|(?:${HEX}:){7}${HEX}|${HEX}(?::${HEX})*::(?:${HEX}(?::${HEX})*)?|::${HEX}(?::${HEX})*`;

/** With a scheme or www.: https://…, ftp://…, mailto:…, www.example.org. */
const WITH_SCHEME = new RegExp(String.raw`\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)${REST}`, "gi");
/** Git's own form: git@github.com:org/repo. */
const GIT_REMOTE = new RegExp(String.raw`\b[\w.+-]+@${LABELS}[a-z]{2,}:${REST}`, "gi");
const EMAIL = new RegExp(String.raw`\b[\w.+-]+@${LABELS}[a-z]{2,}\b`, "gi");
/** Any dotted name with a path after it: docs.example.md/setup. */
const WITH_PATH = new RegExp(String.raw`\b${LABELS}[a-z]{2,}\/${REST}`, "gi");
/** A bare domain, this machine, or a local name with a port: example.com, localhost:3000, printer.local:631. */
const BARE = new RegExp(String.raw`(?<![\w@/\\.-])(${LABELS}${TLD}|${LABELS}local(?=:\d)|localhost)(?![a-z0-9-]|\.[a-z0-9]|\()${PORT_PATH}`, "gi");
/** IP addresses: 192.168.1.20:8080, 10.0.0.1/admin, [::1]:5173, fe80::1. */
const IP = new RegExp(String.raw`(?<![\w.:])(?:${IPV4}|${IPV6})(?::\d{1,5})?(?![\w.:]*\w)(?:[/?#]${REST})?`, "gi");

function link(address: string): string {
  return `a link${TRAILING.exec(address)?.[0] ?? ""}`;
}

/** Web addresses become "a link" and email addresses "an email address". */
function withoutAddresses(text: string): string {
  return (
    text
      .replace(WITH_SCHEME, link)
      .replace(GIT_REMOTE, link)
      .replace(EMAIL, "an email address")
      .replace(WITH_PATH, link)
      // "Done.It works" is a missing space, not an address.
      .replace(BARE, (address, host: string) => (/\.[A-Z][a-z]+$/.test(host) ? address : link(address)))
      .replace(IP, link)
      // Whatever still holds a scheme's :// is cut out whole.
      .replace(/\S*:\/\/\S*/g, "a link")
  );
}

/** Cut to `max` characters at a word where it can, with an ellipsis. */
export function shorten(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max - 1).join("");
  const space = cut.lastIndexOf(" ");
  const words = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${words.replace(/[\s,;:.-]+$/, "")}…`;
}

/** Text written by an agent or the coordinator, made safe to show outside the app. */
export function plainWords(text: string, max: number): string {
  const marked = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(MARKDOWN_LINK, (_whole, label: string) => label.trim() || "a link")
    .replace(/`+|\*\*/g, "");
  const words = withoutAddresses(marked).replace(/\s+/g, " ").trim();
  return shorten(words, max);
}

/** Who is asking: the role the item records, otherwise Petrina. Never a made-up agent, never blank. */
export function whoAsks(item: InboxItem, state: State): string {
  const role = item.roleId ? state.roles.find((entry) => entry.id === item.roleId) : undefined;
  return role?.name.trim() || "Petrina";
}

function taskName(item: InboxItem, state: State): string {
  const task = state.tasks.find((entry) => entry.id === item.taskId);
  return (task && plainWords(task.title, NAME_MAX)) || "A task";
}

function productName(item: InboxItem, state: State): string | undefined {
  const task = state.tasks.find((entry) => entry.id === item.taskId);
  const product = task && state.products.find((entry) => entry.id === task.productId);
  return (product && plainWords(product.name, NAME_MAX)) || undefined;
}

/**
 * What a permission asks for, in the engine's plain words ("Installing packages"). When those
 * words repeat the command itself, a plain line takes their place: the command stays in the app.
 */
function request(item: InboxItem): string {
  const words = plainWords(item.title, REQUEST_MAX);
  const said = words.toLowerCase();
  const command = (item.detail ?? "")
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length >= 4);
  const repeats = command.some((line) => said.includes(line.slice(0, 40)) || line.includes(said));
  return !words || repeats ? "It wants your OK before going ahead" : words;
}

/** What is needed, and who is asking. Only a stuck task names the task here: the rest say it below. */
const NEED: Record<InboxKind, (who: string, task: string) => string> = {
  question: (who) => `${who} has a question`,
  permission: (who) => `${who} needs your permission`,
  plan: (who) => `${who}: a plan needs your OK`,
  design: (who) => `${who}: a design needs your check`,
  disagreement: (who) => `${who}: the architects need your call`,
  delivery: (who) => `${who}: a task is ready to ship`,
  stuck: (who, task) => `${who}: ${task} is stuck`,
  shipping: (who) => `${who}: shipping a task was interrupted`,
};

/** The notification for one inbox item. */
export function noticeFor(item: InboxItem, state: State): Notice {
  const who = whoAsks(item, state);
  const task = taskName(item, state);
  const product = productName(item, state);
  const detail = item.kind === "question" ? plainWords(item.title, QUESTION_MAX) : item.kind === "permission" ? request(item) : undefined;
  // A stuck task's error never leaves the app; its title already names the task.
  const where = item.kind === "stuck" ? product : product ? `${task}, ${product}` : task;
  return {
    title: NEED[item.kind](who, task),
    lines: [detail, where].filter((line): line is string => Boolean(line)),
    itemIds: [item.id],
    target: { kind: "item", id: item.id },
  };
}

/** Several items held during a pause, in one notification naming up to two of their tasks. */
export function summaryOf(items: readonly InboxItem[], state: State): Notice {
  const tasks = [...new Set(items.map((item) => taskName(item, state)))];
  const named = tasks.slice(0, 2);
  const rest = tasks.length - named.length;
  const line = rest > 0 ? `${named.join(", ")} and ${rest} more ${rest === 1 ? "task" : "tasks"}` : named.join(" and ");
  return {
    title: `${items.length} more things need you`,
    lines: [line],
    itemIds: items.map((item) => item.id),
    target: { kind: "inbox" },
  };
}

/** The short line an open dialog shows while a click waits for it to close. */
export function waitingLine(item: InboxItem, state: State): string {
  const notice = noticeFor(item, state);
  return item.kind === "stuck" ? notice.title : `${notice.title}. ${taskName(item, state)}`;
}

/** The test notification from Settings. */
export const TEST_NOTICE: Pick<Notice, "title" | "lines"> = {
  title: "Petrina",
  lines: ["This is a test. When the squad needs you, notifications show up like this."],
};
