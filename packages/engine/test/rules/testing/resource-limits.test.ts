import { describe, expect, it } from "bun:test";
import {
  MAX_NATIVE_LAUNCHES,
  verifyResourceReconciliation,
  type ResourceReconciliation,
} from "../../quality/resource-limits.js";

const cleanReconciliation = (): ResourceReconciliation => ({
  nativeLaunches: 3_554,
  attributed: 3_554,
  unattributed: 0,
  missingFiles: [],
  quality: {
    observerErrors: 0,
    outputTruncated: [],
    samplingErrors: [],
    collectorExitCode: 0,
    fullExitCode: 0,
    afterExitProcesses: [],
  },
  unknownCaptureEvidence: [],
  invalidLines: 0,
  unfinishedCases: 0,
  truncated: false,
  launchesWithoutObservedExit: 0,
});

describe("resource reconciliation verification", () => {
  it("accepts a complete, leak-free, fully attributed capture under the native launch ceiling", () => {
    expect(verifyResourceReconciliation(cleanReconciliation(), { checkLaunchCeiling: true })).toEqual([]);
  });

  it("rejects unattributed launches, missing child exits and escaped post-exit processes", () => {
    const broken = cleanReconciliation();
    broken.unattributed = 2;
    broken.launchesWithoutObservedExit = 1;
    broken.quality.afterExitProcesses = [{ pid: 9999 }];
    expect(verifyResourceReconciliation(broken)).toEqual([
      "Subprocess launches without observed exit: 1",
      "Unattributed subprocess launches: 2",
      "Processes still present after suite exit: 1",
    ]);
  });

  it("rejects incomplete captures, observer or sampler errors and non-zero suite exit codes", () => {
    const broken = cleanReconciliation();
    broken.missingFiles = ["packages/engine/test/a.test.ts"];
    broken.invalidLines = 3;
    broken.unfinishedCases = 1;
    broken.truncated = true;
    broken.unknownCaptureEvidence = ["observerErrors"];
    broken.quality.observerErrors = 1;
    broken.quality.outputTruncated = ["stdout"];
    broken.quality.samplingErrors = ["ps failed"];
    broken.quality.collectorExitCode = 1;
    broken.quality.fullExitCode = 1;
    expect(verifyResourceReconciliation(broken)).toHaveLength(10);
  });

  it("enforces the native subprocess launch ceiling when checkLaunchCeiling is enabled", () => {
    const overCeiling = cleanReconciliation();
    overCeiling.nativeLaunches = MAX_NATIVE_LAUNCHES + 1;
    overCeiling.attributed = MAX_NATIVE_LAUNCHES + 1;
    expect(verifyResourceReconciliation(overCeiling)).toEqual([]);
    expect(verifyResourceReconciliation(overCeiling, { checkLaunchCeiling: true })).toEqual([
      `Native subprocess launches (${MAX_NATIVE_LAUNCHES + 1}) exceeded ceiling (${MAX_NATIVE_LAUNCHES})`,
    ]);
    expect(
      verifyResourceReconciliation(overCeiling, { checkLaunchCeiling: true, maxNativeLaunches: 4_000 }),
    ).toEqual([]);
  });
});
