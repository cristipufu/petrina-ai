import { CALLS, FUNCTIONS, lineOf, name, node, text, WRAPPERS, type Node } from "./source-ast.js";

export interface CrossPlatformHazards {
  /** `onGone` callbacks that discard the cleanup promise instead of collecting/awaiting it (or throwing in observer-failure tests). */
  discardedOnGone: number[];
  /** `rmSync(path, { recursive: true })` calls that bypass Windows `EBUSY`/`EPERM` backoff and open-handle checks. */
  recursiveRmSync: number[];
  /** `process.kill(pid, 0)` probes that treat zombies and unowned PIDs as live test children. */
  rawPidZeroKill: number[];
}

const unwrap = (value: unknown): unknown =>
  node(value) && WRAPPERS.has(value.type) ? unwrap(value.expression) : value;

const propertyName = (member: Node): string | undefined =>
  member.computed ? text(unwrap(member.property)) : name(member.property);

const keyName = (entry: Node): string | undefined =>
  entry.computed ? text(unwrap(entry.key)) : (name(entry.key) ?? text(entry.key));

function containsNode(root: unknown, predicate: (entry: Node) => boolean): boolean {
  if (!node(root)) return false;
  if (predicate(root)) return true;
  for (const [key, child] of Object.entries(root)) {
    if (key === "loc" || key === "start" || key === "end") continue;
    if (Array.isArray(child)) {
      for (const item of child) {
        if (node(item) && !FUNCTIONS.has(item.type) && containsNode(item, predicate)) return true;
      }
    } else if (node(child) && !FUNCTIONS.has(child.type) && containsNode(child, predicate)) {
      return true;
    }
  }
  return false;
}

function isDiscardedOnGoneCallback(fn: Node): boolean {
  const body = unwrap(fn.body);
  if (!node(body)) return false;
  if (body.type === "BlockStatement" && Array.isArray(body.body) && body.body.length === 0) {
    return true;
  }
  if (body.type === "Identifier" && name(body) === "undefined") {
    return true;
  }
  if (body.type === "UnaryExpression" && body.operator === "void") {
    return true;
  }
  const params = Array.isArray(fn.params) ? fn.params : [];
  if (params.length === 0) {
    const throwsOrReadsArguments = containsNode(
      body,
      (entry) => entry.type === "ThrowStatement" || (entry.type === "Identifier" && name(entry) === "arguments"),
    );
    if (!throwsOrReadsArguments) return true;
  }
  return false;
}

function hasRecursiveTrueOption(arg: unknown): boolean {
  const target = unwrap(arg);
  if (!node(target) || target.type !== "ObjectExpression" || !Array.isArray(target.properties)) return false;
  for (const prop of target.properties) {
    if (!node(prop) || prop.type !== "ObjectProperty") continue;
    if (keyName(prop) !== "recursive") continue;
    const val = unwrap(prop.value);
    if (node(val) && val.type === "BooleanLiteral" && val.value === true) return true;
  }
  return false;
}

function isNumericZero(arg: unknown): boolean {
  const target = unwrap(arg);
  if (!node(target)) return false;
  if (target.type === "NumericLiteral" && target.value === 0) return true;
  if (target.type === "UnaryExpression" && (target.operator === "+" || target.operator === "-")) {
    const inner = unwrap(target.argument);
    return node(inner) && inner.type === "NumericLiteral" && inner.value === 0;
  }
  return false;
}

