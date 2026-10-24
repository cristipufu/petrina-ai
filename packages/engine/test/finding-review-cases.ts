/** Input contrasts only: no prose matcher or scripted agent pretends to decide task scope. */
export const findingReviewCases = [
  {
    name: "explicitly requested older repair",
    request: "Make required checks work without installed coding tools.",
    acceptance: "Required checks pass without installed coding tools.",
    decision: "Repair stand-in readiness as part of this task.",
    claim: "The readiness check still requires an installed coding tool.",
    evidence: "Starting version and current version: with no coding tools installed, the stand-in never becomes ready and the required check fails. With a tool installed it passes.",
  },
  {
    name: "unrelated older defect",
    request: "Make required checks work without installed coding tools.",
    acceptance: "Required checks pass without installed coding tools.",
    decision: "Leave account-page appearance for a separate task.",
    claim: "The account page clips the signed-out explanation.",
    evidence: "Starting version and current version: the signed-out explanation clips at narrow widths; it fits at wide widths. This is unrelated to required-check readiness.",
  },
  {
    name: "introduced regression",
    request: "Make required checks work without installed coding tools.",
    acceptance: "Required checks work with installed tools as well as stand-ins.",
    decision: "Preserve the existing installed-tool path.",
    claim: "The readiness change prevents an installed tool from becoming ready.",
    evidence: "Starting version: the installed tool becomes ready. Current version: the same tool never becomes ready; the no-tool stand-in passes.",
  },
  {
    name: "unverified claim",
    request: "Obtain a final Linux pass for the required checks.",
    acceptance: "Record passing required checks on the final Linux version.",
    decision: "Request final Linux proof through acceptance testing.",
    claim: "There is no recorded final Linux run.",
    evidence: "Linux execution was unavailable. No code defect has been reproduced; there is no current failing case.",
  },
] as const;
