import { parse } from "@babel/parser";
import { childPrograms, type ChildProgram } from "./child-programs.js";
import { engineConstructions, type EngineConstruction } from "./engine-construction.js";

type Node = { type: string; [key: string]: unknown };
const node = (value: unknown): value is Node =>
  !!value && typeof value === "object" && typeof (value as Node).type === "string";
const text = (value: unknown): string | undefined =>
  node(value) && value.type === "StringLiteral" ? (value.value as string) : undefined;
const name = (value: unknown): string | undefined =>
  node(value) && value.type === "Identifier" ? (value.name as string) : undefined;

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
/** What the fixtures export as asynchronous work: their callers must wait for it. */
const ASYNC_HELPERS = new Set([
  "git",
  "gitWith",
  "runGit",
  "runCommand",
  "runProcess",
  "commitAt",
  "makeProduct",
  "makeWorld",
  "repositorySeed",
  "remoteRef",
  "waitFor",
  "waitForFile",
]);
const FIXTURE_MODULE =
  /^(?:\.\.?\/(?:.*\/)?(?:fixtures|support|commands|repositories|run-process)(?:\.[jt]s)?|@petrina\/test-support(?:\/(?:fixtures|commands|repositories|run-process))?)$/;
const REJECTIONS = /^(?:\.\.?\/(?:.*\/)?rejections(?:\.[jt]s)?|@petrina\/test-support\/rejections)$/;
const COMMAND_FAILURE = /^\.\.?\/(?:.*\/)?fixtures\/command-failure(?:\.[jt]s)?$/;
const COMBINATORS = new Set(["all", "allSettled", "race", "any"]);
/** Array methods that use a callback's answer at once: a promise there is never waited for. */
const SYNC_CALLBACKS = new Set([
  "forEach",
  "filter",
  "some",
  "every",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "sort",
]);
const SYNC_CALLERS = new Set(["subscribe", "setGitHub", "updateGitHub", "editSaved", "setScript"]);
const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);
const WRAPPERS = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "ParenthesizedExpression",
]);
const CALLS = new Set(["CallExpression", "OptionalCallExpression"]);

/** Parse syntax rather than searching prose, comments or template strings for code. Never executes a module. */
export function sourceFacts(source: string, filename: string): SourceFacts {
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
  const line = (value: Node) => (value.loc as { start: { line: number } }).start.line;
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
          facts.blockingCalls.push(line(specifier));
        }
      }
    }
    if (
      (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") &&
      BLOCKING.has(property(value) ?? "")
    ) {
      facts.blockingCalls.push(line(value));
    }
    if (value.type === "ObjectPattern") {
      for (const entry of value.properties as Node[]) {
        if (entry.type === "ObjectProperty" && BLOCKING.has(name(entry.key) ?? text(entry.key) ?? "")) {
          facts.blockingCalls.push(line(entry));
        }
      }
    }
    if (value.type === "VariableDeclarator") {
      const init = globalPath(value.init);
      if ((init.length === 1 && ["Bun", "process"].includes(init[0] ?? "")) || name(value.init) === "globalThis") {
        facts.effectAccess.push({ line: line(value), name: `${init[0] ?? "globalThis"} alias` });
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
      facts.anyTypes.push(line(value));
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
        facts.effectAccess.push({ line: line(value), name: operation ? `${owner}.${operation}` : owner! });
      }
      if (member === "rejects" || member === "resolves") facts.promiseMatchers.push(line(value));
      if (member === "only" && testNames.has(rootName(value.object) ?? "")) facts.exclusiveTests.push(line(value));
    }
    if (
      ["CallExpression", "NewExpression"].includes(value.type) &&
      ["fetch", "WebSocket", "Worker", "EventSource", "XMLHttpRequest"].includes(name(value.callee) ?? "")
    ) {
      facts.effectAccess.push({ line: line(value), name: name(value.callee)! });
    }
    for (const child of Object.values(value)) {
      if (Array.isArray(child)) child.forEach((entry) => visit(entry, factory));
      else if (node(child)) visit(child, factory);
    }
  }
  visit(ast);
  unfinishedWork(ast.program as unknown as Node, facts);
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
    if (!node(value)) return;
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
  };
  const concurrent: number[] = [];
  const mutations: number[] = [];
  const line = (value: Node) => (value.loc as { start: { line: number } }).start.line;
  const visit = (value: Node): void => {
    const isDeleteOrUpdate =
      ["UpdateExpression", "UnaryExpression"].includes(value.type) &&
      (value.type === "UpdateExpression" || value.operator === "delete") &&
      environment(value.argument);
    if ((value.type === "AssignmentExpression" && environment(value.left)) || isDeleteOrUpdate) {
      mutations.push(line(value));
    }
    if (CALLS.has(value.type)) {
      const callee = unwrap(value.callee);
      if (api(callee)?.concurrent && !(node(callee) && members.has(callee.type) && builders.has(property(callee) ?? ""))) {
        concurrent.push(line(value));
      }
      const [owner, method] = globalPath(callee);
      const mutatesObject =
        (owner === "Object" && ["assign", "defineProperty", "defineProperties"].includes(method ?? "")) ||
        (owner === "Reflect" && ["set", "deleteProperty", "defineProperty"].includes(method ?? ""));
      if (mutatesObject && environment((value.arguments as unknown[])[0])) {
        mutations.push(line(value));
      }
    }
    children(value, visit);
  };
  visit(program);
  return { concurrent, mutations };
}

