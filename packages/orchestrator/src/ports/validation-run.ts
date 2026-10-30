import type { CheckRun, DeepMutable, ExtraValidation } from "@petrina/core";

export type ValidationRecord = DeepMutable<ExtraValidation>;
export type ValidationResult = NonNullable<ExtraValidation["result"]>;
export type ValidationLog = Pick<CheckRun, "logPath" | "logFileIdentity" | "logFileLength" | "logFileBeginning">;

export interface ValidationRunHost {
  now(): number;
  admissionClosed(taskId: string): boolean;
  persist(): void;
  change<T>(record: ValidationRecord, apply: () => T): T;
  note(record: ValidationRecord, kind: "started" | "stopping", words: string): void;
  finish(record: ValidationRecord, result: ValidationResult, detail: string): void;
  requeue(record: ValidationRecord): void;
  hold(record: ValidationRecord, detail: string): void;
}

/** The command adapter owns its process and diagnostic through settlement, including callback failure. */
export interface ValidationRunCallbacks {
  admitted(): boolean;
  spawned(pid: number): void;
  log(facts: ValidationLog): void;
}

export interface ValidationRunEffects {
  prepare(record: ValidationRecord): Promise<NonNullable<ExtraValidation["container"]>>;
  snapshot(record: ValidationRecord): Promise<void>;
  run(record: ValidationRecord, signal: AbortSignal, callbacks: ValidationRunCallbacks): Promise<CheckRun | undefined>;
  cleanup(record: ValidationRecord): Promise<boolean>;
}
