import type { DeepMutable, Id, InboxItem, Product } from "@petrina/core";
import type { RuntimeTask } from "../model.js";
import type { RepositoryContext } from "../repository-context.js";

/** Validated Guide output; parsing and participant ownership belong to the adapter. */
export interface GuideProposalResult { missed: boolean; line: string; why: string }

export interface GuideProposalsHost {
  current(): { inbox: DeepMutable<InboxItem>[]; products: DeepMutable<Product>[] };
  task(id: Id): RuntimeTask | undefined;
  productOf(target: RuntimeTask | RepositoryContext): DeepMutable<Product> | undefined;
  takeItem(id: Id): DeepMutable<InboxItem> | undefined;
  profile(): Id;
  now(): number;
  checkpointNow(): void;
  checkpoint(task?: RuntimeTask): void;
  releaseScreen(task: RuntimeTask): void;
  offer(scope: RepositoryContext, title: string, details: { body: string; detail: string }): void;
  log(target: RuntimeTask | RepositoryContext, kind: "done" | "you" | "warn", text: string, roleId?: Id, profileId?: Id): void;
  failed(scope: RepositoryContext, error: unknown, profileId: Id): void;
}

/** Native guide reads, actual participant replies and interruption identities remain effects. */
export interface GuideProposalsEffects {
  guide(scope: RepositoryContext): Promise<string>;
  turn(scope: RepositoryContext, input: { note: string; guide: string }, profileId: Id, signal: AbortSignal, used: (id: Id) => void): Promise<GuideProposalResult>;
  interrupted(error: unknown): boolean;
  deferred(error: unknown): boolean;
}
