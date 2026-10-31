import { parse } from "@babel/parser";

export const MAX_PRODUCTION_LINE_WIDTH = 160;

export interface FormattingViolation {
  line: number;
  reason: string;
}

type Loc = { start: { line: number; column: number }; end: { line: number; column: number } };
type AstNode = { type: string; start: number; end: number; loc: Loc; [key: string]: unknown };
const isNode = (value: unknown): value is AstNode =>
  Boolean(
    value
      && typeof value === "object"
      && typeof (value as AstNode).type === "string"
      && typeof (value as AstNode).start === "number",
  );

interface Edit {
  start: number;
  end: number;
  text: string;
}

const STATEMENT_CONTAINERS = new Set([
  "Program",
  "BlockStatement",
  "SwitchCase",
  "StaticBlock",
  "TSModuleBlock",
  "ClassBody",
]);
const BLOCK_CONTAINERS = new Set(["Program", "BlockStatement", "SwitchCase", "StaticBlock", "TSModuleBlock"]);
const FUNCTION_TYPES = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
  "TSDeclareMethod",
  "TSMethodSignature",
]);

function lineIndentOf(lines: readonly string[], line1Based: number): string {
  const text = lines[line1Based - 1] ?? "";
  const match = /^([ \t]*)/.exec(text);
  return match ? match[1]! : "";
}

