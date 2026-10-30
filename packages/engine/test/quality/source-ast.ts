export type Node = { type: string; [key: string]: unknown };

export const node = (value: unknown): value is Node =>
  !!value && typeof value === "object" && typeof (value as Node).type === "string";

export const text = (value: unknown): string | undefined =>
  node(value) && value.type === "StringLiteral" ? (value.value as string) : undefined;

export const name = (value: unknown): string | undefined =>
  node(value) && value.type === "Identifier" ? (value.name as string) : undefined;

export const lineOf = (value: Node): number => (value.loc as { start: { line: number } }).start.line;

export const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

export const WRAPPERS = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "ParenthesizedExpression",
]);

export const CALLS = new Set(["CallExpression", "OptionalCallExpression"]);
