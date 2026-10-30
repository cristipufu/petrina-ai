// Compose the native helper and timer once; owners retain process-cleanup policy.
import { execFile } from "node:child_process";
import { processHostFor, type ProcessHost, type ProcessHelper, type ProcessDeadline } from "./process-capabilities.js";
export type { ProcessHost, ProcessHelper, ProcessDeadline } from "./process-capabilities.js";

const execute: ProcessHelper = (command, args, options, done) => execFile(command, [...args], options, error => done(error));
const deadline: ProcessDeadline = (expired, ms) => {
  const timer = setTimeout(expired, ms);
  return () => clearTimeout(timer);
};

export function createProcessHost(platform: NodeJS.Platform = process.platform, helper: ProcessHelper = execute, arm: ProcessDeadline = deadline): ProcessHost {
  return processHostFor(platform, helper, arm);
}

export const processHost = createProcessHost();
