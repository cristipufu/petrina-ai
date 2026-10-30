import { parse } from "@babel/parser";
import { childPrograms, type ChildProgram } from "./child-programs.js";
import { engineConstructions, type EngineConstruction } from "./engine-construction.js";
import { CALLS, FUNCTIONS, lineOf, name, node, text, WRAPPERS, type Node } from "./source-ast.js";
import { moduleMocks } from "./source-mocks.js";
import { unfinishedWork } from "./source-unfinished.js";

export interface SourceFacts {
  imports: { path: string; names: string[]; runtime: boolean; unmocked?: true }[];
  /** Literal synchronous full replacements, applied only by the presentation dependency guard. */
  fullModuleMocks: { path: string; line: number }[];
  invalidModuleMocks: { line: number; reason: string }[];
  uncertain: boolean;
  promiseMatchers: number[];
  exclusiveTests: number[];
  /** Same-file concurrency cannot share mutations of the worker's inherited environment. */
  concurrentTests: number[];
  environmentMutations: number[];
  /** Synchronous child process calls: each holds the whole test worker until the child's exit is reported. */
  blockingCalls: number[];
  /** The fixtures' asynchronous commands and repository helpers, or local wrappers of them, that nothing waits for. */
  unfinished: { line: number; name: string }[];
  /** Asynchronous callbacks given to APIs that call them without waiting: assertions, array tests, engine announcements, locked stand-in updates. */
  asyncCallbacks: number[];
  /** Direct resource access, including Bun's global APIs, for lower-layer dependency checks. */
  effectAccess: { line: number; name: string }[];
  /** Statically resolved executable/script positions at native child launch APIs. */
  childPrograms: ChildProgram[];
  /** Actual Engine constructor provenance, including lexical aliases; never cleanup authority. */
  engineConstructions: EngineConstruction[];
  /** Explicit TypeScript `any` type keywords (`TSAnyKeyword`). */
  anyTypes: number[];
}

const BLOCKING = new Set(["spawnSync", "execFileSync", "execSync"]);
const FACTS_CACHE_LIMIT = 4_000;
const factsCache = new Map<string, { source: string; facts: SourceFacts }>();

