import { createTaskState, findingImages, followUpBlock, followUpDescription, followUpKey, followUpSnapshot, followUpTitle, planFollowUps, productsOn, takesFollowUps, completeAll, type DeepMutable, type FollowUpCredit, type FollowUpCreate, type FollowUpLink, type Id, type ReportImage, type Task } from "@petrina/core";
import type { RuntimeTask } from "./model.js";
import type { FollowUpLinkHost } from "./ports/follow-up-links.js";

function stored(report: FollowUpCredit): DeepMutable<NonNullable<Task["followUp"]>["reports"][number]> {
  return {
    taskId: report.taskId,
    findingId: report.findingId,
    sourceTitle: report.sourceTitle,
    text: report.text,
    steps: report.steps,
    evidence: report.evidence,
    raisedBy: report.raisedBy,
    ...(report.roleId ? { roleId: report.roleId } : {}),
    productIds: [...report.productIds],
    ...(report.reasons?.length ? { reasons: [...report.reasons] } : {}),
    at: report.at,
  };
}

/** Serialized application of actual follow-up plans and coordinator links. */
export class FollowUpLinks {
  constructor(private readonly host: FollowUpLinkHost) {}
  private tail: Promise<void> = Promise.resolve();

  stop(): Promise<void> { return this.tail; }

  noteDone(task: RuntimeTask): Promise<void> {
    if (task.state !== "done") return Promise.resolve();
    const release = this.host.hold(task.id);
    const job = this.enqueue(() => this.apply());
    void job.then(release, release);
    return job;
  }

  catchUp(): Promise<void> {
    return this.enqueue(() => this.apply());
  }

