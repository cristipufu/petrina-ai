export const MAX_NATIVE_LAUNCHES = 3_700;

export interface ResourceQualityEvidence {
  observerErrors?: number;
  outputTruncated?: unknown[];
  samplingErrors?: unknown[];
  collectorExitCode?: number;
  fullExitCode?: number;
  afterExitProcesses?: unknown[];
}

export interface ResourceReconciliation {
  nativeLaunches: number;
  attributed: number;
  unattributed: number;
  missingFiles: string[];
  quality: ResourceQualityEvidence;
  unknownCaptureEvidence: string[];
  invalidLines: number;
  unfinishedCases: number;
  truncated: boolean;
  launchesWithoutObservedExit: number;
}

export interface ResourceVerificationOptions {
  checkLaunchCeiling?: boolean;
  maxNativeLaunches?: number;
}

export function verifyResourceReconciliation(
  reconciliation: ResourceReconciliation,
  options: ResourceVerificationOptions = {},
): string[] {
  const violations: string[] = [];
  if (reconciliation.missingFiles.length) {
    violations.push(
      `Missing completed test files (${reconciliation.missingFiles.length}): ${reconciliation.missingFiles.join(", ")}`,
    );
  }
  if (reconciliation.invalidLines) {
    violations.push(`Invalid resource event lines: ${reconciliation.invalidLines}`);
  }
  if (reconciliation.unfinishedCases) {
    violations.push(`Unfinished test cases: ${reconciliation.unfinishedCases}`);
  }
  if (reconciliation.truncated) {
    violations.push("Resource event capture was truncated");
  }
  if (reconciliation.launchesWithoutObservedExit) {
    violations.push(`Subprocess launches without observed exit: ${reconciliation.launchesWithoutObservedExit}`);
  }
  if (reconciliation.unattributed) {
    violations.push(`Unattributed subprocess launches: ${reconciliation.unattributed}`);
  }
  if (reconciliation.unknownCaptureEvidence.length) {
    violations.push(`Missing capture evidence fields: ${reconciliation.unknownCaptureEvidence.join(", ")}`);
  }
  if (reconciliation.quality.observerErrors) {
    violations.push(`Observer errors recorded: ${reconciliation.quality.observerErrors}`);
  }
  if (reconciliation.quality.outputTruncated?.length) {
    violations.push(`Truncated output streams: ${reconciliation.quality.outputTruncated.length}`);
  }
  if (reconciliation.quality.samplingErrors?.length) {
    violations.push(`Process sampling errors: ${reconciliation.quality.samplingErrors.length}`);
  }
  if (reconciliation.quality.collectorExitCode !== 0) {
    violations.push(`Resource collector exited with code ${String(reconciliation.quality.collectorExitCode)}`);
  }
  if (reconciliation.quality.fullExitCode !== 0) {
    violations.push(`Full test suite exited with code ${String(reconciliation.quality.fullExitCode)}`);
  }
  if (reconciliation.quality.afterExitProcesses?.length) {
    violations.push(`Processes still present after suite exit: ${reconciliation.quality.afterExitProcesses.length}`);
  }
  if (options.checkLaunchCeiling) {
    const ceiling = options.maxNativeLaunches ?? MAX_NATIVE_LAUNCHES;
    if (reconciliation.nativeLaunches > ceiling) {
      violations.push(`Native subprocess launches (${reconciliation.nativeLaunches}) exceeded ceiling (${ceiling})`);
    }
  }
  return violations;
}
