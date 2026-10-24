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
  /** Synchronous child process calls: each holds the whole test worker until the child's exit is reported. */
  blockingCalls: number[];
  /** The fixtures' asynchronous commands and repository helpers, or local wrappers of them, that nothing waits for. */
  unfinished: { line: number; name: string }[];
  /** Asynchronous callbacks given to APIs that call them without waiting: assertions, array tests, engine announcements, locked stand-in updates. */
  asyncCallbacks: number[];
  /** Direct resource access, including Bun's global APIs, for lower-layer dependency checks. */
  effectAccess: { line: number; name: string }[];
}

const BLOCKING = new Set(["spawnSync", "execFileSync", "execSync"]);
/** What the fixtures export as asynchronous work: their callers must wait for it. */
const ASYNC_HELPERS = new Set(["git", "gitWith", "runGit", "runCommand", "commitAt", "makeProduct", "makeWorld", "repositorySeed", "remoteRef"]);
const FIXTURE_MODULE = /^\.\.?\/(?:.*\/)?(?:fixtures|support|commands)(?:\.[jt]s)?$/;
const REJECTIONS = /^\.\.?\/(?:.*\/)?rejections(?:\.[jt]s)?$/;
const COMBINATORS = new Set(["all", "allSettled", "race", "any"]);
/** Array methods that use a callback's answer at once: a promise there is never waited for. */
const SYNC_CALLBACKS = new Set(["forEach", "filter", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "sort"]);
const SYNC_CALLERS = new Set(["subscribe", "setGitHub", "updateGitHub", "editSaved", "setScript"]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
const WRAPPERS = new Set(["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "ParenthesizedExpression"]);
const CALLS = new Set(["CallExpression", "OptionalCallExpression"]);

/** Parse syntax rather than searching prose, comments or template strings for code. Never executes a module. */
export function sourceFacts(source: string, filename: string): SourceFacts {
  const facts: SourceFacts = { imports: [], uncertain: false, promiseMatchers: [], exclusiveTests: [], blockingCalls: [], unfinished: [], asyncCallbacks: [], effectAccess: [] };
  const ast = parse(source, { sourceType: "unambiguous", sourceFilename: filename, plugins: filename.endsWith("x") ? ["typescript", "jsx"] : ["typescript"], attachComment: false });
  const testNames = new Set(["it", "test", "describe"]);
  for (const statement of ast.program.body) if (statement.type === "ImportDeclaration" && ["bun:test", "vitest"].includes(statement.source.value)) {
    for (const specifier of statement.specifiers) if (specifier.type === "ImportSpecifier" && testNames.has(specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value)) testNames.add(specifier.local.name);
  }
  const rootName = (value: unknown): string | undefined => !node(value) ? undefined : name(value)
    ?? (value.type === "MemberExpression" ? rootName(value.object) : value.type === "CallExpression" ? rootName(value.callee) : undefined);
  const line = (value: Node) => (value.loc as { start: { line: number } }).start.line;
  const property = (value: Node) => value.computed ? text(value.property) : name(value.property);
  const accessPath = (value: unknown): (string | undefined)[] => !node(value) ? [] : value.type === "Identifier" ? [name(value)]
    : value.type === "MemberExpression" || value.type === "OptionalMemberExpression" ? [...accessPath(value.object), property(value)] : [];
  const globalPath = (value: unknown) => {
    const parts = accessPath(value);
    return parts[0] === "globalThis" ? parts.slice(1) : parts;
  };
  function visit(value: unknown): void {
    if (!node(value)) return;
    if (value.type === "ImportDeclaration" && /^(?:(?:node:)?child_process|bun)$/.test(text(value.source) ?? "")) {
      for (const specifier of value.specifiers as Node[]) if (specifier.type === "ImportSpecifier" && BLOCKING.has(name(specifier.imported) ?? text(specifier.imported) ?? "")) facts.blockingCalls.push(line(specifier));
    }
    if ((value.type === "MemberExpression" || value.type === "OptionalMemberExpression") && BLOCKING.has(property(value) ?? "")) facts.blockingCalls.push(line(value));
    if (value.type === "ObjectPattern") for (const entry of value.properties as Node[]) if (entry.type === "ObjectProperty" && BLOCKING.has(name(entry.key) ?? text(entry.key) ?? "")) facts.blockingCalls.push(line(entry));
    if (value.type === "VariableDeclarator") {
      const init = globalPath(value.init);
      if (init.length === 1 && ["Bun", "process"].includes(init[0] ?? "") || name(value.init) === "globalThis") facts.effectAccess.push({ line: line(value), name: `${init[0] ?? "globalThis"} alias` });
    }
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(value.type)) {
      const path = text(value.source);
      const specifiers = Array.isArray(value.specifiers) ? value.specifiers.filter(specifier => node(specifier) && specifier.importKind !== "type" && specifier.exportKind !== "type") : [];
      const names = value.type === "ExportAllDeclaration" ? ["*"] : specifiers.flatMap(specifier => node(specifier) ? [name(specifier.imported) ?? (specifier.type === "ExportSpecifier" ? name(specifier.local) : undefined) ?? (specifier.type === "ImportNamespaceSpecifier" ? "*" : "default")] : []);
      if (path) facts.imports.push({ path, names, runtime: value.importKind !== "type" && value.exportKind !== "type" && (!Array.isArray(value.specifiers) || !value.specifiers.length || !!specifiers.length) });
    }
    if (value.type === "ImportExpression" || (value.type === "CallExpression" && (name(value.callee) === "require" || (node(value.callee) && value.callee.type === "Import")))) {
      const path = text(value.type === "ImportExpression" ? value.source : (value.arguments as unknown[])?.[0]);
      if (path) facts.imports.push({ path, names: ["*"], runtime: true });
      else facts.uncertain = true;
    }
    if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
      const member = property(value);
      const [owner, operation] = globalPath(value);
      if (owner === "Bun" && (operation === undefined || ["spawn", "spawnSync", "file", "write", "serve", "listen", "connect", "which"].includes(operation))
        || owner === "process" && (operation === undefined || ["env", "cwd", "chdir", "kill", "exit", "abort"].includes(operation))
        || ["fetch", "WebSocket", "Worker", "EventSource", "XMLHttpRequest"].includes(owner ?? "")) facts.effectAccess.push({ line: line(value), name: operation ? `${owner}.${operation}` : owner! });
      if (member === "rejects" || member === "resolves") facts.promiseMatchers.push(line(value));
      if (member === "only" && testNames.has(rootName(value.object) ?? "")) facts.exclusiveTests.push(line(value));
    }
    if (["CallExpression", "NewExpression"].includes(value.type) && ["fetch", "WebSocket", "Worker", "EventSource", "XMLHttpRequest"].includes(name(value.callee) ?? "")) facts.effectAccess.push({ line: line(value), name: name(value.callee)! });
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (node(child)) visit(child);
    }
  }
  visit(ast);
  unfinishedWork(ast.program as unknown as Node, facts);
  return facts;
}

