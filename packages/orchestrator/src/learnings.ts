import { AGENTS_FILE, cleanPoint, hasPoint, offeredLessons, type DeepMutable, type Id, type InboxItem, type Product, type Role } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import type { RepositoryContext } from "./repository-context.js";

export interface LearningOffersHost {
  current(): { inbox: DeepMutable<InboxItem>[]; products: DeepMutable<Product>[] };
  task(id: Id): RuntimeTask | undefined;
  productOf(target: RuntimeTask | RepositoryContext): DeepMutable<Product> | undefined;
  role(id: Id): Pick<Role, "canEdit" | "name"> | undefined;
  authoritativeFile(scope: RepositoryContext): Promise<string | undefined>;
  offer(scope: RepositoryContext, title: string, details: { body: string; detail: string }, by: { roleId: Id; profileId: Id }): void;
  removeOffer(id: Id): void;
  log(target: RuntimeTask | RepositoryContext, kind: "done" | "you", text: string): void;
  checkpoint(task?: RuntimeTask): void;
  now(): number;
}

/** The most lessons one task offers: the bar is high, so a few is plenty. */
const MAX_LESSONS = 8;

/** Agent notes and coordinator choices; authoritative Git/file observations remain effects. */
export class LearningOffers {
  constructor(private readonly host: LearningOffersHost) {}

  /** An agent's lessons, kept on the task until the delivery check. Repeats, and ones AGENTS.md already has, are left out. */
  async note(scope: RepositoryContext, lessons: readonly (string | { productId: string; text: string })[], roleId: Id, profileId: Id): Promise<void> {
    const { task, work: repository } = scope;
    if (!lessons.length) return;
    const own: string[] = [];
    const companions = new Map<Id, { work: RepositoryContext["work"]; texts: string[] }>();
    for (const lesson of lessons) {
      const text = typeof lesson === "string" ? lesson : lesson.text;
      const id = typeof lesson === "string" ? this.host.role(roleId)?.canEdit ? repository.productId : undefined : lesson.productId;
      if (!task.repositories || id === repository.productId) { own.push(text); continue; }
      const work = id ? task.repositories.find((entry) => entry.productId === id) : undefined;
      if (work) {
        const group = companions.get(work.productId) ?? { work, texts: [] };
        group.texts.push(text);
        companions.set(work.productId, group);
      } else if (!task.sharedLessons?.some((entry) => entry.text === text)) task.sharedLessons = [...(task.sharedLessons ?? []), { text, roleId, profileId, at: this.host.now() }];
    }
    for (const { work, texts } of companions.values()) await this.note({ task, work }, texts.map((text) => ({ productId: work.productId, text })), roleId, profileId);
    if (!own.length) return;
    const known = await this.known(scope);
    for (const raw of own) {
      // The coordinator approves this instruction as written; cutting it can lose a path or a qualification.
      const text = cleanPoint(raw);
      // Changed wording may correct an old instruction. Only repeated text is already covered.
      if (text.length < 8 || hasPoint(known, text) || (repository.lessons ?? []).some((lesson) => hasPoint(lesson.text, text))) continue;
      if ((repository.lessons?.length ?? 0) >= MAX_LESSONS) break;
      repository.lessons = [...(repository.lessons ?? []), { text, roleId, profileId, at: this.host.now() }];
    }
  }

  /** Keep the original product reference across the authoritative file read, then observe its live accepted queue. */
  private async known(scope: RepositoryContext): Promise<string> {
    const product = this.host.productOf(scope);
    const file = await this.host.authoritativeFile(scope);
    return [file, ...(product?.learnings ?? []).map((line) => line.text), ...(product?.learningsDeclined ?? [])].join("\n");
  }

  /** Lessons that AGENTS.md, or the coordinator's answers, have covered since they were noted. */
  private covered(known: string, text: string): boolean {
    return hasPoint(known, text);
  }

  /** At the delivery check, offer current uncovered lessons without blocking its current step. */
  async offer(scope: RepositoryContext): Promise<void> {
    const { task, work: repository } = scope;
    const product = this.host.productOf(scope);
    if (!product || !repository.lessons?.length) {
      delete repository.lessons;
      return;
    }
    const known = await this.known(scope);
    const lessons = repository.lessons.filter((lesson) => !this.covered(known, lesson.text));
    delete repository.lessons;
    if (!product || !lessons.length) return;
    const from = [...new Set(lessons.map((lesson) => this.host.role(lesson.roleId)?.name ?? lesson.roleId))];
    const state = task.state;
    this.host.offer(
      scope,
      `What agents learned about ${product.name}`,
      {
        body: lessons.map((lesson) => `- ${lesson.text}`).join("\n"),
        detail: `From the ${from.join(" and the ")}. What you add joins the Learnings section of ${AGENTS_FILE} with the next delivery. Claude Code and Codex both read that file by themselves, whether Petrina starts them or you do.`,
      },
      { roleId: lessons[0]!.roleId, profileId: lessons[0]!.profileId },
    );
    task.state = state;
    this.host.log(scope, "done", `Agents passed on ${lessons.length === 1 ? "a lesson" : `${lessons.length} lessons`} about working in this repository: offered to you`);
  }

  /** Accepted instructions wait for the native writer at a delivery boundary. */
  accept(itemId: Id, keep?: readonly number[]): void {
    const item = this.host.current().inbox.find((entry) => entry.id === itemId && entry.kind === "learnings");
    if (!item) return;
    this.host.removeOffer(itemId);
    const task = this.host.task(item.taskId);
    const product = task && (item.productId ? this.host.current().products.find((entry) => entry.id === item.productId) : this.host.productOf(task));
    if (!task || !product) return;
    // The ones the coordinator ticked, by their place in the offer; all of them when it says nothing.
    const offered = offeredLessons(item.body);
    const lessons = offered.filter((_, index) => !keep || keep.includes(index));
    this.remember(product, offered.filter((text) => !lessons.includes(text)));
    const added = lessons.filter((text) => !product.learnings?.some((line) => hasPoint(line.text, text)));
    product.learnings = [...(product.learnings ?? []), ...added.map((text) => ({ text, at: this.host.now(), fromTask: task.id }))];
    this.host.log(task, "you", `You added ${added.length === 1 ? "a lesson" : `${added.length} lessons`} to ${AGENTS_FILE}`);
    this.host.checkpoint(task);
  }

  /** Declining changes only the remembered choices, never the repository file. */
  decline(itemId: Id): void {
    const item = this.host.current().inbox.find((entry) => entry.id === itemId && entry.kind === "learnings");
    if (!item) return;
    this.host.removeOffer(itemId);
    const task = this.host.task(item.taskId);
    const product = task && (item.productId ? this.host.current().products.find((entry) => entry.id === item.productId) : this.host.productOf(task));
    if (product) this.remember(product, (item.body ?? "").split("\n").map((line) => cleanPoint(line.replace(/^- /, ""))).filter(Boolean));
    if (task) this.host.log(task, "you", `You left ${AGENTS_FILE} as it is`);
    this.host.checkpoint(task);
  }

  private remember(product: DeepMutable<Product>, declined: readonly string[]): void {
    if (!declined.length) return;
    product.learningsDeclined = [...(product.learningsDeclined ?? []), ...declined].slice(-100);
  }
}
