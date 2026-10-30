import { sourceCandidates } from "./source-paths.js";

type Node = { type: string; [key: string]: unknown };

const node = (value: unknown): value is Node =>
  !!value && typeof value === "object" && typeof (value as Node).type === "string";
const name = (value: unknown) => (node(value) && value.type === "Identifier" ? (value.name as string) : undefined);
const text = (value: unknown) => (node(value) && value.type === "StringLiteral" ? (value.value as string) : undefined);

const functions = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
  "ObjectMethod",
  "ClassMethod",
  "ClassPrivateMethod",
]);

const wrappers = new Set([
  "TSAsExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "ParenthesizedExpression",
  "AwaitExpression",
]);

const blockScopes = new Set([
  "BlockStatement",
  "ClassExpression",
  "ClassDeclaration",
  "CatchClause",
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "SwitchStatement",
]);

const conditionalParents = new Set([
  "IfStatement",
  "ConditionalExpression",
  "LogicalExpression",
  "ForStatement",
  "ForOfStatement",
  "ForInStatement",
  "WhileStatement",
  "DoWhileStatement",
  "SwitchStatement",
  "TryStatement",
]);

const unwrap = (value: unknown): unknown =>
  node(value) && wrappers.has(value.type) ? unwrap(value.expression ?? value.argument) : value;

const member = (value: Node) =>
  value.computed
    ? (text(value.property)
      ?? (node(value.property) && value.property.type === "NumericLiteral" ? String(value.property.value) : undefined))
    : name(value.property);

const each = (value: Node, visit: (child: Node) => void) => {
  for (const [key, child] of Object.entries(value)) {
    if (["loc", "start", "end"].includes(key)) continue;
    if (Array.isArray(child)) {
      for (const entry of child) if (node(entry)) visit(entry);
    } else if (node(child)) {
      visit(child);
    }
  }
};

export interface EngineConstruction {
  line: number;
  targets: string[];
  functions: string[];
  calls: string[];
  module: boolean;
}

interface Scope {
  parent?: Scope;
  bindings: Map<string, Binding>;
  function: Node;
}

interface Write {
  value: Node;
  at: number;
  function: Node;
  conditional: boolean;
}

interface Binding {
  imported?: "engine" | "module";
  init?: Node;
  keys: string[];
  writes: Write[];
}

