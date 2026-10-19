/** Distinguish an already-decided behavior from a missing decision and an actual contradiction. */
export const designReviewCases = [
  { name: "already covered", areas: ["Calendar behavior: skip nonexistent spring times; use only the first occurrence of a repeated autumn time."], acceptance: ["Test spring gaps and autumn repeats."], blocking: false },
  { name: "missing decision", areas: ["Store the chosen time zone and run daily at the saved local time."], acceptance: ["Test spring gaps and autumn repeats."], blocking: true },
  { name: "contradictory rules", areas: ["Use only the first occurrence of a repeated autumn time.", "The scheduler runs the routine at both occurrences of a repeated autumn time."], acceptance: ["Queue at most once for a repeated local time."], blocking: true },
] as const;
