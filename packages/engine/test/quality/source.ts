import { parse } from "@babel/parser";

type Node = { type: string; [key: string]: unknown };
const node = (value: unknown): value is Node => !!value && typeof value === "object" && typeof (value as Node).type === "string";
const text = (value: unknown): string | undefined => node(value) && value.type === "StringLiteral" ? value.value as string : undefined;
const name = (value: unknown): string | undefined => node(value) && value.type === "Identifier" ? value.name as string : undefined;

export interface SourceFacts {
  imports: { path: string; names: string[]; runtime: boolean }[];
  uncertain: boolean;
  promiseMatchers: number[];
  exclusiveTests: number[];
}

/** Parse syntax rather than searching prose, comments or template strings for code. Never executes a module. */
export function sourceFacts(source: string, filename: string): SourceFacts {
  const facts: SourceFacts = { imports: [], uncertain: false, promiseMatchers: [], exclusiveTests: [] };
  const ast = parse(source, { sourceType: "unambiguous", sourceFilename: filename, plugins: filename.endsWith("x") ? ["typescript", "jsx"] : ["typescript"], attachComment: false });
  const testNames = new Set(["it", "test", "describe"]);
  for (const statement of ast.program.body) if (statement.type === "ImportDeclaration" && ["bun:test", "vitest"].includes(statement.source.value)) {
    for (const specifier of statement.specifiers) if (specifier.type === "ImportSpecifier" && testNames.has(specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value)) testNames.add(specifier.local.name);
  }
  const rootName = (value: unknown): string | undefined => !node(value) ? undefined : name(value)
    ?? (value.type === "MemberExpression" ? rootName(value.object) : value.type === "CallExpression" ? rootName(value.callee) : undefined);
  function visit(value: unknown): void {
    if (!node(value)) return;
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(value.type)) {
      const path = text(value.source);
      const names = value.type === "ExportAllDeclaration" ? ["*"] : Array.isArray(value.specifiers) ? value.specifiers.flatMap(specifier => node(specifier) ? [name(specifier.imported) ?? (specifier.type === "ExportSpecifier" ? name(specifier.local) : undefined) ?? (specifier.type === "ImportNamespaceSpecifier" ? "*" : "default")] : []) : [];
      if (path) facts.imports.push({ path, names, runtime: value.importKind !== "type" && value.exportKind !== "type" });
    }
    if (value.type === "ImportExpression" || (value.type === "CallExpression" && (name(value.callee) === "require" || (node(value.callee) && value.callee.type === "Import")))) {
      const path = text(value.type === "ImportExpression" ? value.source : (value.arguments as unknown[])?.[0]);
      if (path) facts.imports.push({ path, names: ["*"], runtime: true });
      else facts.uncertain = true;
    }
    if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
      const property = value.computed ? text(value.property) : name(value.property);
      if (property === "rejects" || property === "resolves") facts.promiseMatchers.push((value.loc as { start: { line: number } }).start.line);
      if (property === "only" && testNames.has(rootName(value.object) ?? "")) facts.exclusiveTests.push((value.loc as { start: { line: number } }).start.line);
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (node(child)) visit(child);
    }
  }
  visit(ast);
  return facts;
}