/** Known Engine provenance, using the already parsed AST. This does not prove runtime cleanup. */
export function engineConstructions(program: unknown, filename: string): EngineConstruction[] {
  if (!node(program)) return [];
  const scopes = new Map<Node, Scope>();
  const parents = new Map<Node, Node[]>();
  const constructions: Node[] = [];
  const assignments: Node[] = [];
  const root: Scope = { bindings: new Map(), function: program };

  const lookup = (scope: Scope, id: string): Binding | undefined =>
    scope.bindings.get(id) ?? (scope.parent ? lookup(scope.parent, id) : undefined);

  const engineModule = (path: string) =>
    sourceCandidates(filename, path).some((candidate) =>
      [
        "packages/engine/test/engine.ts",
        "packages/engine/src/engine.ts",
        "packages/engine/src/index.ts",
      ].includes(candidate),
    );

  const bind = (
    scope: Scope,
    pattern: unknown,
    init?: Node,
    keys: string[] = [],
    imported?: Binding["imported"],
  ): void => {
    if (!node(pattern)) return;
    if (name(pattern)) {
      scope.bindings.set(name(pattern)!, { init, imported, keys, writes: [] });
    } else if (pattern.type === "ObjectPattern") {
      for (const entry of pattern.properties as Node[]) {
        const key = entry.computed ? text(entry.key) : (name(entry.key) ?? text(entry.key));
        bind(
          scope,
          entry.type === "RestElement" ? entry.argument : entry.value,
          key === undefined ? undefined : init,
          key === undefined ? [] : [...keys, key],
        );
      }
    } else if (pattern.type === "ArrayPattern") {
      (pattern.elements as unknown[]).forEach((entry, index) => bind(scope, entry, init, [...keys, String(index)]));
    } else if (pattern.type === "AssignmentPattern") {
      bind(scope, pattern.left, init, keys);
    } else if (pattern.type === "RestElement") {
      bind(scope, pattern.argument);
    } else if (pattern.type === "TSParameterProperty") {
      bind(scope, pattern.parameter);
    }
  };

  const scan = (value: Node, outer: Scope, ancestry: Node[] = []): void => {
    if (
      [
        "FunctionDeclaration",
        "ClassDeclaration",
        "TSEnumDeclaration",
        "TSModuleDeclaration",
        "TSImportEqualsDeclaration",
      ].includes(value.type)
    ) {
      bind(outer, value.id, value.type === "ClassDeclaration" ? value : undefined);
    }
    const scope: Scope =
      functions.has(value.type) || blockScopes.has(value.type)
        ? { parent: outer, bindings: new Map(), function: functions.has(value.type) ? value : outer.function }
        : outer;
    scopes.set(value, scope);
    parents.set(value, ancestry);
    if (functions.has(value.type)) {
      for (const parameter of value.params as unknown[]) bind(scope, parameter);
    }
    if (["FunctionExpression", "ClassExpression", "ClassDeclaration"].includes(value.type)) {
      bind(scope, value.id, value.type.startsWith("Class") ? value : undefined);
    }
    if (value.type === "CatchClause") bind(scope, value.param);
    if (value.type === "VariableDeclarator") {
      let owner = scope;
      if (ancestry.at(-1)?.kind === "var") {
        while (owner.parent && owner.function === owner.parent.function) owner = owner.parent;
      }
      bind(owner, value.id, node(value.init) ? value.init : undefined);
    }
    if (value.type === "ImportDeclaration") {
      for (const specifier of value.specifiers as Node[]) {
        const runtime =
          value.importKind !== "type"
          && specifier.importKind !== "type"
          && engineModule(text(value.source) ?? "");
        const importedKind = runtime
          ? specifier.type === "ImportNamespaceSpecifier"
            ? "module"
            : (name(specifier.imported) ?? text(specifier.imported)) === "Engine"
              ? "engine"
              : undefined
          : undefined;
        bind(scope, specifier.local, undefined, [], importedKind);
      }
    }
    if (value.type === "NewExpression") constructions.push(value);
    if (value.type === "AssignmentExpression" && value.operator === "=" && name(value.left)) {
      assignments.push(value);
    }
    each(value, (child) => scan(child, scope, [...ancestry, value]));
  };

  scan(program, root);

  for (const assignment of assignments) {
    const binding = lookup(scopes.get(assignment)!, name(assignment.left)!);
    if (!binding || !node(assignment.right)) continue;
    const fn = scopes.get(assignment)!.function;
    const ancestry = parents.get(assignment)!;
    const local = ancestry.slice(ancestry.lastIndexOf(fn) + 1);
    binding.writes.push({
      value: assignment.right,
      at: assignment.start as number,
      function: fn,
      conditional: local.some((parent) => conditionalParents.has(parent.type)),
    });
  }

  const resolve = (
    input: unknown,
    selection: string[] = [],
    active = new Set<Binding>(),
    use?: Node,
  ): ("engine" | "module")[] => {
    const value = unwrap(input);
    if (!node(value)) return [];
    if (name(value)) {
      const binding = lookup(scopes.get(value)!, name(value)!);
      if (!binding || active.has(binding)) return [];
      const keys = [...binding.keys, ...selection];
      if (binding.imported) {
        return !keys.length
          ? [binding.imported]
          : binding.imported === "module" && keys.length === 1 && keys[0] === "Engine"
            ? ["engine"]
            : [];
      }
      const next = new Set(active);
      next.add(binding);
      const at = use ?? value;
      const fn = scopes.get(at)!.function;
      const local = binding.writes.filter((write) => write.function === fn && write.at < (at.start as number));
      const last = local.findLast((write) => !write.conditional);
      const candidates = [
        last?.value ?? binding.init,
        ...local
          .filter((write) => write.conditional && (!last || write.at > last.at))
          .map((write) => write.value),
        ...binding.writes.filter((write) => write.function !== fn).map((write) => write.value),
      ];
      // An initializer or assignment captures its value when that expression runs,
      // not when a later constructor reads the saved alias.
      return candidates.flatMap((candidate) => resolve(candidate, keys, next));
    }
    if (value.type === "MemberExpression" || value.type === "OptionalMemberExpression") {
      const key = member(value);
      return key === undefined ? [] : resolve(value.object, [key, ...selection], active, use ?? value);
    }
    if (value.type === "ObjectExpression" && selection.length) {
      const entry = (value.properties as Node[]).findLast(
        (prop) =>
          prop.type === "ObjectProperty"
          && (prop.computed ? text(prop.key) : (name(prop.key) ?? text(prop.key))) === selection[0],
      );
      return entry ? resolve(entry.value, selection.slice(1), active) : [];
    }
    if (value.type === "ArrayExpression" && selection.length) {
      return resolve((value.elements as unknown[])[Number(selection[0])], selection.slice(1), active);
    }
    if (["ClassDeclaration", "ClassExpression"].includes(value.type) && !selection.length) {
      return resolve(value.superClass, [], active);
    }
    if (value.type === "ConditionalExpression") {
      return [
        ...resolve(value.consequent, selection, active),
        ...resolve(value.alternate, selection, active),
      ];
    }
    if (value.type === "AssignmentExpression") return resolve(value.right, selection, active);
    const path =
      value.type === "ImportExpression"
        ? text(value.source)
        : value.type === "CallExpression" && name(value.callee) === "require" && !lookup(scopes.get(value)!, "require")
          ? text((value.arguments as unknown[])[0])
          : undefined;
    return path && engineModule(path)
      ? !selection.length
        ? ["module"]
        : selection.length === 1 && selection[0] === "Engine"
          ? ["engine"]
          : []
      : [];
  };

  const functionName = (value: Node) => {
    const parent = parents.get(value)?.at(-1);
    return (
      name(value.id)
      ?? (value.type.endsWith("Method") ? (name(value.key) ?? text(value.key)) : undefined)
      ?? (parent?.type === "VariableDeclarator" ? name(parent.id) : undefined)
    );
  };

  return constructions
    .filter((value) => resolve(value.callee, [], new Set(), value).includes("engine"))
    .map((value) => {
      const ancestry = parents.get(value)!;
      const targets: string[] = [];
      let current = value;
      for (const parent of [...ancestry].reverse()) {
        if (wrappers.has(parent.type) && (parent.expression === current || parent.argument === current)) {
          current = parent;
          continue;
        }
        if (parent.type === "AssignmentExpression" && parent.right === current && name(parent.left)) {
          targets.push(name(parent.left)!);
          current = parent;
          continue;
        }
        if (parent.type === "VariableDeclarator" && parent.init === current && name(parent.id)) {
          targets.push(name(parent.id)!);
        }
        break;
      }
      return {
        line: (value.loc as { start: { line: number } }).start.line,
        targets,
        functions: ancestry
          .filter((parent) => functions.has(parent.type))
          .flatMap((parent) => (functionName(parent) ? [functionName(parent)!] : [])),
        calls: ancestry
          .filter((parent) => parent.type === "CallExpression")
          .flatMap((parent) =>
            node(parent.callee)
              ? [name(parent.callee) ?? member(parent.callee)].filter((called): called is string => !!called)
              : [],
          ),
        module: !ancestry.some((parent) => functions.has(parent.type)),
      };
    });
}