export function crossPlatformHazards(program: Node): CrossPlatformHazards {
  const discardedOnGone: number[] = [];
  const recursiveRmSync: number[] = [];
  const rawPidZeroKill: number[] = [];

  const rmSyncLocals = new Set<string>();
  const fsNamespaces = new Set<string>();
  const processObjects = new Set<string>(["process"]);
  const processKillLocals = new Set<string>();

  if (Array.isArray(program.body)) {
    for (const statement of program.body) {
      if (!node(statement) || statement.type !== "ImportDeclaration") continue;
      if (statement.importKind === "type") continue;
      const source = text(statement.source) ?? "";
      const specifiers = Array.isArray(statement.specifiers) ? (statement.specifiers as Node[]) : [];
      if (source === "node:fs" || source === "fs") {
        for (const spec of specifiers) {
          if (spec.importKind === "type") continue;
          if (spec.type === "ImportSpecifier" && (name(spec.imported) ?? text(spec.imported)) === "rmSync") {
            const local = name(spec.local);
            if (local) rmSyncLocals.add(local);
          } else if (spec.type === "ImportNamespaceSpecifier" || spec.type === "ImportDefaultSpecifier") {
            const local = name(spec.local);
            if (local) fsNamespaces.add(local);
          }
        }
      } else if (source === "node:process" || source === "process") {
        for (const spec of specifiers) {
          if (spec.importKind === "type") continue;
          if (spec.type === "ImportSpecifier" && (name(spec.imported) ?? text(spec.imported)) === "kill") {
            const local = name(spec.local);
            if (local) processKillLocals.add(local);
          } else if (spec.type === "ImportNamespaceSpecifier" || spec.type === "ImportDefaultSpecifier") {
            const local = name(spec.local);
            if (local) processObjects.add(local);
          }
        }
      }
    }
  }

  const isProcessObject = (target: unknown): boolean => {
    const unwrapped = unwrap(target);
    if (!node(unwrapped)) return false;
    if (unwrapped.type === "Identifier") return processObjects.has(name(unwrapped) ?? "");
    if (unwrapped.type === "MemberExpression" || unwrapped.type === "OptionalMemberExpression") {
      const obj = unwrap(unwrapped.object);
      return node(obj) && obj.type === "Identifier" && name(obj) === "globalThis" && propertyName(unwrapped) === "process";
    }
    return false;
  };

  const isRmSyncCallee = (callee: unknown): boolean => {
    const unwrapped = unwrap(callee);
    if (!node(unwrapped)) return false;
    if (unwrapped.type === "Identifier") {
      const id = name(unwrapped) ?? "";
      return rmSyncLocals.has(id) || id === "rmSync";
    }
    if (unwrapped.type === "MemberExpression" || unwrapped.type === "OptionalMemberExpression") {
      if (propertyName(unwrapped) !== "rmSync") return false;
      const obj = unwrap(unwrapped.object);
      if (node(obj) && obj.type === "Identifier" && fsNamespaces.has(name(obj) ?? "")) return true;
      return true;
    }
    return false;
  };

  const isProcessKillCallee = (callee: unknown): boolean => {
    const unwrapped = unwrap(callee);
    if (!node(unwrapped)) return false;
    if (unwrapped.type === "Identifier") return processKillLocals.has(name(unwrapped) ?? "");
    if (unwrapped.type === "MemberExpression" || unwrapped.type === "OptionalMemberExpression") {
      return propertyName(unwrapped) === "kill" && isProcessObject(unwrapped.object);
    }
    return false;
  };

  function visit(current: unknown): void {
    if (!node(current)) return;

    if (current.type === "ObjectProperty" && keyName(current) === "onGone") {
      const fn = unwrap(current.value);
      if (node(fn) && (fn.type === "ArrowFunctionExpression" || fn.type === "FunctionExpression")) {
        if (isDiscardedOnGoneCallback(fn)) discardedOnGone.push(lineOf(current));
      }
    } else if (current.type === "ObjectMethod" && keyName(current) === "onGone") {
      if (isDiscardedOnGoneCallback(current)) discardedOnGone.push(lineOf(current));
    } else if (current.type === "AssignmentExpression") {
      const left = unwrap(current.left);
      const right = unwrap(current.right);
      if (
        node(left)
        && (left.type === "MemberExpression" || left.type === "OptionalMemberExpression")
        && propertyName(left) === "onGone"
        && node(right)
        && (right.type === "ArrowFunctionExpression" || right.type === "FunctionExpression")
        && isDiscardedOnGoneCallback(right)
      ) {
        discardedOnGone.push(lineOf(current));
      }
    }

    if (CALLS.has(current.type)) {
      const args = Array.isArray(current.arguments) ? current.arguments : [];
      if (args.length >= 2 && isRmSyncCallee(current.callee) && hasRecursiveTrueOption(args[1])) {
        recursiveRmSync.push(lineOf(current));
      }
      if (args.length >= 2 && isProcessKillCallee(current.callee) && isNumericZero(args[1])) {
        rawPidZeroKill.push(lineOf(current));
      }
    }

    for (const [key, child] of Object.entries(current)) {
      if (key === "loc" || key === "start" || key === "end") continue;
      if (Array.isArray(child)) {
        for (const item of child) visit(item);
      } else if (node(child)) {
        visit(child);
      }
    }
  }

  visit(program);
  return { discardedOnGone, recursiveRmSync, rawPidZeroKill };
}
