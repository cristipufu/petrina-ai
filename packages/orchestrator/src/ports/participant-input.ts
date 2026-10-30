import type { BuilderContext, ConversationNote, Id, InputManifestEntry, JourneyAgentInput, ReadinessRecheck } from "@petrina/core";
import type { RepositoryContext } from "../repository-context.js";
import type { SessionSettings } from "./agents.js";

export interface InputSection { title: string; body: string }
export interface InputOmission { title: string; digest: string; noteId?: string }
export interface PendingParticipantInput { stepId: Id; input: JourneyAgentInput }
export interface ParticipantInputDetails {
  omitted?: readonly InputOmission[];
  freshReason?: string;
  sessionId?: string;
  resumed?: boolean;
  supplied?: readonly InputSection[];
  place?: string;
  readiness?: ReadinessRecheck;
}
export interface ParticipantInputCaptureRequest {
  scope: RepositoryContext;
  roleId: Id;
  profileId: Id;
  sections: readonly InputSection[];
  mode: "fresh" | "continued";
  plannedId: Id;
  selectionReason?: string;
  reviewerKey?: string;
  confirmedSettings: SessionSettings;
  instructions: string;
  extra?: ParticipantInputDetails;
}
export interface ParticipantInputHost {
  now(): number;
  current(scope: RepositoryContext): boolean;
  stopped(): boolean;
  status(scope: RepositoryContext, reason: string, roleId: Id, profileId: Id): void;
  checkpoint(scope: RepositoryContext): void;
  commit(scope: RepositoryContext): void;
  noteStream(scope: RepositoryContext): void;
  say(scope: RepositoryContext, text: string, roleId: Id, profileId: Id, reviewerKey?: string): void;
  briefed(scope: RepositoryContext): void;
}
export interface ParticipantInputEffects {
  clone<T>(value: T): T;
  manifest(instructions: string, sections: readonly InputSection[], omitted?: readonly InputOmission[], complete?: boolean): InputManifestEntry[];
  numberManifest(entries: readonly InputManifestEntry[]): InputManifestEntry[];
  saveExact(taskId: Id, text: string): Promise<JourneyAgentInput["exact"]>;
}
export interface PreparedContext<S extends InputSection> { sections: S[]; snapshot?: BuilderContext; omitted?: readonly InputOmission[] }
export interface ParticipantContextPreparation<S extends InputSection> {
  packet: boolean;
  note: ConversationNote | undefined;
  previous: BuilderContext | undefined;
  prepare(): Promise<PreparedContext<S>>;
  sections: S[];
  supplyHistory: boolean;
  history(sections: S[], continued: boolean): Promise<{ sections: S[]; retained?: boolean }>;
}