/** Parse syntax rather than searching prose, comments or template strings for code. Never executes a module. */
export function sourceFacts(source: string, filename: string): SourceFacts {
  const cached = factsCache.get(filename);
  if (cached && cached.source === source) return cached.facts;
  const facts: SourceFacts = {
    imports: [],
    fullModuleMocks: [],
    invalidModuleMocks: [],
    uncertain: false,
    promiseMatchers: [],
    exclusiveTests: [],
    concurrentTests: [],
    environmentMutations: [],
    blockingCalls: [],
    unfinished: [],
    asyncCallbacks: [],
    effectAccess: [],
    childPrograms: [],
    engineConstructions: [],
    anyTypes: [],
  };
  const ast = parse(source, {
    sourceType: "unambiguous",
    sourceFilename: filename,
    plugins: filename.endsWith("x") ? ["typescript", "jsx"] : ["typescript"],
    attachComment: false,
  });
  facts.childPrograms = childPrograms(ast.program as unknown as Node, filename);
  if (filename.startsWith("packages/engine/test/")) {
    facts.engineConstructions = engineConstructions(ast.program, filename);
  }
  const mocks = moduleMocks(ast.program as unknown as Node);
  facts.fullModuleMocks = mocks.full;
  facts.invalidModuleMocks = mocks.invalid;
  const testNames = new Set(["it", "test", "describe"]);
  for (const statement of ast.program.body) {
    if (statement.type === "ImportDeclaration" && ["bun:test", "vitest"].includes(statement.source.value)) {
      for (const specifier of statement.specifiers) {
        const importedName =
          specifier.type === "ImportSpecifier"
            ? specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : specifier.imported.value
            : "";
        if (
          specifier.type === "ImportNamespaceSpecifier" ||
          (specifier.type === "ImportSpecifier" && testNames.has(importedName))
        ) {
          testNames.add(specifier.local.name);
        }
      }
    }
  }
  const rootName = (value: unknown): string | undefined => {
    if (!node(value)) return undefined;
    return (
      name(value) ??
      (value.type === "MemberExpression"
        ? rootName(value.object)
        : value.type === "CallExpression"
          ? rootName(value.callee)
          : undefined)
    );
  };
  const property = (value: Node) => (value.computed ? text(value.property) : name(value.property));
  const accessPath = (value: unknown): (string | undefined)[] => {
    if (!node(value)) return [];
    if (WRAPPERS.has(value.type)) return accessPath(value.expression);
    if (value.type === "Identifier") return [name(value)];
    if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
      return [...accessPath(value.object), property(value)];
    }
    return [];
  };
  const globalPath = (value: unknown) => {
    const parts = accessPath(value);
    return parts[0] === "globalThis" ? parts.slice(1) : parts;
  };
  const environment = environmentConcurrency(ast.program as unknown as Node);
  facts.concurrentTests = environment.concurrent;
  facts.environmentMutations = environment.mutations;

  function visit(value: unknown, factory = false): void {
    if (!node(value)) return;
    factory ||= mocks.factories.has(value);
    if (value.type === "ImportDeclaration" && /^(?:(?:node:)?child_process|bun)$/.test(text(value.source) ?? "")) {
      for (const specifier of value.specifiers as Node[]) {
        if (
          specifier.type === "ImportSpecifier" &&
          BLOCKING.has(name(specifier.imported) ?? text(specifier.imported) ?? "")
        ) {
          facts.blockingCalls.push(lineOf(specifier));
        }
      }
    }
    if (
      (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") &&
      BLOCKING.has(property(value) ?? "")
    ) {
      facts.blockingCalls.push(lineOf(value));
    }
    if (value.type === "ObjectPattern") {
      for (const entry of value.properties as Node[]) {
        if (entry.type === "ObjectProperty" && BLOCKING.has(name(entry.key) ?? text(entry.key) ?? "")) {
          facts.blockingCalls.push(lineOf(entry));
        }
      }
    }
    if (value.type === "VariableDeclarator") {
      const init = globalPath(value.init);
      if ((init.length === 1 && ["Bun", "process"].includes(init[0] ?? "")) || name(value.init) === "globalThis") {
        facts.effectAccess.push({ line: lineOf(value), name: `${init[0] ?? "globalThis"} alias` });
      }
    }
    if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration"].includes(value.type)) {
      const path = text(value.source);
      const specifiers = Array.isArray(value.specifiers)
        ? value.specifiers.filter(
            (specifier) => node(specifier) && specifier.importKind !== "type" && specifier.exportKind !== "type",
          )
        : [];
      const names =
        value.type === "ExportAllDeclaration"
          ? ["*"]
          : specifiers.flatMap((specifier) =>
              node(specifier)
                ? [
                    name(specifier.imported) ??
                      (specifier.type === "ExportSpecifier" ? name(specifier.local) : undefined) ??
                      (specifier.type === "ImportNamespaceSpecifier" ? "*" : "default"),
                  ]
                : [],
            );
      if (path) {
        const runtime =
          value.importKind !== "type" &&
          value.exportKind !== "type" &&
          (!Array.isArray(value.specifiers) || !value.specifiers.length || !!specifiers.length);
        facts.imports.push({
          path,
          names,
          runtime,
          ...(mocks.dependencies.has(value) ? { unmocked: true as const } : {}),
        });
      }
    }
    if (value.type === "TSAnyKeyword") {
      facts.anyTypes.push(lineOf(value));
    }
    if (value.type === "TSImportType") {
      const path = text(value.source);
      if (path) facts.imports.push({ path, names: ["*"], runtime: false });
    }
    if (
      value.type === "ImportExpression" ||
      (value.type === "CallExpression" &&
        (name(value.callee) === "require" || (node(value.callee) && value.callee.type === "Import")))
    ) {
      const path = text(value.type === "ImportExpression" ? value.source : (value.arguments as unknown[])?.[0]);
      if (path) {
        facts.imports.push({
          path,
          names: ["*"],
          runtime: true,
          ...(factory || name(value.callee) === "require" ? { unmocked: true as const } : {}),
        });
      } else {
        facts.uncertain = true;
      }
    }
    if (
      value.type === "CallExpression" &&
      node(value.callee) &&
      value.callee.type === "MemberExpression" &&
      mocks.actual(value.callee)
    ) {
      const path = text((value.arguments as unknown[])[0]);
      if (path) facts.imports.push({ path, names: ["*"], runtime: true, unmocked: true });
      else facts.uncertain = true;
    }
    if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
      const member = property(value);
      const [owner, operation] = globalPath(value);
      const bunEffect =
        owner === "Bun" &&
        (operation === undefined ||
          ["spawn", "spawnSync", "file", "write", "serve", "listen", "connect", "which"].includes(operation));
      const processEffect =
        owner === "process" &&
        (operation === undefined || ["env", "cwd", "chdir", "kill", "exit", "abort"].includes(operation));
      const webEffect = ["fetch", "WebSocket", "Worker", "EventSource", "XMLHttpRequest"].includes(owner ?? "");
      if (bunEffect || processEffect || webEffect) {
        facts.effectAccess.push({ line: lineOf(value), name: operation ? `${owner}.${operation}` : owner! });
      }
      if (member === "rejects" || member === "resolves") facts.promiseMatchers.push(lineOf(value));
      if (member === "only" && testNames.has(rootName(value.object) ?? "")) facts.exclusiveTests.push(lineOf(value));
    }
    if (
      ["CallExpression", "NewExpression"].includes(value.type) &&
      ["fetch", "WebSocket", "Worker", "EventSource", "XMLHttpRequest"].includes(name(value.callee) ?? "")
    ) {
      facts.effectAccess.push({ line: lineOf(value), name: name(value.callee)! });
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach((entry) => visit(entry, factory));
      else if (node(child)) visit(child, factory);
    }
  }
  visit(ast);
  unfinishedWork(ast.program as unknown as Node, facts, filename);
  if (factsCache.size >= FACTS_CACHE_LIMIT) {
    const oldest = factsCache.keys().next().value;
    if (oldest !== undefined) factsCache.delete(oldest);
  }
  factsCache.set(filename, { source, facts });
  return facts;
}