/** Audited constructor sites, not file exemptions or evidence of runtime process settlement. */
const boundaries: { file: string; target: string; function?: string; call?: string; module?: true }[] = [
  { file: "fixtures/direct-drivers.ts", target: "engine", function: "open" },
  {
    file: "fixtures/acceptance-continuation-progress.ts",
    target: "seed",
    function: "acceptanceProgressSeed",
    call: "prepare",
  },
  { file: "contracts/runtime/desktop-recovery.test.ts", target: "pendingSeed", call: "prepare" },
  { file: "contracts/runtime/offline-lifecycle.test.ts", target: "pendingSeed", call: "prepare" },
  { file: "fixtures/native-timer-control.ts", target: "engine", function: "registration" },
  { file: "fixtures/native-timer-control.ts", target: "engine", function: "stoppedScreen" },
  { file: "extra-crash-engine.ts", target: "engine", module: true },
  { file: "extra-checkpoint-crash.ts", target: "engine", module: true },
  { file: "contracts/setup/readiness.test.ts", target: "nativeEngine", call: "use" },
];

export function engineConstructionBoundaries(file: string, sites: readonly EngineConstruction[]): string[] {
  const used = new Set<object>();
  return sites.flatMap((site) => {
    const boundary = boundaries.find(
      (entry) =>
        file === `packages/engine/test/${entry.file}`
        && site.targets.includes(entry.target)
        && (!entry.function || site.functions.includes(entry.function))
        && (!entry.call || site.calls.includes(entry.call))
        && (!entry.module || site.module),
    );
    if (boundary && !used.has(boundary)) {
      used.add(boundary);
      return [];
    }
    return [
      `${file}:${site.line}: construct Engine through engineCaseFixtures or the canonical directDrivers owner; direct construction is limited to the reviewed seed, owned-child and probe sites`,
    ];
  });
}
