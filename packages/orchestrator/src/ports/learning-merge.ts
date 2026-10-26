import type { GuideLine, Id, LearningReceipt } from "@petrina/core";

export interface PlainInstructions { readonly mode: string; readonly text: string }
export interface LearningRecords {
  readonly learnings?: readonly GuideLine[];
  readonly learningReceipts?: readonly LearningReceipt[];
}
/** Captures one product identity, but observes its live queue only after native history has answered. */
export interface LearningMergeRecords { current(): LearningRecords }
export interface LearningMergeRequest {
  readonly taskId: Id;
  readonly fork: string;
  readonly onto: string;
  readonly ref: string;
  readonly merged: { readonly tree: string; readonly conflicts: readonly string[] };
}
/** Bound native queries preserve plain-file and raw object-history semantics; no working folder crosses the port. */
export interface LearningMergeEffects {
  instructionsAt(ref: string): Promise<PlainInstructions | undefined>;
  objectMergeBase(ref: string, onto: string): Promise<string | undefined>;
  instructionVersionsBetween(fork: string, onto: string): Promise<readonly string[]>;
  objectHistoryContains(onto: string, foundOn: string): Promise<boolean>;
  instructionsInTree(tree: string, mode: string, text: string): Promise<string>;
}
export interface LearningMergeResult { tree: string; added: string[]; present: string[] }
