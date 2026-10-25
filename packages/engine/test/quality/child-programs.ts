import { posix } from "node:path";
import { sourceCandidates } from "./source-paths.js";

type Node = { type: string; [key: string]: unknown };
const node = (value: unknown): value is Node => !!value && typeof value === "object" && typeof (value as Node).type === "string";
const name = (value: unknown) => node(value) && value.type === "Identifier" ? value.name as string : undefined;
const text = (value: unknown) => node(value) && value.type === "StringLiteral" ? value.value as string : undefined;
const member = (value: Node) => value.computed ? text(value.property) : name(value.property);
const functions = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression", "ObjectMethod", "ClassMethod", "ClassPrivateMethod"]);
const wrappers = new Set(["TSAsExpression", "TSNonNullExpression", "TSSatisfiesExpression", "ParenthesizedExpression", "AwaitExpression"]);
const unwrap = (value: unknown): unknown => node(value) && wrappers.has(value.type) ? unwrap(value.expression ?? value.argument) : value;
// A symbolic checkout ancestor distinguishes an in-repository path from traversal above its root.
const repository = "/__petrina_source__/";
type Value = { kind: "text" | "path" | "url" | "module" | "api" | "call"; value: string }
  | { kind: "unknown" } | { kind: "array"; entries: (Value | undefined)[] } | { kind: "object"; entries: Map<string, Value>; uncertain?: true };
interface Scope { parent?: Scope; bindings: Map<string, Binding>; function?: true }
interface Binding { init?: Node; value?: Value; selection?: string[]; changed?: boolean }
export interface ChildProgram { path: string; line: number }

/**
 * Resolve only proven source entrypoints at real launch APIs. This is not a JavaScript evaluator:
 * dynamic values, imported factories and unknown interpreter flags stay outside this proof.
 * Report/fixture arguments after the executable script are never treated as dependencies.
 */