/** Only a real, top-level Vitest call with a complete explicit factory can replace an edge. */
function moduleMocks(program: Node) {
  const bindings = new Set<string>();
  const namespaces = new Set<string>();
  const full: { path: string; line: number }[] = [];
  const invalid: { line: number; reason: string }[] = [];
  const factories = new Set<Node>();
  const line = (value: Node) => (value.loc as { start: { line: number } }).start.line;
  for (const statement of program.body as Node[]) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type" || text(statement.source) !== "vitest") {
      continue;
    }
    for (const specifier of statement.specifiers as Node[]) {
      if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(name(specifier.local)!);
      if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type" &&
        ["vi", "vitest"].includes(name(specifier.imported) ?? text(specifier.imported) ?? "")
      ) {
        bindings.add(name(specifier.local)!);
      }
    }
  }
  const member = (value: unknown): string | undefined =>
    node(value) && value.type === "MemberExpression" && !value.computed ? name(value.property) : undefined;
  const api = (value: unknown): boolean =>
    bindings.has(name(value) ?? "") ||
    (node(value) &&
      value.type === "MemberExpression" &&
      namespaces.has(name(value.object) ?? "") &&
      ["vi", "vitest"].includes(member(value) ?? ""));
  const staticMember = (value: Node) => (value.computed ? text(value.property) : name(value.property));
  const actual = (value: Node): boolean =>
    ["importActual", "importOriginal"].includes(staticMember(value) ?? "") && api(value.object);
  const walk = (value: unknown, see: (value: Node) => void): void => {
    if (!node(value)) return;
    see(value);
    for (const [key, child] of Object.entries(value)) {
      if (key === "loc") continue;
      if (Array.isArray(child)) child.forEach((entry) => walk(entry, see));
      else if (node(child)) walk(child, see);
    }
  };
  let altered = false;
  let originalAccess = false;
  walk(program, (value) => {
    if (
      value.type === "MemberExpression" &&
      api(value.object) &&
      (actual(value) || value.computed || ["unmock", "doUnmock", "doMock"].includes(member(value) ?? ""))
    ) {
      originalAccess = true;
      invalid.push({
        line: line(value),
        reason: "original-module, unmock or computed Vitest access is not a full presentation replacement",
      });
    }
    if (["AssignmentExpression", "UpdateExpression"].includes(value.type)) {
      const target = value.left ?? value.argument;
      if (node(target) && target.type === "MemberExpression" && api(target.object) && (target.computed || member(target) === "mock")) {
        altered = true;
      }
    }
  });
  for (const statement of program.body as Node[]) {
    if (statement.type !== "ExpressionStatement" || !node(statement.expression)) continue;
    const call = statement.expression;
    if (
      call.type !== "CallExpression" ||
      !node(call.callee) ||
      call.callee.type !== "MemberExpression" ||
      !api(call.callee.object)
    ) {
      continue;
    }
    if (call.callee.computed) {
      if (staticMember(call.callee) === "mock") {
        invalid.push({ line: line(call), reason: "use a direct Vitest mock call, not a computed replacement" });
      }
      continue;
    }
    if (member(call.callee) !== "mock") continue;
    // Vitest hoists only direct calls named vi.mock/vitest.mock. An alias/namespace
    // can be the real API yet still execute after the view's static imports.
    if (!["vi", "vitest"].includes(name(call.callee.object) ?? "")) {
      invalid.push({
        line: line(call),
        reason: "use a directly imported vi.mock or vitest.mock so the replacement precedes imports",
      });
      continue;
    }
    const [path, factory] = call.arguments as unknown[];
    const fail = (reason: string) => invalid.push({ line: line(call), reason });
    if (altered) {
      fail("the Vitest mock binding is changed in this file");
      continue;
    }
    if (originalAccess) {
      fail("original-module or computed Vitest access prevents a proven full replacement");
      continue;
    }
    if (text(path) === undefined) {
      fail("use a literal module path for a full presentation replacement");
      continue;
    }
    if (
      !node(factory) ||
      !["ArrowFunctionExpression", "FunctionExpression"].includes(factory.type) ||
      (call.arguments as unknown[]).length !== 2
    ) {
      fail("use an explicit full replacement factory");
      continue;
    }
    factories.add(factory);
    if (factory.async || (factory.params as unknown[]).length) {
      fail("the replacement factory must be synchronous and cannot load an original module");
      continue;
    }
    let partial = false;
    walk(factory, (value) => {
      const isOriginalCall =
        value.type === "CallExpression" &&
        (name(value.callee) === "importOriginal" ||
          (node(value.callee) && ["importActual", "importOriginal"].includes(member(value.callee) ?? "")));
      if (value.type === "ImportExpression" || isOriginalCall) partial = true;
    });
    if (partial) {
      fail("partial or original-module replacements are not presentation boundaries");
      continue;
    }
    const object = (value: unknown): boolean =>
      node(value) &&
      value.type === "ObjectExpression" &&
      (value.properties as Node[]).every(
        (property) => ["ObjectProperty", "ObjectMethod"].includes(property.type) && !property.computed,
      );
    let returnsObject = object(factory.body);
    if (node(factory.body) && factory.body.type === "BlockStatement") {
      const statements = factory.body.body as Node[];
      returnsObject = statements.at(-1)?.type === "ReturnStatement" && object(statements.at(-1)?.argument);
      // Nested exported functions may return arbitrary values; every factory return must be explicit.
      const inspect = (value: unknown): void => {
        if (!node(value) || FUNCTIONS.has(value.type)) return;
        if (value.type === "ReturnStatement" && !object(value.argument)) returnsObject = false;
        for (const [key, child] of Object.entries(value)) {
          if (key === "loc") continue;
          if (Array.isArray(child)) child.forEach(inspect);
          else if (node(child)) inspect(child);
        }
      };
      inspect(factory.body);
    }
    if (!returnsObject) {
      fail("return a complete object with explicit export names; spreads and computed replacements are unsupported");
      continue;
    }
    full.push({ path: text(path)!, line: line(call) });
  }
  // A factory can close over a local value assembled elsewhere. Follow its imported helpers
  // without applying the replacement again: a fake cannot obtain native I/O through itself.
  const keyBearingTypes = new Set([
    "ObjectProperty",
    "ObjectMethod",
    "ClassProperty",
    "ClassMethod",
    "ClassPrivateProperty",
    "ClassPrivateMethod",
  ]);
  const references = (value: Node) => {
    const names = new Set<string>();
    const inspect = (entry: Node): void => {
      if (entry.type === "Identifier") names.add(name(entry)!);
      for (const [key, child] of Object.entries(entry)) {
        // Export/member names are syntax, not captured bindings. Shorthand values
        // and computed keys still visit their actual expression references.
        const isStaticSyntaxName =
          !entry.computed &&
          ((key === "property" && ["MemberExpression", "OptionalMemberExpression"].includes(entry.type)) ||
            (key === "key" && keyBearingTypes.has(entry.type)));
        if (key === "loc" || isStaticSyntaxName) continue;
        if (Array.isArray(child)) {
          for (const item of child) if (node(item)) inspect(item);
        } else if (node(child)) {
          inspect(child);
        }
      }
    };
    inspect(value);
    return names;
  };
  const locals = new Map<string, Node[]>();
  const dependencies = new Set<Node>();
  const bind = (pattern: unknown, value: Node): void => {
    if (!node(pattern)) return;
    if (pattern.type === "Identifier") {
      locals.set(name(pattern)!, [...(locals.get(name(pattern)!) ?? []), value]);
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties as Node[]) {
        bind(property.type === "RestElement" ? property.argument : property.value, value);
      }
    } else if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements as unknown[]) bind(element, value);
    } else if (pattern.type === "RestElement") bind(pattern.argument, value);
    else if (pattern.type === "AssignmentPattern") bind(pattern.left, value);
  };
  walk(program, (value) => {
    if (value.type === "VariableDeclarator" && node(value.init)) bind(value.id, value.init);
    if (["FunctionDeclaration", "ClassDeclaration"].includes(value.type)) bind(value.id, value);
    if (value.type === "AssignmentExpression" && node(value.right)) bind(value.left, value.right);
  });
  const needed = new Set([...factories].flatMap((factory) => [...references(factory)]));
  const pending = [...needed];
  while (pending.length) {
    for (const value of locals.get(pending.pop()!) ?? []) {
      for (const dependency of references(value)) {
        if (!needed.has(dependency)) {
          needed.add(dependency);
          pending.push(dependency);
        }
      }
    }
  }
  for (const statement of program.body as Node[]) {
    if (
      statement.type === "ImportDeclaration" &&
      (statement.specifiers as Node[]).some((specifier) => needed.has(name(specifier.local)!))
    ) {
      dependencies.add(statement);
    }
  }
  return { full, invalid, factories, actual, dependencies };
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
  const tracked = new Set<string>();
  const namespaces = new Set<string>();
  const collectors = new Set<string>();
  // Callees that wait for the promise they are given, by argument position.
  const awaiting = new Map<string, number[]>();
  for (const statement of program.body as Node[]) {
    if (
      statement.type === "ImportDeclaration" &&
      statement.importKind !== "type" &&
      text(statement.source) === "@petrina/core"
    ) {
      for (const specifier of statement.specifiers as Node[]) {
        if (
          specifier.type === "ImportSpecifier" &&
          specifier.importKind !== "type" &&
          name(specifier.imported) === "completeAll"
        ) {
          collectors.add(name(specifier.local)!);
        }
      }
    }
    if (statement.type === "ImportDeclaration" && statement.importKind !== "type") {
      const path = text(statement.source) ?? "";
      const names = REJECTIONS.test(path)
        ? ["rejectionOf", "expectRejection"]
        : COMMAND_FAILURE.test(path)
          ? ["failureOf"]
          : [];
      for (const specifier of statement.specifiers as Node[]) {
        if (
          specifier.type === "ImportSpecifier" &&
          specifier.importKind !== "type" &&
          names.includes(name(specifier.imported) ?? "")
        ) {
          awaiting.set(name(specifier.local)!, [0]);
          tracked.add(name(specifier.local)!);
        }
      }
    }
    if (
      statement.type !== "ImportDeclaration" ||
      statement.importKind === "type" ||
      !FIXTURE_MODULE.test(text(statement.source) ?? "")
    ) {
      continue;
    }
    for (const specifier of statement.specifiers as Node[]) {
      if (specifier.type === "ImportNamespaceSpecifier") {
        namespaces.add(name(specifier.local)!);
      } else if (
        specifier.type === "ImportSpecifier" &&
        specifier.importKind !== "type" &&
        ASYNC_HELPERS.has(name(specifier.imported) ?? text(specifier.imported) ?? "")
      ) {
        tracked.add(name(specifier.local)!);
      }
    }
  }
  const shutdownOnly = !tracked.size && !namespaces.size;
  type Call = { call: Node; parents: Node[] };
  const calls: Call[] = [];
  const declared = new Map<Node, string>();
  const asyncNames = new Set<string>();
  const aliases: [string, string][] = [];
  // Names are followed only when the file binds them once: a value sharing a function's name stays out of it.
  const bindings = new Map<string, number>();
  const bind = (pattern: unknown): void => {
    if (!node(pattern)) return;
    if (pattern.type === "Identifier") {
      bindings.set(pattern.name as string, (bindings.get(pattern.name as string) ?? 0) + 1);
    } else if (pattern.type === "ObjectPattern") {
      for (const entry of pattern.properties as Node[]) {
        bind(entry.type === "RestElement" ? entry.argument : entry.value);
      }
    } else if (pattern.type === "ArrayPattern") {
      for (const entry of pattern.elements as unknown[]) bind(entry);
    } else if (pattern.type === "RestElement") bind(pattern.argument);
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
    const fn =
      value.type === "FunctionDeclaration" && name(value.id)
        ? { body: value, called: name(value.id)! }
        : value.type === "VariableDeclarator" && name(value.id) && node(value.init) && FUNCTIONS.has(value.init.type)
          ? { body: value.init, called: name(value.id)! }
          : undefined;
    if (fn) {
      declared.set(fn.body, fn.called);
      if (fn.body.async) asyncNames.add(fn.called);
      const promised = (fn.body.params as Node[]).flatMap((param, index) => {
        const type = node(param.typeAnnotation) ? (param.typeAnnotation.typeAnnotation as Node) : undefined;
        return type?.type === "TSTypeReference" && ["Promise", "PromiseLike"].includes(name(type.typeName) ?? "")
          ? [index]
          : [];
      });
      if (promised.length) awaiting.set(fn.called, promised);
    }
    if (value.type === "VariableDeclarator" && name(value.id) && name(value.init)) {
      aliases.push([name(value.id)!, name(value.init)!]);
    }
    parents.push(value);
    for (const [key, child] of Object.entries(value)) {
      if (key === "loc") continue;
      if (Array.isArray(child)) {
        for (const entry of child) if (node(entry)) walk(entry, parents);
      } else if (node(child)) {
        walk(child, parents);
      }
    }
    parents.pop();
  };
  walk(program, []);
  for (const called of asyncNames) if (!shutdownOnly && once(called)) tracked.add(called);
  const method = (callee: Node) =>
    callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression"
      ? name(callee.property) ?? text(callee.property)
      : undefined;
  /** Whether a call uses a callback's answer at once, never waiting for a promise from it. */
  const calledAtOnce = (callee: Node) =>
    name(callee) === "expect" ||
    SYNC_CALLERS.has(name(callee) ?? method(callee) ?? "") ||
    SYNC_CALLBACKS.has(method(callee) ?? "");
  for (const { call } of calls) {
    if (!shutdownOnly && calledAtOnce(call.callee as Node)) {
      for (const argument of call.arguments as Node[]) {
        if (
          (FUNCTIONS.has(argument.type) && argument.async) ||
          (asyncNames.has(name(argument) ?? "") && once(name(argument)!))
        ) {
          facts.asyncCallbacks.push(lineOf(argument));
        }
      }
    }
  }
  const target = ({ call }: Call): string | undefined => {
    const callee = call.callee as Node;
    if (method(callee) === "shutdown") return "shutdown";
    if (name(callee) && tracked.has(name(callee)!)) return name(callee);
    if (
      (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") &&
      namespaces.has(name(callee.object) ?? "") &&
      ASYNC_HELPERS.has(name(callee.property) ?? "")
    ) {
      return name(callee.property);
    }
    return undefined;
  };
  const owner = (parents: readonly Node[]) => [...parents].reverse().find((entry) => FUNCTIONS.has(entry.type));
  // Aliases and local wrappers are tracked too, until nothing new is found.
  for (let grown = true; grown; ) {
    grown = false;
    for (const [alias, original] of aliases) {
      if (tracked.has(original) && !tracked.has(alias) && once(alias)) {
        tracked.add(alias);
        grown = true;
      }
    }
    for (const entry of calls) {
      // A synchronous function wraps the work only when it hands the work back; async ones are tracked already.
      const wrapper = target(entry) && returnedBy(entry.call, entry.parents);
      const wrapped = wrapper && declared.get(wrapper);
      if (wrapped && !tracked.has(wrapped) && once(wrapped)) {
        tracked.add(wrapped);
        grown = true;
      }
    }
  }
  const combinator = (value: Node | undefined) => {
    if (value?.type !== "CallExpression" || !node(value.callee)) return false;
    const called = name(value.callee);
    if (called && collectors.has(called) && !bindings.has(called)) return true;
    return (
      value.callee.type === "MemberExpression" &&
      name(value.callee.object) === "Promise" &&
      COMBINATORS.has(name(value.callee.property) ?? "")
    );
  };
  /** Climb past what continues the same work: type assertions, branches of a condition, then/catch/finally chains. */
  function climb(work: Node, parents: readonly Node[]): { work: Node; index: number; handled: boolean } {
    let index = parents.length - 1;
    let handled = false;
    while (index >= 0) {
      const parent = parents[index]!;
      if (
        WRAPPERS.has(parent.type) ||
        (parent.type === "ConditionalExpression" && parent.test !== work) ||
        parent.type === "LogicalExpression"
      ) {
        work = parent;
        index -= 1;
        continue;
      }
      if (
        (parent.type === "MemberExpression" || parent.type === "OptionalMemberExpression") &&
        parent.object === work &&
        ["then", "catch", "finally"].includes(name(parent.property) ?? "") &&
        parents[index - 1]?.type === "CallExpression"
      ) {
        handled =
          name(parent.property) === "catch" ||
          (name(parent.property) === "then" && (parents[index - 1]!.arguments as Node[]).length > 1);
        work = parents[index - 1]!;
        index -= 2;
        continue;
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
      if (name(value) === variable && value !== binding && (value.start as number) > (binding.start as number)) {
        uses.push({ value, parents: [...parents] });
      }
      parents.push(value);
      for (const [key, child] of Object.entries(value)) {
        if (key === "loc") continue;
        if (Array.isArray(child)) {
          for (const entry of child) if (node(entry)) look(entry, parents);
        } else if (node(child)) {
          look(child, parents);
        }
      }
      parents.pop();
    };
    look(scope, []);
    for (const use of uses.sort((a, b) => (a.value.start as number) - (b.value.start as number))) {
      if (waited(use.value, use.parents, array, false)) return true;
      const parent = use.parents.at(-1);
      const member =
        (parent?.type === "MemberExpression" || parent?.type === "OptionalMemberExpression") &&
        parent.object === use.value;
      // One piece of an array of work, taken by index, is waited for on its own.
      if (array && member && parent.computed) {
        if (waited(parent, use.parents.slice(0, -1), false, false)) return true;
        continue;
      }
      if (member && ["then", "catch", "finally"].includes(name(parent.property) ?? "")) continue;
      if (
        parent?.type === "BinaryExpression" &&
        [parent.left, parent.right].some(
          (side) => name(side) === "undefined" || (node(side) && side.type === "NullLiteral"),
        )
      ) {
        continue;
      }
      if (
        (parent?.type === "CallExpression" && name(parent.callee) === "expect") ||
        parent?.type === "TemplateLiteral" ||
        parent?.type === "BinaryExpression" ||
        member
      ) {
        return false;
      }
    }
    return false;
  };
  /** Whether the work at `parents.length` (a call, a `.map` of calls, or a variable holding one) is waited for. */
  function waited(start: Node, parents: readonly Node[], array = false, keep = true): boolean {
    const { work, index, handled } = climb(start, parents);
    const parent = parents[index];
    const scope = () => owner(parents.slice(0, index)) ?? program;
    let collected = work;
    let at = index;
    while (parents[at]?.type === "ArrayExpression" || parents[at]?.type === "SpreadElement") {
      collected = parents[at--]!;
    }
    // Collected into Promise.all and friends, which itself has to be waited for.
    if (combinator(parents[at]) && (parents[at]!.arguments as Node[]).includes(collected)) {
      return waited(parents[at]!, parents.slice(0, at), false, keep);
    }
    if (array) {
      return (
        keep &&
        parent?.type === "VariableDeclarator" &&
        parent.init === work &&
        !!name(parent.id) &&
        kept(name(parent.id)!, parent.id as Node, scope(), true)
      );
    }
    if (parent?.type === "AwaitExpression") return true;
    if (parent?.type === "ReturnStatement") {
      for (let fn = index - 1; fn >= 0; fn--) {
        if (FUNCTIONS.has(parents[fn]!.type)) return handedBack(parents[fn]!, parents.slice(0, fn));
      }
      return true;
    }
    // An explicit fire-and-forget that handles its own failure.
    if (parent?.type === "UnaryExpression" && parent.operator === "void" && handled) return true;
    if (
      parent?.type === "CallExpression" &&
      awaiting.get(name(parent.callee) ?? "")?.includes((parent.arguments as Node[]).indexOf(work))
    ) {
      return true;
    }
    if (keep && parent?.type === "VariableDeclarator" && parent.init === work && name(parent.id)) {
      return kept(name(parent.id)!, parent.id as Node, scope());
    }
    if (parent?.type === "AssignmentExpression" && parent.right === work) {
      if (waited(parent, parents.slice(0, index), false, keep)) return true;
      return keep && !!name(parent.left) && kept(name(parent.left)!, parent, scope());
    }
    if (parent?.type === "ArrowFunctionExpression" && parent.body === work) {
      return handedBack(parent, parents.slice(0, index));
    }
    return false;
  }
  // Asynchronous callbacks mapped over an array leave an array of work, which has to be collected.
  for (const { call, parents } of calls) {
    const mapped = method(call.callee as Node);
    const hasAsyncMapper = (call.arguments as Node[]).some(
      (argument) => FUNCTIONS.has(argument.type) && argument.async,
    );
    if (!shutdownOnly && (mapped === "map" || mapped === "flatMap") && hasAsyncMapper && !waited(call, parents, true)) {
      facts.unfinished.push({ line: lineOf(call), name: mapped });
    }
  }
  for (const entry of calls) {
    const called = target(entry);
    if (called && !waited(entry.call, entry.parents)) {
      facts.unfinished.push({ line: lineOf(entry.call), name: called });
    }
  }
}
