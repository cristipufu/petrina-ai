import type { Role } from "./model.js";

// Editable defaults live here; execution shares the ordinary notes/build contracts.
const evidence = "Work within the selected repository and focus. Use only evidence available through installed tools. State missing evidence and uncertainty. Keep investigations bounded and changes small. Never publish, merge, or change shared services. Report findings honestly, including when nothing actionable was found.";
const starts = [
  [
    "dead-code",
    "Dead-code cleanup",
    "build",
    "Prove code unused before removing it.",
    "Check references, history, indirect entry points and available runtime evidence. Explain why each removal is safe; preserve recovery paths."
  ],
  [
    "stale-feature",
    "Stale-feature cleanup",
    "build",
    "Safely retire completed experiments.",
    "Verify retirement and actual configuration where accessible. Trace wrappers, schemas, dynamic names and external consumers. Preserve killswitches, local overrides and permanent operational controls. Leave ambiguous candidates for a decision."
  ],
  [
    "flaky-test",
    "Flaky-test repair",
    "build",
    "Repair small, confirmed intermittent test failures.",
    "Use recent CI history to distinguish flakes from consistent failures. Reproduce a cause and verify a focused repair. Preserve assertions and parallelism; never conceal failures with retries, skips or relaxed deadlines."
  ],
  [
    "agent-instruction",
    "Agent-instruction improvement",
    "build",
    "Test one misleading agent instruction.",
    "Find evidence of one instruction causing waste or poor results. Compare the same task, repository snapshot, model and effort twice with only that instruction changed. Measure quality, behavior, calls, tokens and elapsed work where available. Claim improvement only with a valid controlled comparison; report unavailable measurements. Do not build a replay service."
  ],
  [
    "ci-optimization",
    "CI optimization",
    "notes",
    "Rank evidenced opportunities to reduce CI work.",
    "Inspect CI definitions and actual recent run history. Rank opportunities by minutes saved per day. Separate measured savings from explicit estimates and assumptions. Preserve coverage; report opportunities without modifying files."
  ],
  [
    "bug-finder",
    "Bug finder",
    "notes",
    "Find reproducible product defects in a bounded area.",
    "Choose a bounded area from the focus. Reproduce concrete defects and record expected behavior, observed behavior, steps and evidence. Exclude speculative improvements. Report findings without modifying files."
  ],
] as const;

export const MAINTENANCE_ROLES: readonly Role[] = starts.map(([id, name, result, purpose, instructions]) => ({
  id: `maintenance-${id}`, name, result, purpose, instructions: `${instructions}\n${evidence}`,
  category: "maintenance", icon: id === "bug-finder" ? "bug" : "search", tone: "teal",
  canEdit: result === "build", column: result === "build" ? "building" : "designing",
  sees: "The saved routine, selected product, focus and evidence available to the installed tools.",
  handsBack: result === "build" ? "Findings and any small changes ready for independent review." : "An evidence-based report, including gaps and reproduction steps.",
}));