export function childPrograms(program: Node, filename: string): ChildProgram[] {
  const scopes = new Map<Node, Scope>(), calls: Node[] = [], alteredGlobals = new Set<string>();
  const bindings = new Map<Binding, Node>(), values = new Map<Binding, Value | undefined>(), reads = new Map<Binding, Set<Value>>(), invalid = new Set<Value>(), deepInvalid = new Set<Value>();
  let initial = true;
  const root: Scope = { bindings: new Map(), function: true };
  const lookup = (scope: Scope, id: string): Binding | undefined => scope.bindings.get(id) ?? (scope.parent ? lookup(scope.parent, id) : undefined);
  const bind = (scope: Scope, pattern: unknown, value: Partial<Binding> = {}): void => {
    if (!node(pattern)) return;
    if (name(pattern)) {
      const binding = { ...value, ...(scope.bindings.has(name(pattern)!) ? { changed: true } : {}) };
      scope.bindings.set(name(pattern)!, binding); bindings.set(binding, pattern);
    } else if (pattern.type === "ObjectPattern") for (const property of pattern.properties as Node[]) {
      const key = property.computed ? text(property.key) : name(property.key) ?? text(property.key);
      bind(scope, property.type === "RestElement" ? property.argument : property.value, value.init && key !== undefined ? { ...value, selection: [...(value.selection ?? []), key] } : {});
    }
    else if (pattern.type === "ArrayPattern") for (const entry of pattern.elements as unknown[]) bind(scope, entry);
    else if (pattern.type === "AssignmentPattern") bind(scope, pattern.left, value);
    else if (pattern.type === "RestElement") bind(scope, pattern.argument);
    else if (pattern.type === "TSParameterProperty") bind(scope, pattern.parameter);
  };
  const children = (value: Node, visit: (child: Node) => void) => {
    for (const [key, child] of Object.entries(value)) {
      if (["loc", "start", "end"].includes(key)) continue;
      if (Array.isArray(child)) { for (const entry of child) if (node(entry)) visit(entry); }
      else if (node(child)) visit(child);
    }
  };
  const imported = (path: string, imported: string): Value | undefined => {
    if (["node:path", "path", "node:path/posix", "path/posix"].includes(path)) return { kind: "api", value: imported === "*" || imported === "default" ? "path" : `path.${imported}` };
    if (["node:url", "url"].includes(path)) return { kind: "api", value: imported === "*" || imported === "default" ? "url" : `url.${imported}` };
    if (["node:child_process", "child_process"].includes(path)) return { kind: "api", value: imported === "*" || imported === "default" ? "child" : `child.${imported}` };
    if (["node:process", "process"].includes(path)) return { kind: "api", value: imported === "*" || imported === "default" ? "process" : `process.${imported}` };
    if (path === "bun") return { kind: "api", value: imported === "*" || imported === "default" ? "Bun" : `Bun.${imported}` };
    if (path === "@petrina/test-support/commands" || path === "@petrina/test-support/run-process") {
      if (["runCommand", "runProcess"].includes(imported)) return { kind: "call", value: "argv" };
      if (imported === "*") return { kind: "api", value: "fixture" };
    }
    if (imported === "AgentRun" && sourceCandidates(filename, path).some(target => ["packages/agent-runtime/src/acp-run.ts", "packages/agent-runtime/src/index.ts"].includes(target))) return { kind: "api", value: "AgentRun" };
  };
  const scan = (value: Node, outer: Scope, parent?: Node): void => {
    if (["FunctionDeclaration", "ClassDeclaration", "TSEnumDeclaration", "TSModuleDeclaration", "TSImportEqualsDeclaration"].includes(value.type)) bind(outer, value.id);
    const scope: Scope = functions.has(value.type) || ["BlockStatement", "ClassExpression", "CatchClause", "ForStatement", "ForOfStatement", "ForInStatement", "SwitchStatement"].includes(value.type)
      ? { parent: outer, bindings: new Map<string, Binding>(), ...(functions.has(value.type) ? { function: true as const } : {}) } : outer;
    scopes.set(value, scope);
    if (functions.has(value.type)) for (const param of value.params as unknown[]) bind(scope, param);
    if (value.type === "FunctionExpression" || value.type === "ClassExpression") bind(scope, value.id);
    if (value.type === "CatchClause") bind(scope, value.param);
    if (value.type === "VariableDeclarator") {
      let owner = scope; if (parent?.kind === "var") while (!owner.function && owner.parent) owner = owner.parent;
      bind(owner, value.id, parent?.kind === "const" && node(value.init) ? { init: value.init } : {});
    }
    if (value.type === "ImportDeclaration") for (const specifier of value.specifiers as Node[]) bind(scope, specifier.local, value.importKind === "type" || specifier.importKind === "type" ? {} : {
      value: imported(text(value.source) ?? "", specifier.type === "ImportSpecifier" ? name(specifier.imported) ?? text(specifier.imported) ?? "" : specifier.type === "ImportNamespaceSpecifier" ? "*" : "default"),
    });
    if (value.type === "CallExpression" || value.type === "NewExpression") calls.push(value);
    children(value, child => scan(child, scope, value));
  };
  scan(program, root);
  const globalAccess = (input: unknown, seen = new Set<Binding>()): string | undefined => {
    const value = unwrap(input);
    if (!node(value)) return;
    const id = name(value);
    if (id) {
      const binding = lookup(scopes.get(value)!, id);
      if (binding && !seen.has(binding)) {
        const next = new Set(seen); next.add(binding);
        let path = globalAccess(binding.init, next);
        for (const key of binding.selection ?? []) path = path && (path === "globalThis" ? key : `${path}.${key}`);
        return path;
      }
      if (!binding && ["Bun", "process", "globalThis", "URL"].includes(id)) return id;
    }
    if (value.type === "MemberExpression") {
      const owner = globalAccess(value.object, seen), key = member(value);
      if (owner && key) return owner === "globalThis" ? key : `${owner}.${key}`;
    }
  };
  const altered = (path: string) => alteredGlobals.has("globalThis") && ["Bun", "process", "URL"].includes(path.split(".")[0]!)
    || path.split(".").some((_, index, parts) => alteredGlobals.has(parts.slice(0, index + 1).join(".")));
  const remember = (value: Value | undefined, active: Set<Binding>) => {
    if (value && ["object", "array", "url"].includes(value.kind)) for (const binding of active) {
      const dependencies = reads.get(binding) ?? new Set<Value>(); dependencies.add(value); reads.set(binding, dependencies);
    }
  };
  const access = (object: Value | undefined, key: string, active: Set<Binding>): Value | undefined => {
    remember(object, active);
    if (!initial && object && invalid.has(object)) return;
    if (object?.kind === "object") return object.entries.get(key);
    if (object?.kind === "api") {
      if (!initial && (altered(`${object.value}.${key}`) || object.value === "globalThis" && altered(key))) return;
      if (object.value === "globalThis" && ["Bun", "process", "URL"].includes(key)) return { kind: "api", value: key };
      if (object.value === "AgentRun" && key === "start") return { kind: "call", value: "agent" };
      if (object.value === "fixture" && ["runCommand", "runProcess"].includes(key)) return { kind: "call", value: "argv" };
      if (["path", "url", "child", "Bun", "process"].includes(object.value)) return { kind: "api", value: `${object.value}.${key}` };
    }
    if (object?.kind === "url" && ["href", "pathname"].includes(key)) return object;
  };
  const resolve = (input: unknown, active = new Set<Binding>()): Value | undefined => {
    if (!node(input)) return;
    if (wrappers.has(input.type)) return resolve(input.expression ?? input.argument, active);
    if (text(input) !== undefined) return { kind: "text", value: text(input)! };
    if (name(input)) {
      const binding = lookup(scopes.get(input)!, name(input)!);
      if (binding) {
        if (binding.changed || active.has(binding)) return;
        const next = new Set(active); next.add(binding);
        if (!values.has(binding)) {
          let value = binding.value ?? resolve(binding.init, next);
          for (const key of binding.selection ?? []) value = access(value, key, next);
          values.set(binding, value);
        }
        for (const dependency of reads.get(binding) ?? []) remember(dependency, active);
        const value = values.get(binding);
        if (!initial && (value && (invalid.has(value) || value.kind === "api" && altered(value.value)) || [...(reads.get(binding) ?? [])].some(value => invalid.has(value)))) return;
        return value;
      }
      if (["Bun", "process", "globalThis", "URL"].includes(name(input)!) && (initial || !altered(name(input)!))) return { kind: "api", value: name(input)! };
      return;
    }
    if (input.type === "ArrayExpression") {
      const entries: (Value | undefined)[] = [];
      for (const entry of input.elements as unknown[]) {
        if (node(entry) && entry.type === "SpreadElement") {
          const spread = resolve(entry.argument, active); if (spread?.kind !== "array") return;
          remember(spread, active);
          entries.push(...spread.entries);
        } else entries.push(resolve(entry, active));
      }
      return { kind: "array", entries };
    }
    if (input.type === "ObjectExpression") {
      const entries = new Map<string, Value>(); let uncertain = false;
      for (const property of input.properties as Node[]) {
        if (property.type === "SpreadElement") {
          const spread = resolve(property.argument, active);
          remember(spread, active);
          if (spread?.kind === "object") { for (const [key, value] of spread.entries) entries.set(key, value); uncertain ||= !!spread.uncertain; }
          else { entries.clear(); uncertain = true; } // An unknown later spread can replace previously known command/cwd fields.
        } else if (property.type === "ObjectProperty" || property.type === "ObjectMethod") {
          const key = property.computed ? text(property.key) : name(property.key) ?? text(property.key);
          if (key === undefined) { entries.clear(); uncertain = true; continue; }
          entries.set(key, resolve(property.value, active) ?? { kind: "unknown" });
        }
      }
      return { kind: "object", entries, ...(uncertain ? { uncertain: true } : {}) };
    }
    if (input.type === "MemberExpression") {
      const key = member(input);
      if (node(input.object) && input.object.type === "MetaProperty" && name(input.object.meta) === "import" && name(input.object.property) === "meta") {
        if (key === "dir") return { kind: "path", value: `${repository}${posix.dirname(filename)}` };
        if (key === "filename") return { kind: "path", value: `${repository}${filename}` };
        if (key === "url") return { kind: "url", value: `${repository}${filename}` };
        if (key === "resolve") return { kind: "call", value: "module" };
      }
      return key === undefined ? undefined : access(resolve(input.object, active), key, active);
    }
    if (input.type === "CallExpression" || input.type === "NewExpression") {
      const api = resolve(input.callee, active), args = (input.arguments as unknown[]).map(value => resolve(value, active));
      if (api?.kind === "call" && api.value === "module" && args[0]?.kind === "text" && args.length === 1) return { kind: "module", value: args[0].value };
      if (api?.kind !== "api") return;
      if (["url.fileURLToPath", "url.pathToFileURL"].includes(api.value) && args.length === 1) {
        const value = args[0];
        if (value?.kind === "module" && api.value === "url.fileURLToPath") return value;
        if (value?.kind === "url" || value?.kind === "path") return { kind: api.value === "url.fileURLToPath" ? "path" : "url", value: value.value };
      }
      if (api.value === "URL" && input.type === "NewExpression" && args[0]?.kind === "text" && args[1]?.kind === "url") return { kind: "url", value: posix.resolve(posix.dirname(args[1].value), args[0].value) };
      if (["path.join", "path.resolve", "path.dirname"].includes(api.value) && args.length && args.every(value => value?.kind === "path" || value?.kind === "text")) {
        const parts = args.map(value => (value as { value: string }).value), anchored = args[0]?.kind === "path";
        if (api.value === "path.dirname" && parts.length === 1) return { kind: anchored ? "path" : "text", value: posix.dirname(parts[0]!) };
        if (api.value !== "path.dirname") return { kind: anchored ? "path" : "text", value: anchored && api.value === "path.resolve" ? posix.resolve(...parts) : posix.join(...parts) };
      }
    }
  };
  // Const/member aliases share the same structured value. Mutations/escapes invalidate that identity,
  // not just one variable spelling; path strings remain immutable. Calls are never executed.
  for (const identifier of bindings.values()) resolve(identifier);
  const invalidate = (value: Value | undefined, deep = false): void => {
    if (value?.kind === "api") {
      if (["Bun", "process", "globalThis", "AgentRun", "path", "url", "child", "fixture", "URL"].includes(value.value)) alteredGlobals.add(value.value);
      return;
    }
    if (!value || !["object", "array", "url"].includes(value.kind) || invalid.has(value) && (!deep || deepInvalid.has(value))) return;
    invalid.add(value);
    if (deep) { deepInvalid.add(value); for (const child of value.kind === "object" ? value.entries.values() : value.kind === "array" ? value.entries : []) invalidate(child, true); }
  };
  const changed = (input: unknown): void => {
    const value = unwrap(input); if (!node(value)) return;
    const global = globalAccess(value); if (global) alteredGlobals.add(global);
    if (value.type === "MemberExpression") {
      const object = resolve(value.object);
      if (object?.kind === "api") { const key = member(value); alteredGlobals.add(key ? `${object.value}.${key}` : object.value); }
      else invalidate(object);
    } else {
      const binding = name(value) && lookup(scopes.get(value)!, name(value)!); if (binding) binding.changed = true;
    }
  };
  const writes = (value: Node): void => {
    if (["AssignmentExpression", "UpdateExpression"].includes(value.type) || value.type === "UnaryExpression" && value.operator === "delete") changed(value.left ?? value.argument);
    if (value.type === "CallExpression" && node(value.callee) && value.callee.type === "MemberExpression" && ["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin"].includes(member(value.callee) ?? "")) invalidate(resolve(value.callee.object));
    if (value.type === "CallExpression" && node(value.callee) && value.callee.type === "MemberExpression"
      && ["Object", "Reflect"].includes(name(value.callee.object) ?? "") && ["assign", "defineProperty", "defineProperties", "set", "deleteProperty"].includes(member(value.callee) ?? "")) invalidate(resolve((value.arguments as unknown[])[0]));
    children(value, writes);
  };
  writes(program);
  for (const call of calls) {
    const api = resolve(call.callee);
    const known = api?.kind === "call" || api?.kind === "api" && ["Bun.spawn", "Bun.spawnSync", "child.spawn", "child.spawnSync", "child.execFile", "child.execFileSync", "child.fork", "path.join", "path.resolve", "path.dirname", "url.fileURLToPath", "url.pathToFileURL", "URL"].includes(api.value);
    if (!known) for (const argument of call.arguments as unknown[]) invalidate(resolve(argument), true);
  }
  initial = false;
  const result: ChildProgram[] = [];
  const target = (value: Value | undefined, cwd: Value | undefined, line: number): void => {
    if (value && invalid.has(value)) return;
    if (value?.kind === "module") for (const path of sourceCandidates(filename, value.value)) result.push({ path, line });
    else {
      const resolved = value?.kind === "path" || value?.kind === "url" ? posix.normalize(value.value)
        : value?.kind === "text" && cwd?.kind === "path" && !posix.isAbsolute(value.value) ? posix.resolve(cwd.value, value.value) : undefined;
      if (resolved?.startsWith(repository)) result.push({ path: resolved.slice(repository.length), line });
    }
  };
  const interpreter = (value: Value | undefined) => value?.kind === "api" && value.value === "process.execPath" ? "bun"
    : value?.kind === "text" && ["bun", "bun.exe"].includes(value.value) ? "bun" : value?.kind === "text" && ["node", "node.exe"].includes(value.value) ? "node" : undefined;
  const argv = (command: Value | undefined, cwd: Value | undefined, line: number): void => {
    if (command?.kind !== "array" || invalid.has(command)) return;
    const dialect = interpreter(command.entries[0]);
    if (!dialect) { target(command.entries[0], cwd, line); return; }
    for (let index = 1; index < command.entries.length; index++) {
      const entry = command.entries[index];
      if (entry?.kind === "text") {
        if (entry.value === "--") { target(command.entries[index + 1], cwd, line); return; }
        if (["--no-warnings", "--enable-source-maps", "--experimental-strip-types"].includes(entry.value) || dialect === "bun" && (["--no-env-file", "--silent", "--smol"].includes(entry.value) || index === 1 && ["run", "test"].includes(entry.value))) continue;
        if (entry.value.startsWith("-")) return; // Inline code and flags with unknown operand arity are not file entrypoints.
      }
      target(entry, cwd, line); return;
    }
  };
  for (const call of calls) {
    const api = resolve(call.callee), args = (call.arguments as unknown[]).map(value => resolve(value)), line = (call.loc as { start: { line: number } }).start.line;
    if (api?.kind === "call" && api.value === "agent") {
      const options = args[0]; if (options?.kind === "object") argv(options.entries.get("command"), options.entries.get("cwd"), line);
    } else if (api?.kind === "call" && api.value === "argv" || api?.kind === "api" && ["Bun.spawn", "Bun.spawnSync"].includes(api.value)) {
      const options = args[0]?.kind === "object" ? args[0] : args[1], command = args[0]?.kind === "object" ? args[0].entries.get("cmd") : args[0];
      if (api.kind === "call" && options && (options.kind !== "object" || options.uncertain || options.entries.has("start"))) continue;
      argv(command, options?.kind === "object" ? options.entries.get("cwd") : undefined, line);
    } else if (api?.kind === "api" && ["child.spawn", "child.spawnSync", "child.execFile", "child.execFileSync"].includes(api.value)) {
      const options = args[1]?.kind === "array" ? args[2] : args[1];
      argv({ kind: "array", entries: [args[0], ...(args[1]?.kind === "array" ? args[1].entries : [])] }, options?.kind === "object" ? options.entries.get("cwd") : undefined, line);
    } else if (api?.kind === "api" && api.value === "child.fork") {
      const options = args[1]?.kind === "array" ? args[2] : args[1];
      target(args[0], options?.kind === "object" ? options.entries.get("cwd") : undefined, line);
    }
  }
  return [...new Map(result.map(value => [`${value.line}:${value.path}`, value])).values()];
}
