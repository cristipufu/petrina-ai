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

/** Markdown links keep their words; web addresses, with or without a scheme, become "a link". */
const MARKDOWN_LINK = /\[([^\]\n]*)\]\([^)\s]*\)/g;
const ADDRESS = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:)[^\s<>"'`]*|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/[^\s<>"'`]*/gi;
const TRAILING = /[.,;:!?)\]}'"]+$/;

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
  const words = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(MARKDOWN_LINK, (_whole, label: string) => label.trim() || "a link")
    .replace(ADDRESS, (address) => `a link${TRAILING.exec(address)?.[0] ?? ""}`)
    .replace(/`+|\*\*/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
