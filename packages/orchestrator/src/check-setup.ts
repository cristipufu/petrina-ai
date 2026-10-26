import { checkOutcome, checkSetupOutcome, isCheckExecutorFacts, isCheckOutputIdentity, sameCheckExecutorFacts, type CheckSetupAttempt } from "@petrina/core";
import type { CheckSetupHost, CheckSetupRequest } from "./ports/check-setup.js";

const detail = (error: unknown) => {
  try { return String(error instanceof Error ? error.message : error).slice(-1000); }
  catch { return "The setup failure had no readable detail"; }
};

/** Sequence only the declared prerequisites. This owns no queue, child process, retry or environment cache. */
export class CheckSetup {
  constructor(private readonly host: CheckSetupHost) {}

  async observe(request: CheckSetupRequest, signal: AbortSignal): Promise<CheckSetupAttempt> {
    let attempt: CheckSetupAttempt = { ...request, input: { ...request.input }, requirements: request.requirements.map(requirement => ({ ...requirement, argv: [...requirement.argv] })),
      lifecycle: "running", startedAt: this.host.now(), results: [] };
    const errors: unknown[] = [];
    let activity: "none" | "commands" = "none";
    const publish = () => this.host.changed(structuredClone(attempt));
    try {
      publish();
      if (signal.aborted) attempt.lifecycle = "stopped";
      else {
        const observed = this.host.executor();
        if (observed.kind === "unavailable") attempt.observationFailure = { kind: "executor", message: observed.message };
        else if (!isCheckExecutorFacts(observed.facts)) attempt.observationFailure = { kind: "executor", message: "The setup executor was not observed completely" };
        else {
          attempt.executor = structuredClone(observed.facts);
          publish();
          for (const requirement of attempt.requirements) {
            if (signal.aborted) { attempt.lifecycle = "stopped"; break; }
            attempt.runningRequirementId = requirement.id;
            publish();
            const priorActivity = activity;
            // A rejected boundary may already have started work; restoration must not assume otherwise.
            activity = "commands";
            const result = await this.host.execute(requirement, signal);
            if (result.kind === "not-started") {
              activity = priorActivity;
              attempt.lifecycle = "stopped";
              attempt.observationFailure = { kind: "execution", message: `The setup requirement did not start: ${result.reason}` };
              break;
            }
            attempt.results = [...attempt.results, { requirementId: requirement.id, run: structuredClone(result.run) }];
            publish();
            if (checkOutcome(result.run).kind !== "passed" || !isCheckOutputIdentity(result.run.outputIdentity)
              || !sameCheckExecutorFacts(result.run.executor, attempt.executor)) break;
          }
        }
      }
    } catch (error) {
      errors.push(error);
      attempt.observationFailure = { kind: "execution", message: detail(error) };
      if (signal.aborted) attempt.lifecycle = "stopped";
    }
    // Even an execution/publication failure must retain its actual source/cleanup observation.
    try { attempt = { ...attempt, ...await this.host.finish(structuredClone(attempt), activity) }; }
    catch (error) {
      errors.push(error);
      attempt.observationFailure = { kind: "restoration", message: detail(error) };
    }
    delete attempt.runningRequirementId;
    if (signal.aborted) attempt.lifecycle = "stopped";
    if (attempt.lifecycle !== "stopped") attempt.lifecycle = "settled";
    attempt.endedAt = this.host.now();
    if (!signal.aborted && checkSetupOutcome(attempt).kind === "verified") try { attempt.identity = this.host.identity(structuredClone(attempt)); }
    catch (error) { attempt.observationFailure = { kind: "identity", message: detail(error) }; }
    if (signal.aborted) { attempt.lifecycle = "stopped"; delete attempt.identity; }
    try { publish(); } catch (error) { errors.push(error); }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "The setup observation or its cleanup could not complete");
    return attempt;
  }
}