export function formatPass(
  source: string,
  filename: string,
): { output: string; changed: boolean; violations: FormattingViolation[] } {
  const lines = source.split("\n");
  const ast = parse(source, {
    sourceType: "unambiguous",
    sourceFilename: filename,
    plugins: filename.endsWith("x") ? ["typescript", "jsx"] : ["typescript"],
    attachComment: false,
  });

  const edits: Edit[] = [];
  const recordedByLine = new Map<number, string>();
  const recordViolation = (line: number, reason: string) => {
    if (!recordedByLine.has(line)) recordedByLine.set(line, reason);
  };

  const canAdd = (start: number, end: number) =>
    start <= end && edits.every((existing) => end <= existing.start || start >= existing.end);

  const tryAddAll = (batch: readonly Edit[]): boolean => {
    if (!batch.every((item) => canAdd(item.start, item.end))) return false;
    for (let i = 0; i < batch.length; i++) {
      for (let j = i + 1; j < batch.length; j++) {
        if (!(batch[i]!.end <= batch[j]!.start || batch[i]!.start >= batch[j]!.end)) return false;
      }
    }
    edits.push(...batch);
    return true;
  };

  const lineLen = (line1Based: number) => (lines[line1Based - 1] ?? "").length;

  function wrapCommaDelimited(
    openEnd: number,
    closeStart: number,
    items: readonly AstNode[],
    line1Based: number,
    separator: "," | ";" = ",",
  ): boolean {
    if (items.length < 2) return false;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (first.loc.start.line !== last.loc.end.line || first.loc.start.line !== line1Based) return false;
    const baseIndent = lineIndentOf(lines, line1Based);
    const innerIndent = `${baseIndent}  `;
    const openGap = source.slice(openEnd, first.start);
    const closeGap = source.slice(last.end, closeStart);
    if (!/^[ \t]*$/.test(openGap) || !/^[ \t,;]*$/.test(closeGap)) return false;
    const batch: Edit[] = [{ start: openEnd, end: first.start, text: `\n${innerIndent}` }];
    for (let i = 1; i < items.length; i++) {
      const prev = items[i - 1]!;
      const curr = items[i]!;
      const gap = source.slice(prev.end, curr.start);
      if (!/^[ \t,;]*$/.test(gap)) return false;
      const alreadyTerminated = /[;,]$/.test(source.slice(prev.start, prev.end));
      const sep = alreadyTerminated ? "" : gap.includes(";") ? ";" : separator;
      batch.push({ start: prev.end, end: curr.start, text: `${sep}\n${innerIndent}` });
    }
    const lastAlreadyTerminated = /[;,]$/.test(source.slice(last.start, last.end));
    const trailing = lastAlreadyTerminated
      ? ""
      : closeGap.includes(";")
        ? ";"
        : closeGap.includes(",")
          ? ","
          : "";
    batch.push({ start: last.end, end: closeStart, text: `${trailing}\n${baseIndent}` });
    if (!tryAddAll(batch)) return false;
    recordViolation(
      line1Based,
      `wrap structured line exceeding ${MAX_PRODUCTION_LINE_WIDTH} characters; run 'bun run format'`,
    );
    return true;
  }

  function visit(node: unknown, parent?: AstNode): void {
    if (!isNode(node)) return;

    if (STATEMENT_CONTAINERS.has(node.type)) {
      const list = (node.type === "SwitchCase" ? node.consequent : node.body) as AstNode[];
      if (Array.isArray(list) && list.length >= 2) {
        const isSingleLineBlock =
          (node.type === "BlockStatement"
            || node.type === "ClassBody"
            || node.type === "StaticBlock"
            || node.type === "TSModuleBlock")
          && node.loc.start.line === node.loc.end.line;
        const baseIndent = lineIndentOf(lines, node.loc.start.line);
        const childIndent =
          node.type === "Program"
            ? ""
            : node.type === "SwitchCase" || isSingleLineBlock
              ? `${baseIndent}  `
              : lineIndentOf(lines, list[0]!.loc.start.line);
        let hadPacked = false;
        for (let i = 1; i < list.length; i++) {
          const prev = list[i - 1]!;
          const curr = list[i]!;
          if (prev.loc.end.line === curr.loc.start.line) {
            const gap = source.slice(prev.end, curr.start);
            if (/^[ \t;]*$/.test(gap)) {
              const semi = gap.includes(";") ? ";" : "";
              if (tryAddAll([{ start: prev.end, end: curr.start, text: `${semi}\n${childIndent}` }])) {
                hadPacked = true;
                recordViolation(curr.loc.start.line, "keep one statement or member per line; run 'bun run format'");
              }
            }
          }
        }
        if (hadPacked && isSingleLineBlock) {
          const first = list[0]!;
          const last = list[list.length - 1]!;
          const openGap = source.slice(node.start + 1, first.start);
          if (/^[ \t]*$/.test(openGap)) {
            tryAddAll([{ start: node.start + 1, end: first.start, text: `\n${childIndent}` }]);
          }
          const closeGap = source.slice(last.end, node.end - 1);
          if (/^[ \t;]*$/.test(closeGap)) {
            const semi = closeGap.includes(";") ? ";" : "";
            tryAddAll([{ start: last.end, end: node.end - 1, text: `${semi}\n${baseIndent}` }]);
          }
        }
      }
    }

    if (node.type === "IfStatement" && isNode(node.consequent) && isNode(node.alternate)) {
      if (node.consequent.type !== "BlockStatement" && node.consequent.loc.end.line === node.alternate.loc.start.line) {
        const gap = source.slice(node.consequent.end, node.alternate.start);
        const match = /^([ \t;]*)\belse\b([ \t]*)$/.exec(gap);
        if (match) {
          const indent = lineIndentOf(lines, node.loc.start.line);
          const semi = match[1]!.includes(";") ? ";" : "";
          if (
            tryAddAll([
              { start: node.consequent.end, end: node.alternate.start, text: `${semi}\n${indent}else ` },
            ])
          ) {
            recordViolation(node.alternate.loc.start.line, "place 'else' on its own line; run 'bun run format'");
          }
        }
      }
    }

    if (
      node.type === "VariableDeclaration"
      && (BLOCK_CONTAINERS.has(parent?.type ?? "") || parent?.type === "ExportNamedDeclaration")
      && Array.isArray(node.declarations)
      && node.declarations.length >= 2
    ) {
      const decls = node.declarations as AstNode[];
      const kind = node.kind as string;
      const prefix = parent?.type === "ExportNamedDeclaration" ? `export ${kind}` : kind;
      const indent = lineIndentOf(lines, parent?.type === "ExportNamedDeclaration" ? parent.loc.start.line : node.loc.start.line);
      for (let i = 1; i < decls.length; i++) {
        const prev = decls[i - 1]!;
        const curr = decls[i]!;
        if (prev.loc.end.line === curr.loc.start.line) {
          const gap = source.slice(prev.end, curr.start);
          if (/^[ \t]*,[ \t]*$/.test(gap)) {
            if (tryAddAll([{ start: prev.end, end: curr.start, text: `;\n${indent}${prefix} ` }])) {
              recordViolation(curr.loc.start.line, "keep one variable declaration per line; run 'bun run format'");
            }
          }
        }
      }
    }

    const startLine = node.loc.start.line;
    if (node.loc.end.line === startLine && lineLen(startLine) > MAX_PRODUCTION_LINE_WIDTH) {
      if (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration") {
        const specs = (node.specifiers as AstNode[] | undefined)?.filter(
          (spec) => spec.type === "ImportSpecifier" || spec.type === "ExportSpecifier",
        );
        if (specs && specs.length >= 2) {
          const openBrace = source.lastIndexOf("{", specs[0]!.start);
          const closeBrace = source.indexOf("}", specs[specs.length - 1]!.end);
          if (openBrace >= node.start && closeBrace > openBrace && closeBrace <= node.end) {
            wrapCommaDelimited(openBrace + 1, closeBrace, specs, startLine);
          }
        }
      } else if (node.type === "ObjectExpression" || node.type === "ObjectPattern") {
        const props = node.properties as AstNode[];
        if (Array.isArray(props) && props.length >= 2 && source[node.start] === "{" && source[node.end - 1] === "}") {
          wrapCommaDelimited(node.start + 1, node.end - 1, props, startLine);
        }
      } else if (node.type === "TSTypeLiteral") {
        const members = node.members as AstNode[];
        if (
          Array.isArray(members)
          && members.length >= 2
          && source[node.start] === "{"
          && source[node.end - 1] === "}"
        ) {
          wrapCommaDelimited(node.start + 1, node.end - 1, members, startLine, ";");
        }
      } else if (node.type === "ArrayExpression") {
        const elems = (node.elements as (AstNode | null)[]).filter((item): item is AstNode => isNode(item));
        if (
          elems.length >= 2
          && elems.length === (node.elements as unknown[]).length
          && source[node.start] === "["
          && source[node.end - 1] === "]"
        ) {
          wrapCommaDelimited(node.start + 1, node.end - 1, elems, startLine);
        }
      } else if (FUNCTION_TYPES.has(node.type)) {
        const params = node.params as AstNode[];
        if (Array.isArray(params) && params.length >= 2) {
          const openParen = source.lastIndexOf("(", params[0]!.start);
          const closeParen = source.indexOf(")", params[params.length - 1]!.end);
          if (openParen >= node.start && closeParen > openParen && closeParen <= node.end) {
            wrapCommaDelimited(openParen + 1, closeParen, params, startLine);
          }
        }
      } else if (node.type === "CallExpression" || node.type === "NewExpression") {
        const args = node.arguments as AstNode[];
        const callee = node.callee as AstNode;
        if (Array.isArray(args) && args.length >= 2 && isNode(callee)) {
          const openParen = source.indexOf("(", callee.end);
          if (openParen >= callee.end && openParen < args[0]!.start && source[node.end - 1] === ")") {
            wrapCommaDelimited(openParen + 1, node.end - 1, args, startLine);
          }
        }
      } else if (node.type === "JSXOpeningElement") {
        const attrs = node.attributes as AstNode[];
        if (Array.isArray(attrs) && attrs.length >= 2) {
          const baseIndent = lineIndentOf(lines, startLine);
          const attrIndent = `${baseIndent}  `;
          const nameNode = node.name as AstNode;
          const typeParams = (node.typeParameters ?? node.typeArguments) as AstNode | undefined;
          const headerEnd = typeParams ? typeParams.end : nameNode.end;
          const closeTokenStart = node.selfClosing ? node.end - 2 : node.end - 1;
          const openGap = source.slice(headerEnd, attrs[0]!.start);
          const closeGap = source.slice(attrs[attrs.length - 1]!.end, closeTokenStart);
          if (/^[ \t]+$/.test(openGap) && /^[ \t]*$/.test(closeGap)) {
            const batch: Edit[] = [{ start: headerEnd, end: attrs[0]!.start, text: `\n${attrIndent}` }];
            let ok = true;
            for (let i = 1; i < attrs.length; i++) {
              const gap = source.slice(attrs[i - 1]!.end, attrs[i]!.start);
              if (!/^[ \t]+$/.test(gap)) {
                ok = false;
                break;
              }
              batch.push({ start: attrs[i - 1]!.end, end: attrs[i]!.start, text: `\n${attrIndent}` });
            }
            if (ok) {
              batch.push({ start: attrs[attrs.length - 1]!.end, end: closeTokenStart, text: `\n${baseIndent}` });
              if (tryAddAll(batch)) {
                recordViolation(
                  startLine,
                  `wrap structured line exceeding ${MAX_PRODUCTION_LINE_WIDTH} characters; run 'bun run format'`,
                );
              }
            }
          }
        }
      }
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(value)) value.forEach((child) => visit(child, node));
      else if (isNode(value)) visit(value, node);
    }
  }

  visit(ast.program);
  const violations = [...recordedByLine.entries()]
    .sort(([a], [b]) => a - b)
    .map(([line, reason]) => ({ line, reason }));
  if (!edits.length) return { output: source, changed: false, violations: [] };
  edits.sort((a, b) => b.start - a.start);
  let output = source;
  for (const edit of edits) {
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end);
  }
  return { output, changed: true, violations };
}

export function formatProductionSource(source: string, filename: string): string {
  if (filename.endsWith(".d.ts")) return source;
  let current = source;
  for (let pass = 0; pass < 8; pass++) {
    const result = formatPass(current, filename);
    if (!result.changed) break;
    current = result.output;
  }
  return current;
}

export function productionFormattingViolations(source: string, filename: string): FormattingViolation[] {
  if (filename.endsWith(".d.ts")) return [];
  return formatPass(source, filename).violations;
}
