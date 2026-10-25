import type { DeepMutable, FollowUpCredit, FollowUpImage, Id, MatchAnswer, MatchAsk, Product, ReportImage, State } from "@petrina/core";
import type { RuntimeTask } from "../model.js";

export interface FollowUpLinkState {
  tasks: RuntimeTask[];
  readonly products: readonly Product[];
  followUpPending?: DeepMutable<NonNullable<State["followUpPending"]>>;
}

/** The actual link application consumes records and named effects; native resources stay with the host. */
export interface FollowUpLinkHost {
  current(): FollowUpLinkState;
  task(id: Id): RuntimeTask | undefined;
  stopped(): boolean;
  hold(taskId: Id): () => void;
  track<T>(work: Promise<T>): Promise<T>;
  id(prefix: Id): Id;
  taskIdTaken(id: Id): boolean;
  now(): number;
  checkpoint(): void;
  changed(task: RuntimeTask): void;
  saveArchived(task: RuntimeTask): void;
  atomic<T>(work: () => T): T;
  match(ask: MatchAsk): Promise<MatchAnswer>;
  picturePresent(image: Pick<FollowUpImage, "sourceTaskId" | "sourceImageId">): boolean;
  keepPicture(target: Id, image: FollowUpCredit["images"][number]): Promise<ReportImage | "failed" | undefined>;
  dropCreditedPicture(target: Id, imageId: Id): void;
  discardPreparedPicture(target: Id, imageId: Id): Promise<void>;
}
