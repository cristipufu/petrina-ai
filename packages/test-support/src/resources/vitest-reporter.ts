import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface DiagnosticCase { module: { moduleId: string }; fullName: string; result(): { state?: string }; diagnostic(): { duration?: number; heap?: number; startTime?: number } | undefined }
interface DiagnosticModule { moduleId: string; diagnostic(): { duration?: number; heap?: number; collectDuration?: number; environmentSetupDuration?: number; setupDuration?: number; prepareDuration?: number } }
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
export default class ResourceReporter {
  private readonly output = process.env.PETRINA_TEST_RESOURCE_DIR;
  private readonly instance = crypto.randomUUID();
  private sequence = 0;
  private failed = false;
  private record(value: unknown): void {
    if (!this.output || this.failed) return;
    try {
      mkdirSync(this.output, { recursive: true });
      const file = join(this.output, "vitest-cases.jsonl"), encoded = JSON.stringify(value) + "\n";
      let bytes = 0;
      try { bytes = statSync(file).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (Buffer.byteLength(encoded) > 64 * 1024 || bytes + Buffer.byteLength(encoded) > 32 * 1024 * 1024) {
        appendFileSync(file, JSON.stringify({ kind: "truncated", observer: "vitest" }) + "\n"); this.failed = true; return;
      }
      appendFileSync(file, encoded);
    } catch { this.failed = true; process.stderr.write("[petrina-resource-observer-error] Could not write Vitest observations.\n"); }
  }
  onTestCaseResult(test: DiagnosticCase): void {
    const diagnostic = test.diagnostic(), state = test.result().state;
    this.record({ kind: "vitest-case", id: `vitest-${process.pid}-${this.instance}-${++this.sequence}`, file: test.module.moduleId, name: test.fullName,
      outcome: state && ["passed", "failed", "skipped", "pending"].includes(state) ? state : "unknown", wallMs: number(diagnostic?.duration), reportedHeapBytes: number(diagnostic?.heap), startedAt: number(diagnostic?.startTime) });
  }
  onTestModuleEnd(module: DiagnosticModule): void {
    const diagnostic = module.diagnostic();
    this.record({ kind: "vitest-file", file: module.moduleId, durationMs: number(diagnostic.duration), reportedHeapBytes: number(diagnostic.heap),
      collectMs: number(diagnostic.collectDuration), environmentSetupMs: number(diagnostic.environmentSetupDuration), setupMs: number(diagnostic.setupDuration), prepareMs: number(diagnostic.prepareDuration) });
  }
}
