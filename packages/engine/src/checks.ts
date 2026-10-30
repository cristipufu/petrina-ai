// Compatibility facade: policy is portable; repository automation owns native checks and discovery.
export { commandText, commandInputText, parseCommand, tidyOutput, staticCheck, orderedChecks, expectedCheckCommands, sameCommands, CHECK_EXIT_UNREPORTED } from "@petrina/core";
export { CHECK_TIMEOUT_MS, runChecks, checkLogBeginning, type CheckProgress, type CheckCommandExecutor, type CheckCommandRequest, type CheckCommandOutcome } from "@petrina/repositories/check-runner";
export { CHECKS_SEEN, detectChecks, checksFor, checksFingerprint } from "@petrina/repositories/check-discovery";
