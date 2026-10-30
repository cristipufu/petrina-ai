import { FUNCTIONS, lineOf, name, node, text, type Node } from "./source-ast.js";

export interface ModuleMocks {
  readonly full: { path: string; line: number }[];
  readonly invalid: { line: number; reason: string }[];
  readonly factories: Set<Node>;
  readonly actual: (value: Node) => boolean;
  readonly dependencies: Set<Node>;
}

/** Only a real, top-level Vitest call with a complete explicit factory can replace an edge. */
export function moduleMocks(program: Node): ModuleMocks {
  const bindings = new Set<string>();
  const namespaces = new Set<string>();
  const full: { path: string; line: number }[] = [];
  const invalid: { line: number; reason: string }[] = [];
  const factories = new Set<Node>();
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
        line: lineOf(value),
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
        invalid.push({ line: lineOf(call), reason: "use a direct Vitest mock call, not a computed replacement" });
      }
      continue;
    }
    if (member(call.callee) !== "mock") continue;
    // Vitest hoists only direct calls named vi.mock/vitest.mock. An alias/namespace
    // can be the real API yet still execute after the view's static imports.
    if (!["vi", "vitest"].includes(name(call.callee.object) ?? "")) {
      invalid.push({
        line: lineOf(call),
        reason: "use a directly imported vi.mock or vitest.mock so the replacement precedes imports",
      });
      continue;
    }
    const [path, factory] = call.arguments as unknown[];
    const fail = (reason: string) => invalid.push({ line: lineOf(call), reason });
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
    full.push({ path: text(path)!, line: lineOf(call) });
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
