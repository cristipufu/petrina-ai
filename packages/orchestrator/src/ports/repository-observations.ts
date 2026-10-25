import type { Id } from "@petrina/core";
import type { RepositoryContext } from "../repository-context.js";

/** These identities describe one committed version, never uncommitted workspace contents. */
export interface CommittedVersion {
  readonly head: string;
  readonly tree: string;
}

/** A bound workspace: later metadata changes cannot redirect an observation already in progress. */
export interface RepositoryVersionReader {
  /** Undefined means no usable observation, never proof that code is absent or unchanged. */
  committed(): Promise<CommittedVersion | undefined>;
  change(base: string, head: string): Promise<string | undefined>;
}

export interface RepositoryObservationQueries {
  /** No prepared workspace yields no reader. Reads are finite; cancellation is not claimed here. */
  bind(scope: RepositoryContext): RepositoryVersionReader | undefined;
}

export interface CommittedCode {
  versions: Record<Id, string>;
  changes: Record<Id, string>;
}
