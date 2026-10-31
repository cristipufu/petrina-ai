/** Stateless normal-mode CLI arguments. Native adapters register these same formatters. */
export interface TerminalArgumentInput { session: string; model: string; effort: string; mode: string }
export type TerminalArgumentFormatter = (input: TerminalArgumentInput) => string[];

export const claudeTerminalArguments: TerminalArgumentFormatter = ({
  session,
  model,
  effort,
  mode
}) => [
  "--resume",
  session,
  "--model",
  model,
  "--effort",
  effort,
  "--permission-mode",
  mode
];
export const codexTerminalArguments: TerminalArgumentFormatter = ({
  session,
  model,
  effort
}) => [
  "resume",
  session,
  "--model",
  model,
  "-c",
  `model_reasoning_effort=${effort}`,
  "--sandbox",
  "workspace-write",
  "--ask-for-approval",
  "on-request",
  "-c",
  "approvals_reviewer=user",
  "--no-daemon"
];
export const grokTerminalArguments: TerminalArgumentFormatter = ({ session, model, effort }) => [
  "--resume",
  session,
  "--model",
  model,
  "--effort",
  effort,
];
export const antigravityTerminalArguments: TerminalArgumentFormatter = ({ session, model, effort }) => [
  "--conversation",
  session,
  "--model",
  model,
  "--effort",
  effort,
];
