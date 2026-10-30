import { checkOutcome, commandText } from "@petrina/core";
import type { ValidationRecord, ValidationResult, ValidationRunEffects, ValidationRunHost } from "./ports/validation-run.js";

/** Admission and outcome decisions for one owned extra validation; adapters supply observed execution facts. */
export class ValidationRun {
  constructor(private readonly host: ValidationRunHost, private readonly effects: ValidationRunEffects) {}

  execute(record: ValidationRecord, signal: AbortSignal): Promise<void> {
    return this.attempt(record, signal).catch(error => this.host.hold(record, String(error)));
  }

  private async attempt(record: ValidationRecord, signal: AbortSignal): Promise<void> {
    let result: ValidationResult = "not run";
    let detail = "The extra validation did not start.";
    const admitted = () => {
      signal.throwIfAborted();
      if (this.host.admissionClosed(record.taskId)) {
        record.resumeQueued = true;
        return false;
      }
      return true;
    };
    try {
      // Admission saves are preparation too: failure before launch must retain a truthful not-run outcome.
      record.state = "preparing";
      this.host.persist();
      record.container = await this.effects.prepare(record);
      if (admitted()) {
        await this.effects.snapshot(record);
        if (admitted()) {
          const run = await this.effects.run(record, signal, {
            admitted,
            spawned: pid => {
              // The process already exists. Retain its observed identity if saving fails; the adapter stops it.
              record.clientPid = pid;
              this.host.persist();
            },
            log: facts => this.host.change(record, () => {
              // Ownership and the initial diagnostic are one pre-launch transaction.
              record.state = "running";
              record.startedAt = this.host.now();
              record.waitingMs = record.startedAt - record.queuedAt;
              record.run = { name: record.name, command: commandText(record.argv), ok: false, ms: 0,
                startedAt: record.startedAt, output: "The extra validation is in progress; its command outcome is not recorded yet.", logComplete: false, ...facts };
              this.host.note(record, "started", `Extra validation “${record.name}” is running.`);
              this.host.persist();
            }),
          });
          if (run) record.run = { ...run, command: commandText(record.argv) };
          const outcome = checkOutcome(run);
          result = signal.aborted ? "stopped" : outcome.kind === "passed" ? "passed" : outcome.kind === "failed" ? "failed" : outcome.kind === "unavailable" ? "not run" : "did not finish";
          detail = signal.aborted ? "The task or Petrina stopped this extra validation." : result === "passed" ? "The extra validation passed; delivery still requires the configured product checks." : run?.output ?? "The command did not start.";
        }
      }
    } catch (error) { detail = error instanceof Error ? error.message : String(error); }
    if (record.startedAt === undefined && signal.aborted) {
      // The first abort cause wins; only shutdown preserves never-started work.
      if (signal.reason === "shutdown") record.resumeQueued = true;
      else {
        result = "stopped";
        detail = "The task stopped before the container started.";
      }
    }
    if (record.startedAt === undefined && !signal.aborted && this.host.admissionClosed(record.taskId)) record.resumeQueued = true;
    if (!record.resumeQueued) {
      record.result = result;
      record.detail = detail;
      record.endedAt = record.run?.endedAt ?? this.host.now();
      record.durationMs = record.run?.ms ?? (record.startedAt === undefined ? 0 : record.endedAt - record.startedAt);
    }
    if (record.run?.startedAt) {
      record.startedAt = record.run.startedAt;
      record.waitingMs = record.startedAt - record.queuedAt;
    }
    if (record.startedAt === undefined) {
      // No workload could exist, but the snapshot effect may have left a partial copy.
      this.host.persist();
      if (await this.effects.cleanup(record)) { if (record.resumeQueued) this.host.requeue(record);
      else this.host.finish(record, result, detail); }
      else this.host.hold(record, "Petrina could not confirm the prepared copy's cleanup.");
      return;
    }
    record.stoppingAt = this.host.now();
    record.state = "stopping";
    this.host.note(record, "stopping", `Stopping extra validation “${record.name}” and confirming cleanup.`);
    this.host.persist();
    if (await this.effects.cleanup(record)) this.host.finish(record, result, detail);
    else this.host.hold(
      record,
      "Cleanup is unconfirmed. Make the local container service available, or stop the named container; Petrina will confirm cleanup."
    );
  }
}
