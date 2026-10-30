import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BuilderContext, Finding, Role, Task } from "@petrina/core";
import type { Section } from "./context-input.js";
import { saveImmutable } from "./immutable-file.js";
import { builderContextInput, type ContextPacketStorage } from "./builder-context-input.js";
export type { ContextPacketStorage } from "./builder-context-input.js";

const nativePackets: ContextPacketStorage = {
  root: (dataDir, taskId) => join(dataDir, "contexts", taskId), contains: (root, file) => dirname(file) === root,
  read: file => readFile(file, "utf8"), save: (root, packet) => saveImmutable(root, "md", packet, "The saved context packet changed."),
};

/** Native immutable-packet binding; policy and continuation reduction have no filesystem dependency. */
export function builderContext(dataDir: string, task: Task, role: Role, sessionId: string, sections: readonly Section[], previous?: BuilderContext, options: {
  design?: boolean;
  knownSections?: readonly string[];
  findings?: readonly Finding[]
} = {}, storage: ContextPacketStorage = nativePackets): ReturnType<typeof builderContextInput> {
  return builderContextInput(dataDir, task, role, sessionId, sections, previous, options, storage);
}
