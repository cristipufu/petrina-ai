/** Where an agent was in a step when Petrina restarted: for the restart line and the fresh start's summary. */
export interface WhereYouWere {
  /** The stage, in the coordinator's words ("Build", "Design, round 2"). */
  stage: string;
  role: string;
  /** What the agent did in this step, oldest first. */
  done: readonly string[];
  /** Files added, changed or removed in the working copy since the step started. */
  files?: readonly { change: string; file: string }[];
}


export const MAX_FILES = 30;

/** For a fresh conversation on a step whose conversation could not be reopened. */
export function formatWhereYouWere(where: WhereYouWere, reason: string, cause: "restart" | "screen" = "restart"): string {
  return [
    cause === "screen" ? `You asked for the screen while you were on “${where.stage}” as the ${where.role}, and your conversation could not be reopened (${reason}), so this one is fresh. The working copy keeps what you did in the background: build on it instead of redoing it, and check it first.` : `Petrina restarted while you were on “${where.stage}” as the ${where.role}, and your conversation could not be reopened (${reason}), so this one is fresh. The working copy keeps what you did: build on it instead of redoing it. Your last action may not have finished, so check the working copy first.`,
    `Earlier pages and browser logins are gone; the supplied headless browser starts with empty storage.`,
    ...whereDetails(
    where,
    "you"
  )
  ].join("\n\n");
}

/** What was done in the step so far and which files changed: the same in a restart's summary and a take-over's. */
function whereDetails(where: WhereYouWere, who: "you" | "it"): string[] {
  const files = where.files ?? [];
  return [
    where.done.length ? `What ${who} did last in this step, oldest first:\n${where.done.map((line) => `- ${line}`).join("\n")}` : `Nothing was recorded of what ${who} did in this step.`,
    files.length
      ? `Files added, changed or removed in the working copy since this step started:\n${files
          .slice(0, MAX_FILES)
          .map((entry) => `- ${entry.change}: ${entry.file}`)
          .join("\n")}${files.length > MAX_FILES ? `\n- and ${files.length - MAX_FILES} more` : ""}`
      : "No files were added, changed or removed in the working copy since this step started.",
  ];
}


/** For a fresh conversation that takes a step over from an agent that ran out of usage. */
export function formatTakeOver(where: WhereYouWere, from: string, words: string, refusal?: string): string {
  return [
    `${from} was doing this step${where.stage ? ` (“${where.stage}”, as the ${where.role})` : ""} and ${refusal ? `could not continue (${refusal})` : "ran out of usage"}. Its unfinished work is in this working copy, not committed: continue from it, don't start over.`,
    ...whereDetails(where, "it"),
    words ? `What it last said in this step, most recent first:\n\n${words}` : "It had not said anything yet in this step.",
  ].join("\n\n");
}
