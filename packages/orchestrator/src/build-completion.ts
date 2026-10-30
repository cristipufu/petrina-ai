import { builderReturnWords, checkProblem, recordBuilderFindingAnswers, endAgentStep, JOURNEY_WORDS, openStep, refreshProofs, isGitObjectId } from "@petrina/core";
import type { RepositoryContext } from "./repository-context.js";
import type { BuildCompletionEffects, BuildCompletionHost, BuildCompletionInput } from "./ports/build-completion.js";

/** Apply an accepted Builder hand-back to its observed product version and actual journey records. */
export class BuildCompletion {
  constructor(private readonly host: BuildCompletionHost, private readonly effects: BuildCompletionEffects) {}

  async complete(scope: RepositoryContext, input: BuildCompletionInput): Promise<void> {
    const { task, work: repository } = scope;
    const { stageId, roleId, plannedProfileId: profileId, actualProfileId: by, result, maintenance, updating, sourceName, startingTree, given, checkFailures, rethought } = input;
    // A pull request's description: the builder's latest, or what it wrote before when it hands back none this time.
    const description = result.description?.trim() || repository.report?.description;
    repository.report = {
      summary: result.summary,
      changes: result.changes,
      ...(result.tests ? { tests: result.tests } : {}),
      ...(result.title ? { title: result.title } : {}),
      ...(description ? { description } : {}),
    };
    if (maintenance && !result.complete) { this.host.checkpoint(task); throw new Error(`Maintenance investigation is incomplete: ${result.summary}`); }
    await this.host.noteLearnings(scope, result.learnings, roleId, by);
    // One commit per task: the builder's work joins the branch's one commit, under its title.
    await this.effects.saveChanges(scope);
    if (updating) {
      await this.effects.finishPort(scope, updating);
      this.host.note(scope, "done", `Brought up to date with ${sourceName}: ${result.summary}`, roleId, by);
    } else delete repository.reviewedTree;
    const folded = await this.effects.fold(scope);
    if (folded && (!isGitObjectId(folded.version.head) || !isGitObjectId(folded.version.tree))) {
      if (repository.checks) repository.checks.current = false;
      throw new Error("Petrina could not read the folded product version");
    }
    // A successful fold already observed or created this exact version. No fold still needs a fresh read.
    const builtTree = folded ? folded.version.tree : await this.effects.tree(scope);
    if (task.proofRequests?.length) refreshProofs(task, await this.effects.versions(task));
    const changed = startingTree && builtTree ? startingTree !== builtTree : undefined;
    if (repository.checks) repository.checks.current = !!builtTree && repository.checks.tree === builtTree;
    const buildReport = openStep(task)?.agentResults?.findLast((entry) => entry.roleId === roleId && entry.profileId === by);
    if (buildReport && builtTree) buildReport.versions = { [repository.productId]: builtTree };
    const completedStep = openStep(task);
    if (completedStep && builtTree) completedStep.buildVersions = { ...completedStep.buildVersions, [repository.productId]: builtTree };
    if (completedStep && checkFailures.length) {
      const version = await this.effects.repairVersion(scope).catch(() => undefined);
      if (version?.sha && version.tree) completedStep.checkRepairs = checkFailures.flatMap((failure) => {
        if (!completedStep.findingIds?.includes(failure.check.findingId!) || !given.some((finding) => finding.id === failure.check.findingId)) return [];
        const answer = result.answers.find((answer) => answer.id === failure.check.findingId);
        return answer?.text.trim() ? [{ productId: repository.productId, failureNode: failure.nodeId, checkId: failure.check.id!, attemptId: failure.attempt.id, findingId: answer.id,
          sha: version.sha!, tree: version.tree!, definition: version.definition, commands: version.commands, answer: { fixed: answer.fixed, text: answer.text.slice(0, 600) } }] : [];
      });
    }
    // The next fix round or update goes back to the conversation that really completed this build.
    const conversation = repository.conversation;
    if (conversation?.briefed && conversation.roleId === roleId) repository.builderSession = { stageId, profileId: by, plannedProfileId: profileId, toolId: conversation.toolId, model: conversation.model, sessionId: conversation.sessionId, ...(conversation.context ? { context: conversation.context } : {}), ...(rethought ? { rethought: true } : {}) };
    const fixing = task.fixing;
    const fixed = fixing ? recordBuilderFindingAnswers(task, given, result.answers, { productId: repository.productId, shared: !!task.repositories, at: this.host.now() }) : 0;
    // A changed return awaits verification. An unchanged return retains the unresolved problem,
    // including when an earlier edit or check-definition change made that evidence outdated.
    const problem = changed === true ? undefined : checkProblem(repository);
    const outcome = builderReturnWords(changed, problem, fixed);
    const returnedStep = openStep(task);
    if (returnedStep?.kind === "agent") returnedStep.builderReturn = { productId: repository.productId, ...(changed !== undefined ? { changed } : {}), claimedFixes: fixed, outcome };
    if (!updating) this.host.note(scope, "done", `${outcome}: ${result.summary}`, roleId, by);
    endAgentStep(
      task,
      updating ? { outcome: JOURNEY_WORDS.broughtUpToDate, reason: sourceName === "main" ? JOURNEY_WORDS.upToDate : `up to date with ${sourceName}` } : fixing || (changed === false && problem) ? { outcome, reason: outcome, ...(problem ? { tone: "back" as const } : {}) } : { outcome: changed === false ? JOURNEY_WORDS.unchanged : JOURNEY_WORDS.built, reason: JOURNEY_WORDS.readyForReview },
      this.host.now(),
    );
  }
}