  trackFinding<T>(taskId: Id, findingId: Id, targetTaskId: Id, record: (link: { taskId: Id; findingId: Id; targetTaskId: Id }) => T): Promise<T> {
    const releaseSource = this.host.hold(taskId);
    const releaseTarget = this.host.hold(targetTaskId);
    return this.enqueue(async () => {
      const validate = () => {
        if (this.host.stopped()) throw new Error("Petrina stopped before the link could be saved.");
        const source = this.host.task(taskId);
        const finding = source?.findings.find(entry => entry.id === findingId);
        if (!source || !finding) throw new Error("That source report does not exist.");
        if (source.state !== "done" || followUpBlock(finding) !== undefined || (finding.verification && finding.verification.verdict !== "pre-existing"))
          throw new Error("Only a complete confirmed older bug on a done task can be linked.");
        if (finding.tracking && "taskId" in finding.tracking && finding.tracking.taskId !== targetTaskId)
          throw new Error("This report is already tracked in another task.");
        if (!finding.tracking) throw new Error("Automatic tracking has not finished for this report.");
        const key = followUpKey(taskId, findingId);
        // A saved destination survives either task moving to History. A same-target request may
        // finish an interrupted copy; a different target must not acquire the same report.
        const assigned = this.assignments(taskId, findingId);
        if (assigned.some(id => id !== targetTaskId)) throw new Error("This report is already assigned to another task.");
        if (!assigned.length && (this.host.current().followUpPending ?? []).some(group => !group.retry && group.keys.includes(key)))
          throw new Error("Petrina is still linking this report. Try again after that finishes.");
        const target = this.host.task(targetTaskId);
        if (!target) throw new Error("The target task does not exist.");
        if (target.id === source.id) throw new Error("A report cannot be tracked in its own task.");
        if (target.state === "cancelled") throw new Error("The target task was cancelled.");
        if (target.kind !== "bug") throw new Error("The target must be a bug task.");
        if ((this.host.current().followUpPending ?? []).some(group => !group.retry && group.keys.includes(key)) && !target.followUp?.reports.some(report => report.taskId === taskId && report.findingId === findingId))
          throw new Error("Petrina is still linking this report. Try again after that finishes.");
        const report = followUpSnapshot([source as Task]).reports.find(entry => entry.findingId === findingId)!;
        const products = productsOn(target);
        if (!report.productIds.length || !report.productIds.every(id => products.includes(id)))
          throw new Error("The target task must cover every product in the report.");
        if (!("taskId" in finding.tracking) && target.state === "done" && report.images.some(image => this.host.picturePresent(image)))
          throw new Error("The original still has pictures. Choose an open bug task to keep them.");
        return { source, finding, target, report, key };
      };
      const initial = validate();
      const link = { taskId, findingId, targetTaskId };
      if ("taskId" in initial.finding.tracking!) return this.host.atomic(() => record(link));
      // Prepare pictures without changing the task. A copy failure leaves the report untracked.
      const prepared = { ...initial.target, session: [...initial.target.session] };
      const sessionLength = prepared.session.length;
      const credit: FollowUpCredit = {
        ...initial.report,
        steps: initial.report.steps!.trim(),
        evidence: initial.report.evidence!.trim(),
      };
      let saved = false;
      try {
        if (initial.target.state !== "done" && !await this.keepImages(prepared, [credit]))
          throw new Error("The pictures could not be copied. The report is still untracked; try again with a new request reference.");
        // Work can finish while pictures are copying. Recheck before changing either task.
        const { source, finding, target, key } = validate();
        const before = { session: target.session, followUp: target.followUp, tracking: finding.tracking, pending: this.host.current().followUpPending };
        let result: T;
        try {
          result = this.host.atomic(() => {
            if (target.state !== "done") {
              target.session = [...target.session, ...prepared.session.slice(sessionLength)];
              const followUp = target.followUp ?? { reports: [], preserveRequest: true };
              if (!followUp.reports.some(entry => entry.taskId === taskId && entry.findingId === findingId))
                target.followUp = { ...followUp, reports: [...followUp.reports, stored(credit)] };
            }
            finding.tracking = { taskId: targetTaskId };
            this.host.current().followUpPending = (this.host.current().followUpPending ?? []).map(group => ({ ...group, keys: group.keys.filter(entry => entry !== key) })).filter(group => group.keys.length);
            if (!this.host.current().tasks.includes(source)) this.host.saveArchived(source);
            return record(link);
          });
        } catch (error) {
          target.session = before.session;
          if (before.followUp) target.followUp = before.followUp;
          else delete target.followUp;
          finding.tracking = before.tracking;
          this.host.current().followUpPending = before.pending;
          throw error;
        }
        saved = true;
        this.host.changed(source);
        if (target.state !== "done") this.host.changed(target);
        return result;
      } finally {
        if (!saved) for (const line of prepared.session.slice(sessionLength)) for (const image of line.images ?? [])
          await this.host.discardPreparedPicture(targetTaskId, image.id);
      }
    }).finally(() => { releaseSource(); releaseTarget(); });
  }

