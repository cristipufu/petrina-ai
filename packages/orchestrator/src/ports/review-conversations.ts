import type { AgentProfile, BuilderContext, Id } from "@petrina/core";
import type { RepositoryContext } from "../repository-context.js";

/** Only the completed packet and Git observations cross this boundary. */
export interface ReviewConversationEffects {
  contextIntact(context: BuilderContext | undefined): Promise<boolean>;
  baseUpdates(scope: RepositoryContext, bases: Readonly<Record<Id, string>>, heads: Readonly<Record<Id, string>>): Promise<ReviewBaseUpdate>;
}

export interface ReviewConversationHost {
  profiles(): readonly AgentProfile[];
  profile(id: Id): AgentProfile | undefined;
  digest(serialized: string): string;
  checkpoint(): void;
  unavailable(reason: string): Error;
}

export interface ReviewBaseUpdate {
  sections: { title: string; body: string }[];
  reason?: string;
}

export interface ReviewBaseEffects {
  contains(scope: RepositoryContext, base: string, before: string): Promise<boolean>;
  changedFiles(scope: RepositoryContext, from: string, to: string): Promise<readonly string[]>;
  count(scope: RepositoryContext, before: string, base: string): Promise<string>;
}
