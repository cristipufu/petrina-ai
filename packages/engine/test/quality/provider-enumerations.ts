import { PROVIDER_IDS } from "@petrina/core";
import { lineOf, name, node, text, WRAPPERS, type Node } from "./source-ast.js";

const PROVIDERS: ReadonlySet<string> = new Set<string>(PROVIDER_IDS);
const MIN_COLLECTION_PROVIDERS = 2;
const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);

export const isAllowedProviderRegistryFile = (file: string): boolean =>
  file === "packages/core/src/providers.ts"
  || file.startsWith("packages/core/src/demo")
  || file.startsWith("packages/agent-runtime/src/providers/")
  || file === "packages/agent-runtime/src/codex-report.ts";

const unwrap = (value: unknown): unknown =>
  node(value) && WRAPPERS.has(value.type) ? unwrap(value.expression) : value;

const providerLiteral = (value: unknown): string | undefined => {
  const candidate = text(unwrap(value));
  return candidate !== undefined && PROVIDERS.has(candidate) ? candidate : undefined;
};

const providerKey = (entry: unknown): string | undefined => {
  if (!node(entry) || (entry.type !== "ObjectProperty" && entry.type !== "ObjectMethod")) return undefined;
  const candidate = entry.computed ? text(unwrap(entry.key)) : (name(entry.key) ?? text(entry.key));
  return candidate !== undefined && PROVIDERS.has(candidate) ? candidate : undefined;
};

function collectConditionProviders(expr: unknown, into: Set<string>): void {
  const target = unwrap(expr);
  if (!node(target)) return;
  if (target.type === "LogicalExpression") {
    collectConditionProviders(target.left, into);
    collectConditionProviders(target.right, into);
    return;
  }
  if (target.type === "BinaryExpression" && EQUALITY_OPERATORS.has(String(target.operator))) {
    const left = providerLiteral(target.left);
    const right = providerLiteral(target.right);
    if (left) into.add(left);
    if (right) into.add(right);
  }
}

export function providerEnumerations(program: Node): number[] {
  const lines = new Set<number>();

  function visit(value: unknown, parent?: Node): void {
    if (!node(value)) return;

    if (value.type === "ArrayExpression" && Array.isArray(value.elements)) {
      const found = new Set<string>();
      for (const element of value.elements) {
        const id = providerLiteral(element);
        if (id) found.add(id);
      }
      if (found.size >= MIN_COLLECTION_PROVIDERS) lines.add(lineOf(value));
    } else if (value.type === "ObjectExpression" && Array.isArray(value.properties)) {
      const found = new Set<string>();
      for (const prop of value.properties) {
        const id = providerKey(prop);
        if (id) found.add(id);
      }
      if (found.size >= MIN_COLLECTION_PROVIDERS) lines.add(lineOf(value));
    } else if (value.type === "SwitchStatement" && Array.isArray(value.cases)) {
      const found = new Set<string>();
      for (const entry of value.cases) {
        if (!node(entry)) continue;
        const id = providerLiteral(entry.test);
        if (id) found.add(id);
      }
      if (found.size >= 1) lines.add(lineOf(value));
    } else if (value.type === "TSUnionType" && Array.isArray(value.types)) {
      const found = new Set<string>();
      for (const member of value.types) {
        if (!node(member) || member.type !== "TSLiteralType") continue;
        const id = providerLiteral(member.literal);
        if (id) found.add(id);
      }
      if (found.size >= MIN_COLLECTION_PROVIDERS) lines.add(lineOf(value));
    } else if (
      value.type === "LogicalExpression"
      && parent?.type !== "LogicalExpression"
      && parent?.type !== "IfStatement"
    ) {
      const found = new Set<string>();
      collectConditionProviders(value, found);
      if (found.size >= 1) lines.add(lineOf(value));
    } else if (value.type === "IfStatement" && parent?.type !== "IfStatement") {
      const found = new Set<string>();
      let current: unknown = value;
      while (node(current) && current.type === "IfStatement") {
        collectConditionProviders(current.test, found);
        current = current.alternate;
      }
      if (found.size >= 1) lines.add(lineOf(value));
    } else if (
      value.type === "BinaryExpression"
      && EQUALITY_OPERATORS.has(String(value.operator))
      && parent?.type !== "LogicalExpression"
      && parent?.type !== "IfStatement"
    ) {
      if (providerLiteral(value.left) || providerLiteral(value.right)) lines.add(lineOf(value));
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "start" || key === "end" || key === "loc") continue;
      if (Array.isArray(child)) {
        for (const item of child) if (node(item)) visit(item, value);
      } else if (node(child)) {
        visit(child, value);
      }
    }
  }

  visit(program);
  return [...lines].sort((a, b) => a - b);
}