  beforeRemoval(task: RuntimeTask): Promise<void> {
    if (task.state !== "done") return Promise.resolve();
    const release = this.host.hold(task.id);
    return this.enqueue(async () => {
      await this.apply();
      // The copy did not land. Leave the original so the next pass can try again.
      if (this.picturesStillDue(task.id)) throw new Error("A follow-up picture is still on the original task");
    }).finally(release);
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.host.track(this.tail.then(work, work));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async apply(): Promise<void> {
    if (this.host.stopped()) return;
    const assigned = this.pending();
    const plan = await planFollowUps(followUpSnapshot(this.tasks(), assigned), (ask) => this.host.match(ask));
    if (this.host.stopped()) return;
    const pending = [
      ...plan.created.map((entry) => ({ keys: [...entry.keys] })),
      ...plan.linked.map((entry) => ({ keys: [...entry.keys], cardId: entry.cardId })),
      ...plan.pending.map((group) => ({ keys: [...group.keys], ...(group.cardId ? { cardId: group.cardId } : {}), ...(group.retry ? { retry: true } : {}) })),
    ];
    // An empty pass must not save. That save retires a finished task still being updated, and a full disk
    // would fail outside the task's own cleanup. The next catch-up records a link that is still missing.
    if (!plan.created.length && !plan.linked.length && !plan.tracks.length && !plan.released.length && samePending(this.host.current().followUpPending, pending)) return;
    try {
      // Keep a saved retry until the link itself is saved. Replacing the list first drops an archived
      // report, and a restart never sees it again.
      const released = new Set(plan.released.map(entry => followUpKey(entry.taskId, entry.findingId)));
      const previous = this.pending().map(group => ({ ...group, keys: group.keys.filter(key => !released.has(key) && !this.linkedKey(key)) })).filter(group => group.keys.length);
      this.host.current().followUpPending = mergePending(previous, pending);
      this.save();
      for (const release of plan.released) this.releaseReport(release);
      // Reports whose link did not finish in this pass. Their tracking waits.
      const untracked = new Set<string>();
      for (const create of plan.created) {
        // A judgment that arrived while the match was running can withdraw a report before the card is written.
        const reports = create.reports.filter((report) => this.stillOlder(followUpKey(report.taskId, report.findingId)));
        const keys = create.keys.filter((key) => reports.some((report) => followUpKey(report.taskId, report.findingId) === key));
        if (!reports.length) continue;
        const ready = { ...create, reports, keys, productIds: [...new Set(reports.flatMap((report) => report.productIds))] };
        const card = this.cardFor(ready);
        const release = this.retain(card.id, reports);
        try {
          this.assign(keys, card.id);
          this.save();
          await this.copyThenTrack(card, reports, keys, card.id, untracked);
          this.save();
        } finally { release(); }
      }
      for (const link of plan.linked) {
        const cardId = this.destination(link.cardId);
        const live = this.host.current().tasks.find((task) => task.id === cardId);
        const reports = link.reports.filter((report) => this.stillOlder(followUpKey(report.taskId, report.findingId)));
        const keys = link.keys.filter((key) => reports.some((report) => followUpKey(report.taskId, report.findingId) === key));
        if (!reports.length) continue;
        // Read the card as it is now, with the rule that listed it: queueing or starting it keeps it.
        const open = !!live && takesFollowUps(live as Task, reports);
        // A destination saved by an earlier pass is never swapped for another card, even when it cannot take the link yet.
        if (!open && assigned.some(group => group.cardId && group.keys.some(key => keys.includes(key)))) {
          for (const key of keys) untracked.add(key);
          continue;
        }
        // The reports are fresh again. Without a finished task's report, they cannot open a card: a later pass places them.
        if (!open && !reports.some((report) => this.host.task(report.taskId)?.state === "done")) {
          this.unassign(keys);
          for (const key of keys) untracked.add(key);
          continue;
        }
        const card = open ? live! : this.cardAfterClose({ ...link, cardId, reports, keys });
        const release = this.retain(card.id, reports);
        try {
          if (open) this.applyLink(card, { ...link, reports, keys });
          this.assign(keys, card.id);
          this.save();
          await this.copyThenTrack(card, reports, keys, card.id, untracked);
          this.save();
        } finally { release(); }
      }
      for (const track of plan.tracks) {
        if ("taskId" in track.tracking && untracked.has(followUpKey(track.taskId, track.findingId))) continue;
        this.writeTracking(track.taskId, track.findingId, "taskId" in track.tracking ? { taskId: this.destination(track.tracking.taskId) } : track.tracking);
      }
      this.host.current().followUpPending = (this.host.current().followUpPending ?? []).filter((group) => group.keys.some((key) => !this.linkedKey(key)));
      this.save();
    } catch {
      // The source task has already finished. A later catch-up or restart saves the link once.
    }
  }

  private stillOlder(key: string): boolean {
    const split = key.indexOf("::");
    if (split < 0) return false;
    const task = this.host.task(key.slice(0, split));
    const finding = task?.findings.find((entry) => entry.id === key.slice(split + 2));
    return !!finding && followUpBlock(finding) === undefined;
  }

  private picturesStillDue(taskId: Id): boolean {
    const task = this.host.task(taskId);
    if (!task) return false;
    for (const finding of task.findings) {
      if (finding.tracking && !("taskId" in finding.tracking) && finding.tracking.reason !== "pictures") continue;
      const targetId = finding.tracking && "taskId" in finding.tracking ? finding.tracking.taskId : this.assignments(task.id, finding.id)[0];
      const card = targetId ? this.host.task(targetId) : undefined;
      if (card?.state === "done" || card?.state === "cancelled") continue;
      const images = findingImages(task as Task, finding);
      if (!images.length) continue;
      const pending = (this.host.current().followUpPending ?? []).some((group) => group.keys.includes(followUpKey(taskId, finding.id)));
      if (!card && !pending && !(finding.tracking && "taskId" in finding.tracking)) continue;
      for (const image of images) {
        const kept = card?.session.some((line) => line.images?.some((saved) => saved.from?.taskId === image.sourceTaskId && saved.from.imageId === image.sourceImageId));
        if (!kept && this.host.picturePresent(image)) return true;
      }
    }
    return false;
  }

  private releaseReport(release: { taskId: Id; findingId: Id; cardId: Id }): void {
    const card = this.host.task(release.cardId);
    const task = this.host.task(release.taskId);
    const finding = task?.findings.find((entry) => entry.id === release.findingId);
    if (card?.followUp) {
      const before = card.followUp.reports;
      const dropped = before.find((report) => report.taskId === release.taskId && report.findingId === release.findingId);
      const reports = before.filter((report) => report.taskId !== release.taskId || report.findingId !== release.findingId);
      if (dropped && reports.length && reports.length !== before.length) {
        const still = new Set(reports.flatMap((report) => report.productIds));
        const only = dropped.productIds.filter((id) => !still.has(id));
        if (card.state === "backlog" && only.length && !card.followUp.preserveRequest) {
          card.selectedProducts = (card.selectedProducts ?? []).filter((choice) => !only.includes(choice.productId));
          if ((card.selectedProducts ?? []).length === 1) card.approvePlan = false;
        }
        const also = (card.followUp.alsoReported ?? []).filter((id) => !only.includes(id));
        const auto = followUpDescription(before.map(asCredit), this.productNames([...new Set(before.flatMap((report) => report.productIds))]));
        const rewrite = !card.followUp.preserveRequest && card.description === auto;
        card.followUp = { ...card.followUp, reports, alsoReported: also.length ? also : undefined };
        if (task && finding) this.dropPictures(card, task, finding);
        if (rewrite) {
          const names = this.productNames((card.selectedProducts ?? []).map((choice) => choice.productId));
          card.description = followUpDescription(reports.map(asCredit), names.length ? names : this.productNames([...new Set(reports.flatMap((report) => report.productIds))]));
        }
      } else if (reports.length !== before.length) {
        const also = card.followUp.alsoReported;
        card.followUp = { ...card.followUp, reports, alsoReported: also?.length ? [...also] : undefined };
      }
      if (!this.host.current().tasks.includes(card)) this.host.saveArchived(card);
    }
    if (!task || !finding?.tracking || ("taskId" in finding.tracking ? finding.tracking.taskId !== release.cardId : finding.tracking.reason !== "pictures")) return;
    delete finding.tracking;
    if (!this.host.current().tasks.includes(task)) this.host.saveArchived(task);
  }

  private productNames(ids: readonly Id[]): string[] {
    return ids.map((id) => this.host.current().products.find((entry) => entry.id === id)?.name ?? id);
  }

  private dropPictures(card: RuntimeTask, source: RuntimeTask, finding: RuntimeTask["findings"][number]): void {
    const wanted = new Set(findingImages(source as Task, finding).map((image) => `${image.sourceTaskId}/${image.sourceImageId}`));
    if (!wanted.size) return;
    const session: RuntimeTask["session"][number][] = [];
    for (const line of card.session) {
      if (!line.images?.length) {
        session.push(line);
        continue;
      }
      const images = line.images.filter((image) => {
        const key = image.from ? `${image.from.taskId}/${image.from.imageId}` : "";
        if (!wanted.has(key)) return true;
        try { this.host.dropCreditedPicture(card.id, image.id); } catch { /* The file is already gone. */ }
        return false;
      });
      if (!images.length && line.from === "system" && line.text === "Kept from the original report") continue;
      if (images.length) session.push({ ...line, images });
      else {
        const { images: _removed, ...rest } = line;
        session.push(rest);
      }
    }
    card.session = session;
  }

  private linkedKey(key: string): boolean {
    const split = key.indexOf("::");
    if (split < 0) return true;
    const task = this.host.task(key.slice(0, split));
    const finding = task?.findings.find((entry) => entry.id === key.slice(split + 2));
    return !!finding?.tracking && "taskId" in finding.tracking;
  }

  private save(): void {
    if (this.host.stopped()) throw new Error("Petrina stopped before the follow-up was saved");
    this.host.checkpoint();
  }

  private assignments(taskId: Id, findingId: Id): Id[] {
    const key = followUpKey(taskId, findingId);
    return [...new Set([
      ...(this.host.current().followUpPending ?? []).flatMap(group => group.cardId && group.keys.includes(key) ? [group.cardId] : []),
      ...this.host.current().tasks.flatMap(task => task.followUp?.reports.some(report => report.taskId === taskId && report.findingId === findingId) ? [task.id] : []),
    ].map(id => this.destination(id)))];
  }

  private destination(cardId: Id): Id {
    const seen = new Set<Id>();
    let id = cardId;
    while (!seen.has(id)) {
      seen.add(id);
      const next = this.host.task(id)?.combinedInto;
      if (!next) return id;
      id = next;
    }
    return cardId;
  }

  private pending() {
    return (this.host.current().followUpPending ?? []).map(group => group.cardId ? { ...group, cardId: this.destination(group.cardId) } : group);
  }

  private retain(cardId: Id, reports: readonly FollowUpCredit[]): () => void {
    const releases = [...new Set([cardId, ...reports.map((report) => report.taskId)])].map((id) => this.host.hold(id));
    return () => { for (const release of releases) release(); };
  }

  private assign(keys: readonly string[], cardId: Id): void {
    this.unassign(keys);
    this.host.current().followUpPending = [...(this.host.current().followUpPending ?? []), { keys: [...keys], cardId }];
  }

  private unassign(keys: readonly string[]): void {
    this.host.current().followUpPending = (this.host.current().followUpPending ?? []).map(group => ({ ...group, keys: group.keys.filter(key => !keys.includes(key)) })).filter(group => group.keys.length);
  }

  private tasks(): Task[] {
    const tasks = new Map<Id, Task>();
    for (const task of this.host.current().tasks) tasks.set(task.id, task as Task);
    for (const group of this.host.current().followUpPending ?? []) for (const key of group.keys) {
      const id = key.slice(0, key.indexOf("::"));
      if (!id || tasks.has(id)) continue;
      const task = this.host.task(id);
      if (task) tasks.set(id, task as Task);
    }
    return [...tasks.values()];
  }

  private cardFor(create: FollowUpCreate): RuntimeTask {
    const existing = this.host.current().tasks.find((task) => task.followUp?.reports.some((report) => create.keys.includes(followUpKey(report.taskId, report.findingId))));
    return existing ?? this.createCard(create);
  }

  private createCard(create: FollowUpCreate): RuntimeTask {
    let id = this.host.id("task");
    while (this.host.taskIdTaken(id)) id = this.host.id("task");
    const choices = create.productIds.map((productId) => {
      const product = this.host.current().products.find((entry) => entry.id === productId);
      return { productId, startFrom: { kind: "default" as const }, delivery: product?.delivery ?? "pull-request" as const };
    });
    const product = this.host.current().products.find((entry) => entry.id === choices[0]?.productId);
    const names = create.productIds.map((productId) => this.host.current().products.find((entry) => entry.id === productId)?.name ?? productId);
    const now = this.host.now();
    const task: RuntimeTask = createTaskState({ productId: choices[0]?.productId ?? "", title: create.title, description: followUpDescription(create.reports, names), kind: "bug", worksOn: choices, backlog: true }, this.host.current().products,
      { id, timelineId: this.host.id(id), now, priority: this.host.current().tasks.length });
    // Discovery selects the affected products; the coordinator still reviews this inferred request.
    task.explicitStart = false;
    task.repository = {
      productId: task.productId, delivery: task.delivery, workChoice: structuredClone(task.workChoice),
      ...(product ? { workProduct: { id: product.id, name: product.name, repo: product.repo, path: product.path, remote: product.remote, defaultBranch: product.defaultBranch ?? "main" } } : {}),
    };
    task.timeline = [{ id: task.timeline[0]!.id, at: now, text: "Kept as future work", tone: "status" }];
    task.followUp = { reports: create.reports.map(stored) };
    this.host.current().tasks.push(task);
    return task;
  }

  private cardAfterClose(link: FollowUpLink): RuntimeTask {
    const existing = this.host.current().tasks.find((task) => task.followUp && task.state !== "done" && task.state !== "cancelled" && task.followUp.reports.some((report) => link.keys.includes(followUpKey(report.taskId, report.findingId))));
    if (existing) return existing;
    return this.createCard({
      title: followUpTitle(link.reports[0]?.text ?? "Older bug"),
      description: "",
      productIds: [...new Set(link.reports.flatMap((report) => report.productIds))],
      reports: link.reports,
      keys: [...link.keys],
    });
  }

  private applyLink(card: RuntimeTask, link: FollowUpLink): void {
    if (!takesFollowUps(card as Task, link.reports)) return;
    card.followUp ??= { reports: [], preserveRequest: true };
    const reports = [...card.followUp.reports];
    for (const report of link.reports) {
      if (!reports.some((entry) => entry.taskId === report.taskId && entry.findingId === report.findingId)) reports.push(stored(report));
    }
    // Read the card as it is now. Queueing or cancelling during the match must not use the earlier phase.
    const covered = new Set<string>([
      ...(card.selectedProducts ?? []).map((choice) => choice.productId),
      ...(card.followUp.alsoReported ?? []),
      ...card.followUp.reports.flatMap((report) => report.productIds),
    ]);
    const extra = [...new Set(link.reports.flatMap((report) => report.productIds))].filter((id) => id.length > 0 && !covered.has(id));
    if (card.state !== "backlog" || card.followUp.preserveRequest) {
      const also = [...(card.followUp.alsoReported ?? [])];
      for (const id of extra) if (!also.includes(id)) also.push(id);
      card.followUp = { ...card.followUp, reports, alsoReported: also.length ? also : undefined };
      return;
    }
    const selected = [...(card.selectedProducts ?? [])];
    for (const id of extra) {
      if (selected.some((choice) => choice.productId === id)) continue;
      const product = this.host.current().products.find((entry) => entry.id === id);
      selected.push({ productId: id, startFrom: { kind: "default" }, delivery: product?.delivery ?? card.delivery });
      if (product?.approveDelivery !== false) card.approveDelivery = true;
    }
    card.selectedProducts = selected;
    if (selected.length !== 1) card.approvePlan = true;
    const also = card.followUp.alsoReported;
    card.followUp = { ...card.followUp, reports, alsoReported: also?.length ? [...also] : undefined };
  }

  private async copyThenTrack(card: RuntimeTask, reports: readonly FollowUpCredit[], keys: readonly string[], cardId: Id, untracked: Set<string>): Promise<void> {
    const copied = await this.keepImages(card, reports);
    const blocked = new Set<string>();
    if (!copied) for (const report of reports) if (report.images.length) {
      const key = followUpKey(report.taskId, report.findingId);
      blocked.add(key);
      untracked.add(key);
      this.writeTracking(report.taskId, report.findingId, { reason: "pictures", retry: true });
    }
    this.trackKeys(keys.filter((key) => !blocked.has(key)), cardId);
  }

  private async keepImages(card: RuntimeTask, reports: readonly FollowUpCredit[]): Promise<boolean> {
    const kept = new Set(card.session.flatMap(line => (line.images ?? []).flatMap(image => image.from ? [JSON.stringify([image.from.taskId, image.from.imageId])] : [])));
    const pending = reports.flatMap(report => report.images).filter(image => {
      const key = JSON.stringify([image.sourceTaskId, image.sourceImageId]);
      if (kept.has(key)) return false;
      kept.add(key);
      return true;
    });
    const saved = await completeAll(pending.map(image => this.host.keepPicture(card.id, image)));
    const failed = saved.some(image => image === "failed");
    const images = saved.filter((image): image is ReportImage => !!image && image !== "failed");
    if (images.length) card.session = [...card.session, { id: this.host.id(card.id), at: this.host.now(), from: "system", text: "Kept from the original report", images }];
    return !failed;
  }

  private trackKeys(keys: readonly string[], cardId: Id): void {
    for (const key of keys) {
      const split = key.indexOf("::");
      if (split < 0) continue;
      this.writeTracking(key.slice(0, split), key.slice(split + 2), { taskId: cardId });
    }
  }

  private writeTracking(taskId: Id, findingId: Id, tracking: NonNullable<Task["findings"][number]["tracking"]>): void {
    const task = this.host.task(taskId);
    const finding = task?.findings.find((entry) => entry.id === findingId);
    if (!task || !finding || (finding.tracking && "taskId" in finding.tracking)) return;
    // The match decided this before a later judgment said the change caused it. Do not claim the link.
    if ("taskId" in tracking && followUpBlock(finding) !== undefined) return;
    finding.tracking = tracking;
    if (!this.host.current().tasks.includes(task)) this.host.saveArchived(task);
  }
}

function asCredit(report: NonNullable<Task["followUp"]>["reports"][number]): FollowUpCredit {
  return { ...report, images: [] };
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key) => right.includes(key));
}

function mergePending(current: readonly { keys: readonly string[]; cardId?: string; retry?: boolean }[], next: readonly { keys: readonly string[]; cardId?: string; retry?: boolean }[]): { keys: string[]; cardId?: string; retry?: boolean }[] {
  const seen = new Set<string>();
  const merged: { keys: string[]; cardId?: string; retry?: boolean }[] = [];
  for (const group of [...current, ...next]) {
    const id = `${group.retry ? "retry" : ""}:${group.cardId ?? ""}:${[...group.keys].sort().join("|")}`;
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push({ keys: [...group.keys], ...(group.cardId ? { cardId: group.cardId } : {}), ...(group.retry ? { retry: true } : {}) });
  }
  return merged;
}

function samePending(current: readonly { keys: readonly string[]; cardId?: string; retry?: boolean }[] | undefined, next: readonly { keys: readonly string[]; cardId?: string; retry?: boolean }[]): boolean {
  const left = current ?? [];
  return left.length === next.length && left.every((entry, index) => {
    const other = next[index];
    return !!other && entry.cardId === other.cardId && !!entry.retry === !!other.retry && sameKeys(entry.keys, other.keys);
  });
}