/** Direct syntax and lexical bindings only: arbitrary environment/test-function aliases are not evaluated. */
function environmentConcurrency(program: Node): { concurrent: number[]; mutations: number[] } {
  type Binding = "test" | "namespace" | "process" | "other";
  interface Scope {
    parent?: Scope;
    bindings: Map<string, Binding>;
    function?: true;
  }
  const scopes = new Map<Node, Scope>();
  const root: Scope = { bindings: new Map(), function: true };
  const lookup = (scope: Scope, id: string): Binding | undefined =>
    scope.bindings.get(id) ?? (scope.parent ? lookup(scope.parent, id) : undefined);
  const unwrap = (value: unknown): unknown =>
    node(value) && WRAPPERS.has(value.type) ? unwrap(value.expression) : value;
  const property = (value: Node) => (value.computed ? text(unwrap(value.property)) : name(value.property));
  const members = new Set(["MemberExpression", "OptionalMemberExpression"]);
  const tests = new Set(["it", "test", "describe"]);
  const builders = new Set(["each", "for", "skipIf", "runIf", "extend"]);
  const modifiers = new Set(["only", "skip", "todo", "failing", "fails", "concurrent", "sequential", ...builders]);
  const children = (value: Node, visit: (child: Node) => void) => {
    for (const [key, child] of Object.entries(value)) {
      if (["start", "end", "loc"].includes(key)) continue;
      if (Array.isArray(child)) {
        for (const entry of child) if (node(entry)) visit(entry);
      } else if (node(child)) {
        visit(child);
      }
    }
  };
  const bind = (scope: Scope, pattern: unknown, binding: Binding = "other"): void => {
    if (!node(pattern)) return;
    if (pattern.type === "Identifier") scope.bindings.set(name(pattern)!, binding);
    else if (pattern.type === "ObjectPattern") {
      for (const entry of pattern.properties as Node[]) {
        bind(scope, entry.type === "RestElement" ? entry.argument : entry.value);
      }
    } else if (pattern.type === "ArrayPattern") {
      for (const entry of pattern.elements as unknown[]) bind(scope, entry);
    } else if (pattern.type === "AssignmentPattern") bind(scope, pattern.left);
    else if (pattern.type === "RestElement") bind(scope, pattern.argument);
    else if (pattern.type === "TSParameterProperty") bind(scope, pattern.parameter);
  };
  const blockScopes = new Set([
    "BlockStatement",
    "ClassDeclaration",
    "ClassExpression",
    "StaticBlock",
    "TSModuleBlock",
    "CatchClause",
    "ForStatement",
    "ForOfStatement",
    "ForInStatement",
    "SwitchStatement",
  ]);
  const scan = (value: Node, outer: Scope, parent?: Node): void => {
    if (
      [
        "FunctionDeclaration",
        "ClassDeclaration",
        "TSEnumDeclaration",
        "TSModuleDeclaration",
        "TSImportEqualsDeclaration",
      ].includes(value.type)
    ) {
      bind(outer, value.id);
    }
    const isFunctionLike = FUNCTIONS.has(value.type) || ["StaticBlock", "TSModuleBlock"].includes(value.type);
    const scope: Scope =
      FUNCTIONS.has(value.type) || blockScopes.has(value.type)
        ? { parent: outer, bindings: new Map(), ...(isFunctionLike ? { function: true as const } : {}) }
        : outer;
    scopes.set(value, scope);
    if (FUNCTIONS.has(value.type)) for (const param of value.params as unknown[]) bind(scope, param);
    if (value.type === "FunctionExpression" || value.type === "ClassExpression") bind(scope, value.id);
    if (value.type === "CatchClause") bind(scope, value.param);
    if (value.type === "VariableDeclarator") {
      let owner = scope;
      if (parent?.kind === "var") while (!owner.function && owner.parent) owner = owner.parent;
      bind(owner, value.id);
    }
    if (value.type === "ImportDeclaration") {
      for (const entry of value.specifiers as Node[]) {
        const runtime = value.importKind !== "type" && entry.importKind !== "type";
        const source = text(value.source);
        const imported = name(entry.imported) ?? text(entry.imported);
        const kind: Binding =
          runtime && ["bun:test", "vitest"].includes(source ?? "")
            ? entry.type === "ImportNamespaceSpecifier"
              ? "namespace"
              : tests.has(imported ?? "")
                ? "test"
                : "other"
            : runtime &&
                ["node:process", "process"].includes(source ?? "") &&
                ["ImportDefaultSpecifier", "ImportNamespaceSpecifier"].includes(entry.type)
              ? "process"
              : "other";
        bind(scope, entry.local, kind);
      }
    }
    children(value, (child) => scan(child, scope, value));
  };
  scan(program, root);
  const path = (input: unknown): (string | undefined)[] => {
    const value = unwrap(input);
    if (!node(value)) return [];
    const id = name(value);
    if (id) {
      const binding = lookup(scopes.get(value)!, id);
      if (binding === "process") return ["process"];
      return !binding && ["process", "Object", "Reflect", "globalThis"].includes(id) ? [id] : [];
    }
    if (!members.has(value.type)) return [];
    const owner = path(value.object);
    return owner.length ? [...owner, property(value)] : [];
  };
  const globalPath = (value: unknown) => {
    const parts = path(value);
    return parts[0] === "globalThis" ? parts.slice(1) : parts;
  };
  const environment = (value: unknown) => {
    const parts = globalPath(value);
    return parts[0] === "process" && parts[1] === "env";
  };
  type TestApi = { namespace?: true; concurrent?: boolean };
  const api = (input: unknown): TestApi | undefined => {
    const value = unwrap(input);
    if (!node(value)) return undefined;
    const id = name(value);
    if (id) {
      const binding = lookup(scopes.get(value)!, id);
      return binding === "namespace"
        ? { namespace: true }
        : binding === "test" || (!binding && tests.has(id))
          ? {}
          : undefined;
    }
    if (members.has(value.type)) {
      const owner = api(value.object);
      const member = property(value);
      return owner?.namespace
        ? tests.has(member ?? "")
          ? {}
          : undefined
        : owner && modifiers.has(member ?? "")
          ? { concurrent: owner.concurrent || member === "concurrent" }
          : undefined;
    }
    // These calls return another test declaration function; a registered test's return is not an API.
    if (CALLS.has(value.type)) {
      const callee = unwrap(value.callee);
      return node(callee) && members.has(callee.type) && builders.has(property(callee) ?? "")
        ? api(callee)
        : undefined;
    }
    return undefined;
  };
  const concurrent: number[] = [];
  const mutations: number[] = [];
  const visit = (value: Node): void => {
    const isDeleteOrUpdate =
      ["UpdateExpression", "UnaryExpression"].includes(value.type) &&
      (value.type === "UpdateExpression" || value.operator === "delete") &&
      environment(value.argument);
    if ((value.type === "AssignmentExpression" && environment(value.left)) || isDeleteOrUpdate) {
      mutations.push(lineOf(value));
    }
    if (CALLS.has(value.type)) {
      const callee = unwrap(value.callee);
      if (api(callee)?.concurrent && !(node(callee) && members.has(callee.type) && builders.has(property(callee) ?? ""))) {
        concurrent.push(lineOf(value));
      }
      const [owner, method] = globalPath(callee);
      const mutatesObject =
        (owner === "Object" && ["assign", "defineProperty", "defineProperties"].includes(method ?? "")) ||
        (owner === "Reflect" && ["set", "deleteProperty", "defineProperty"].includes(method ?? ""));
      if (mutatesObject && environment((value.arguments as unknown[])[0])) {
        mutations.push(lineOf(value));
      }
    }
    children(value, visit);
  };
  visit(program);
  return { concurrent, mutations };
}