/**
 * Calls to the fixtures' asynchronous helpers, imported under any name, aliased or wrapped by a local function (every
 * local async function counts as one), whose result nothing waits for. Waiting means awaiting it, returning it,
 * collecting it into Promise.all (the array from a `.map` included), handing it to rejectionOf, expectRejection or a
 * local function whose parameter is declared a Promise, or keeping it in a variable whose first use is one of those.
 * Asynchronous callbacks given to APIs that call them without waiting (assertions, array tests, engine announcements,
 * locked stand-in updates) are reported too. This follows names, not types: work returned through properties and
 * methods, or callbacks handed to other APIs, is not followed, so controlled regressions and review still matter.
 */
function unfinishedWork(program: Node, facts: SourceFacts): void {
  const tracked = new Set<string>(), namespaces = new Set<string>();
  const collectors = new Set<string>();
  // Callees that wait for the promise they are given, by argument position.
  const awaiting = new Map<string, number[]>();
  for (const statement of program.body as Node[]) {
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type" && /^(?:\.\.\/)+src\/parallel\.[jt]s$/.test(text(statement.source) ?? "")) {
      for (const specifier of statement.specifiers as Node[]) if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type" && name(specifier.imported) === "completeAll") collectors.add(name(specifier.local)!);
    }
    if (statement.type === "ImportDeclaration" && REJECTIONS.test(text(statement.source) ?? "")) {
      for (const specifier of statement.specifiers as Node[]) if (specifier.type === "ImportSpecifier" && ["rejectionOf", "expectRejection"].includes(name(specifier.imported) ?? "")) awaiting.set(name(specifier.local)!, [0]);
    }
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type" || !FIXTURE_MODULE.test(text(statement.source) ?? "")) continue;
    for (const specifier of statement.specifiers as Node[]) {
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(name(specifier.local)!);
      else if (specifier.type === "ImportSpecifier" && specifier.importKind !== "type" && ASYNC_HELPERS.has(name(specifier.imported) ?? text(specifier.imported) ?? "")) tracked.add(name(specifier.local)!);
    }
  }
  const shutdownOnly = !tracked.size && !namespaces.size;
  type Call = { call: Node; parents: Node[] };
  const calls: Call[] = [], declared = new Map<Node, string>(), asyncNames = new Set<string>(), aliases: [string, string][] = [];
  // Names are followed only when the file binds them once: a value sharing a function's name stays out of it.
  const bindings = new Map<string, number>();
  const bind = (pattern: unknown): void => {
    if (!node(pattern)) return;
    if (pattern.type === "Identifier") bindings.set(pattern.name as string, (bindings.get(pattern.name as string) ?? 0) + 1);
    else if (pattern.type === "ObjectPattern") for (const entry of pattern.properties as Node[]) bind(entry.type === "RestElement" ? entry.argument : entry.value);
    else if (pattern.type === "ArrayPattern") for (const entry of pattern.elements as unknown[]) bind(entry);
    else if (pattern.type === "RestElement") bind(pattern.argument);
    else if (pattern.type === "AssignmentPattern") bind(pattern.left);
    else if (pattern.type === "TSParameterProperty") bind(pattern.parameter);
  };
  const once = (called: string) => (bindings.get(called) ?? 0) <= 1;
  const lineOf = (value: Node) => (value.loc as { start: { line: number } }).start.line;
  const walk = (value: Node, parents: Node[]) => {
    if (CALLS.has(value.type)) calls.push({ call: value, parents: [...parents] });
    if (value.type === "VariableDeclarator") bind(value.id);
    if (value.type === "FunctionDeclaration" || value.type === "ClassDeclaration") bind(value.id);
    if (FUNCTIONS.has(value.type)) for (const param of value.params as Node[]) bind(param);
    if (value.type === "CatchClause") bind(value.param);
    const fn = value.type === "FunctionDeclaration" && name(value.id) ? { body: value, called: name(value.id)! }
      : value.type === "VariableDeclarator" && name(value.id) && node(value.init) && FUNCTIONS.has(value.init.type) ? { body: value.init, called: name(value.id)! } : undefined;
    if (fn) {
      declared.set(fn.body, fn.called);
      if (fn.body.async) asyncNames.add(fn.called);
      const promised = (fn.body.params as Node[]).flatMap((param, index) => {
        const type = node(param.typeAnnotation) ? param.typeAnnotation.typeAnnotation as Node : undefined;
        return type?.type === "TSTypeReference" && ["Promise", "PromiseLike"].includes(name(type.typeName) ?? "") ? [index] : [];
      });
      if (promised.length) awaiting.set(fn.called, promised);
    }
    if (value.type === "VariableDeclarator" && name(value.id) && name(value.init)) aliases.push([name(value.id)!, name(value.init)!]);
    parents.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (key === "loc") continue;
      if (Array.isArray(child)) for (const entry of child) { if (node(entry)) walk(entry, parents); }
      else if (node(child)) walk(child, parents);
    }
    parents.pop();
  };
  walk(program, []);
  for (const called of asyncNames) if (!shutdownOnly && once(called)) tracked.add(called);
  const method = (callee: Node) => callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression" ? name(callee.property) ?? text(callee.property) : undefined;
  /** Whether a call uses a callback's answer at once, never waiting for a promise from it. */
  const calledAtOnce = (callee: Node) => name(callee) === "expect" || SYNC_CALLERS.has(name(callee) ?? method(callee) ?? "") || SYNC_CALLBACKS.has(method(callee) ?? "");
  for (const { call } of calls) if (!shutdownOnly && calledAtOnce(call.callee as Node)) {
    for (const argument of call.arguments as Node[]) if ((FUNCTIONS.has(argument.type) && argument.async) || (asyncNames.has(name(argument) ?? "") && once(name(argument)!))) facts.asyncCallbacks.push(lineOf(argument));
  }
  const target = ({ call }: Call): string | undefined => {
    const callee = call.callee as Node;
    if (method(callee) === "shutdown") return "shutdown";
    if (name(callee) && tracked.has(name(callee)!)) return name(callee);
    if ((callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") && namespaces.has(name(callee.object) ?? "") && ASYNC_HELPERS.has(name(callee.property) ?? "")) return name(callee.property);
    return undefined;
  };
  const owner = (parents: readonly Node[]) => [...parents].reverse().find((entry) => FUNCTIONS.has(entry.type));
  // Aliases and local wrappers are tracked too, until nothing new is found.
  for (let grown = true; grown;) {
    grown = false;
    for (const [alias, original] of aliases) if (tracked.has(original) && !tracked.has(alias) && once(alias)) { tracked.add(alias); grown = true; }
    for (const entry of calls) {
      // A synchronous function wraps the work only when it hands the work back; async ones are tracked already.
      const wrapper = target(entry) && returnedBy(entry.call, entry.parents);
      const wrapped = wrapper && declared.get(wrapper);
      if (wrapped && !tracked.has(wrapped) && once(wrapped)) { tracked.add(wrapped); grown = true; }
    }
  }
  const combinator = (value: Node | undefined) => {
    if (value?.type !== "CallExpression" || !node(value.callee)) return false;
    const called = name(value.callee);
    if (called && collectors.has(called) && !bindings.has(called)) return true;
    return value.callee.type === "MemberExpression" && name(value.callee.object) === "Promise" && COMBINATORS.has(name(value.callee.property) ?? "");
  };
  /** Climb past what continues the same work: type assertions, branches of a condition, then/catch/finally chains. */
  function climb(work: Node, parents: readonly Node[]): { work: Node; index: number; handled: boolean } {
    let index = parents.length - 1, handled = false;
    while (index >= 0) {
      const parent = parents[index]!;
      if (WRAPPERS.has(parent.type) || (parent.type === "ConditionalExpression" && parent.test !== work) || parent.type === "LogicalExpression") { work = parent; index -= 1; continue; }
      if ((parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") && parent.object === work && ["then", "catch", "finally"].includes(name(parent.property) ?? "") && parents[index - 1]?.type === "CallExpression") {
        handled = name(parent.property) === "catch" || (name(parent.property) === "then" && (parents[index - 1]!.arguments as Node[]).length > 1);
        work = parents[index - 1]!; index -= 2; continue;
      }
      break;
    }
    return { work, index, handled };
  }
  /** The function that hands this work back to its caller, by returning it or as an arrow's body. */
  function returnedBy(call: Node, parents: readonly Node[]): Node | undefined {
    const { work, index } = climb(call, parents);
    const parent = parents[index];
    if (parent?.type === "ArrowFunctionExpression" && parent.body === work) return parent;
    if (parent?.type !== "ReturnStatement") return undefined;
    for (let at = index - 1; at >= 0; at--) if (FUNCTIONS.has(parents[at]!.type)) return parents[at];
    return undefined;
  }
  /** Work handed back by a function: the caller it was given to decides. Callers that use the answer at once leave it unfinished. */
  const handedBack = (fn: Node, parents: readonly Node[]): boolean => {
    const caller = parents.at(-1);
    if (caller?.type !== "CallExpression" || !(caller.arguments as Node[]).includes(fn)) return true;
    const callee = caller.callee as Node;
    if (method(callee) === "map" || method(callee) === "flatMap") return waited(caller, parents.slice(0, -1), true);
    return !calledAtOnce(callee);
  };
  /**
   * A variable holding unfinished work is kept when, in the same function, a use waits for it before anything
   * uses its value (an assertion, a comparison, a property or text). Handlers attached with then/catch/finally
   * and comparisons with nothing are neither. Uses inside nested functions run later. For an array of work from
   * a `.map`, collecting it waits, or waiting for the pieces taken from it by index.
   */
  const kept = (variable: string, binding: Node, scope: Node, array = false): boolean => {
    const uses: { value: Node; parents: Node[] }[] = [];
    const look = (value: Node, parents: Node[]) => {
      if (value !== scope && FUNCTIONS.has(value.type)) return;
      if (name(value) === variable && value !== binding && (value.start as number) > (binding.start as number)) uses.push({ value, parents: [...parents] });
      parents.push(value);
      for (const [key, child] of Object.entries(value)) {
        if (key === "loc") continue;
        if (Array.isArray(child)) for (const entry of child) { if (node(entry)) look(entry, parents); }
        else if (node(child)) look(child, parents);
      }
      parents.pop();
    };
    look(scope, []);
    for (const use of uses.sort((a, b) => (a.value.start as number) - (b.value.start as number))) {
      if (waited(use.value, use.parents, array, false)) return true;
      const parent = use.parents.at(-1);
      const member = (parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") && parent.object === use.value;
      // One piece of an array of work, taken by index, is waited for on its own.
      if (array && member && parent.computed) { if (waited(parent, use.parents.slice(0, -1), false, false)) return true; continue; }
      if (member && ["then", "catch", "finally"].includes(name(parent.property) ?? "")) continue;
      if (parent?.type === "BinaryExpression" && [parent.left, parent.right].some((side) => name(side) === "undefined" || (node(side) && side.type === "NullLiteral"))) continue;
      if ((parent?.type === "CallExpression" && name(parent.callee) === "expect") || parent?.type === "TemplateLiteral" || parent?.type === "BinaryExpression" || member) return false;
    }
    return false;
  };
  /** Whether the work at `parents.length` (a call, a `.map` of calls, or a variable holding one) is waited for. */
  function waited(start: Node, parents: readonly Node[], array = false, keep = true): boolean {
    const { work, index, handled } = climb(start, parents);
    const parent = parents[index];
    const scope = () => owner(parents.slice(0, index)) ?? program;
    let collected = work, at = index;
    while (parents[at]?.type === "ArrayExpression" || parents[at]?.type === "SpreadElement") collected = parents[at--]!;
    // Collected into Promise.all and friends, which itself has to be waited for.
    if (combinator(parents[at]) && (parents[at]!.arguments as Node[]).includes(collected)) return waited(parents[at]!, parents.slice(0, at), false, keep);
    if (array) return keep && parent?.type === "VariableDeclarator" && parent.init === work && !!name(parent.id) && kept(name(parent.id)!, parent.id as Node, scope(), true);
    if (parent?.type === "AwaitExpression") return true;
    if (parent?.type === "ReturnStatement") {
      for (let fn = index - 1; fn >= 0; fn--) if (FUNCTIONS.has(parents[fn]!.type)) return handedBack(parents[fn]!, parents.slice(0, fn));
      return true;
    }
    // An explicit fire-and-forget that handles its own failure.
    if (parent?.type === "UnaryExpression" && parent.operator === "void" && handled) return true;
    if (parent?.type === "CallExpression" && awaiting.get(name(parent.callee) ?? "")?.includes((parent.arguments as Node[]).indexOf(work))) return true;
    if (keep && parent?.type === "VariableDeclarator" && parent.init === work && name(parent.id)) return kept(name(parent.id)!, parent.id as Node, scope());
    if (parent?.type === "AssignmentExpression" && parent.right === work) {
      if (waited(parent, parents.slice(0, index), false, keep)) return true;
      return keep && !!name(parent.left) && kept(name(parent.left)!, parent, scope());
    }
    if (parent?.type === "ArrowFunctionExpression" && parent.body === work) return handedBack(parent, parents.slice(0, index));
    return false;
  }
  // Asynchronous callbacks mapped over an array leave an array of work, which has to be collected.
  for (const { call, parents } of calls) {
    const mapped = method(call.callee as Node);
    if (!shutdownOnly && (mapped === "map" || mapped === "flatMap") && (call.arguments as Node[]).some((argument) => FUNCTIONS.has(argument.type) && argument.async) && !waited(call, parents, true)) facts.unfinished.push({ line: lineOf(call), name: mapped });
  }
  for (const entry of calls) {
    const called = target(entry);
    if (called && !waited(entry.call, entry.parents)) facts.unfinished.push({ line: lineOf(entry.call), name: called });
  }
}
