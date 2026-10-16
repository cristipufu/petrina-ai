// Agents start with full permissions inside their own working copy (the coordinator asked for
// that). This policy decides, for every permission request, whether to allow it, deny it, or
// ask the coordinator. It runs in code: no prompt can talk its way past it.
//
// Commands are parsed, not pattern-matched: they are split into pipeline segments, nested
// shells and substitutions are analysed too, and git's global options are skipped before the
// subcommand is read. Role gates run first, so nothing the coordinator allowed earlier can
// let a non-shipper push. Full containment still needs an OS sandbox around the agent.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { Role } from "@petrina/core";
import type { PermissionInfo } from "./acp-run.js";

export type Decision = { decision: "allow" } | { decision: "deny"; reason: string } | { decision: "ask"; title: string; body: string; detail?: string; rule?: string };

interface Segment {
  argv: string[];
  /** The segment reads a script from stdin (sh, bash, python… with no script argument). */
  interpreterFromStdin: boolean;
}

interface Analysis {
  segments: Segment[];
  /** Something the parser cannot see through, like eval or an unbalanced quote. */
  opaque?: string;
  /** Operators, redirections or substitutions: never auto-allowed by a saved rule. */
  compound: boolean;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const INTERPRETERS = new Set([...SHELLS, "python", "python3", "node", "bun", "deno", "ruby", "perl"]);
const WRAPPERS = new Set(["command", "nohup", "time", "nice", "stdbuf"]);

/** Split a command line into words and operators, honouring quotes. */
function tokenize(input: string): { tokens: string[]; substitutions: string[]; opaque?: string } {
  const tokens: string[] = [];
  const substitutions: string[] = [];
  let word = "";
  let inWord = false;
  const push = () => {
    if (inWord) tokens.push(word);
    word = "";
    inWord = false;
  };
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (ch === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) return { tokens, substitutions, opaque: "an unbalanced quote" };
      word += input.slice(i + 1, end);
      inWord = true;
      i = end;
    } else if (ch === '"') {
      let j = i + 1;
      for (; j < input.length && input[j] !== '"'; j += 1) {
        if (input[j] === "\\") j += 1;
        else if (input[j] === "$" && input[j + 1] === "(") {
          const close = matchParen(input, j + 1);
          if (close < 0) return { tokens, substitutions, opaque: "an unbalanced substitution" };
          substitutions.push(input.slice(j + 2, close));
          j = close;
        } else if (input[j] === "`") {
          const close = input.indexOf("`", j + 1);
          if (close < 0) return { tokens, substitutions, opaque: "an unbalanced substitution" };
          substitutions.push(input.slice(j + 1, close));
          j = close;
        }
      }
      if (j >= input.length) return { tokens, substitutions, opaque: "an unbalanced quote" };
      word += input.slice(i + 1, j).replace(/\\(.)/g, "$1");
      inWord = true;
      i = j;
    } else if (ch === "\\") {
      word += input[i + 1] ?? "";
      inWord = true;
      i += 1;
    } else if (ch === "$" && input[i + 1] === "(") {
      const close = matchParen(input, i + 1);
      if (close < 0) return { tokens, substitutions, opaque: "an unbalanced substitution" };
      substitutions.push(input.slice(i + 2, close));
      word += "$(…)";
      inWord = true;
      i = close;
    } else if (ch === "`") {
      const close = input.indexOf("`", i + 1);
      if (close < 0) return { tokens, substitutions, opaque: "an unbalanced substitution" };
      substitutions.push(input.slice(i + 1, close));
      word += "`…`";
      inWord = true;
      i = close;
    } else if (/\s/.test(ch) && ch !== "\n") {
      push();
    } else if (ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === ")") {
      push();
      const two = input.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === ";;") {
        tokens.push(two);
        i += 1;
      } else tokens.push(ch === "\n" ? ";" : ch);
    } else if (ch === ">" || ch === "<") {
      push();
      tokens.push(ch);
      if (input[i + 1] === ch || input[i + 1] === "&") i += 1;
    } else {
      word += ch;
      inWord = true;
    }
  }
  push();
  return { tokens, substitutions };
}

function matchParen(input: string, open: number): number {
  let depth = 0;
  for (let i = open; i < input.length; i += 1) {
    if (input[i] === "(") depth += 1;
    else if (input[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

const OPERATORS = new Set([";", "&&", "||", "|", "&", "(", ")", ";;"]);

export function analyze(command: string, depth = 0): Analysis {
  if (depth > 4) return { segments: [], opaque: "deeply nested commands", compound: true };
  const { tokens, substitutions, opaque } = tokenize(command);
  const compound = substitutions.length > 0 || tokens.some((token) => OPERATORS.has(token) || token === ">" || token === "<");
  const analysis: Analysis = { segments: [], compound, ...(opaque ? { opaque } : {}) };

  let current: string[] = [];
  const flush = () => {
    if (current.length) {
      const inner = unwrap(current, depth);
      if (inner.opaque && !analysis.opaque) analysis.opaque = inner.opaque;
      analysis.segments.push(...inner.segments);
    }
    current = [];
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (OPERATORS.has(token)) {
      flush();
      continue;
    }
    if (token === ">" || token === "<") {
      i += 1; // skip the redirection target
      continue;
    }
    current.push(token);
  }
  flush();

  for (const inner of substitutions) {
    const nested = analyze(inner, depth + 1);
    analysis.segments.push(...nested.segments);
    if (nested.opaque && !analysis.opaque) analysis.opaque = nested.opaque;
  }
  return analysis;
}

/** Peel off env assignments and wrappers, and look inside `sh -c`, `xargs`, `env`… */
function unwrap(argv: string[], depth: number): { segments: Segment[]; opaque?: string } {
  let args = [...argv];
  for (;;) {
    while (args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!)) args = args.slice(1);
    const program = basename(args[0] ?? "");
    if (program === "env") {
      args = args.slice(1);
      while (args.length && (args[0]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!))) args = args.slice(args[0] === "-u" || args[0] === "--unset" ? 2 : 1);
      continue;
    }
    if (WRAPPERS.has(program)) {
      args = args.slice(1);
      continue;
    }
    if (program === "timeout") {
      args = args.slice(2);
      continue;
    }
    if (program === "xargs") {
      const rest = args.slice(1);
      const start = rest.findIndex((arg) => !arg.startsWith("-"));
      args = start >= 0 ? rest.slice(start) : [];
      continue;
    }
    break;
  }
  if (!args.length) return { segments: [] };
  const program = basename(args[0]!);
  if (program === "eval" || (program === "source" && args[1] && !/\.env/.test(args[1]))) return { segments: [{ argv: args, interpreterFromStdin: false }], opaque: `${program} runs code Petrina cannot read` };
  if (SHELLS.has(program)) {
    const flag = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
    if (flag >= 0) {
      const script = args[flag + 1];
      if (script === undefined) return { segments: [], opaque: "an empty shell command" };
      const nested = analyze(script, depth + 1);
      return { segments: nested.segments, ...(nested.opaque ? { opaque: nested.opaque } : {}) };
    }
  }
  const interpreterFromStdin = INTERPRETERS.has(program) && args.slice(1).every((arg) => arg.startsWith("-") && !/^-[a-z]*[ce]$/.test(arg));
  return { segments: [{ argv: args, interpreterFromStdin }] };
}

/** git's subcommand, after its global options. */
function gitCommand(argv: string[]): { sub: string; rest: string[] } {
  let i = 1;
  for (; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace" || arg === "--exec-path" || arg === "--config-env") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    break;
  }
  return { sub: argv[i] ?? "", rest: argv.slice(i + 1) };
}

type Effect = { kind: "deny"; reason: string } | { kind: "ship"; force: boolean } | { kind: "ask"; title: string; body: string };

const PACKAGE_MANAGERS: Record<string, readonly string[]> = {
  npm: ["install", "i", "add"],
  bun: ["add", "install", "i"],
  pnpm: ["add", "install", "i"],
  yarn: ["add"],
  pip: ["install"],
  pip3: ["install"],
  cargo: ["add", "install"],
  gem: ["install"],
  go: ["get", "install"],
  brew: ["install"],
  composer: ["require"],
};

const CLOUD = new Set(["aws", "az", "gcloud", "terraform", "pulumi", "kubectl", "helm", "vercel", "netlify", "fly", "flyctl", "heroku", "railway", "wrangler"]);

function effectsOf(segment: Segment, segments: Segment[], worktree: string): Effect[] {
  const argv = segment.argv;
  const program = basename(argv[0] ?? "");
  const effects: Effect[] = [];

  if (program === "git") {
    const { sub, rest } = gitCommand(argv);
    if (sub === "push") {
      const force = rest.some((arg) => /^(-f|--force|--force-with-lease.*|--mirror|--delete|-d|--prune)$/.test(arg) || arg.startsWith("+") || arg.startsWith(":"));
      effects.push({ kind: "ship", force });
    }
  }
  if (program === "gh") {
    const [, group, action] = argv;
    if (group === "pr" && action === "merge") effects.push({ kind: "deny", reason: "Petrina never merges pull requests" });
    if (group === "repo" && (action === "delete" || action === "archive" || action === "rename")) effects.push({ kind: "deny", reason: "Agents do not delete, archive or rename repositories" });
    if ((group === "pr" && ["create", "edit", "close", "ready", "reopen", "comment"].includes(action ?? "")) || (group === "release" && ["create", "edit", "delete", "upload"].includes(action ?? ""))) effects.push({ kind: "ship", force: group === "release" && action === "delete" });
    if (group === "api") {
      const method = argv.find((_arg, index) => argv[index - 1] === "-X" || argv[index - 1] === "--method")?.toUpperCase();
      const writes = (method && method !== "GET") || argv.some((arg) => /^(-f|-F|--field|--raw-field|--input)$/.test(arg));
      if (writes) effects.push({ kind: "ship", force: false });
    }
  }
  const managers = PACKAGE_MANAGERS[program];
  if (managers && managers.includes(argv[1] ?? "")) {
    const packages = argv.slice(2).filter((arg) => !arg.startsWith("-"));
    if (packages.length) effects.push({ kind: "ask", title: `Add a new package: ${packages.slice(0, 3).join(", ")}`, body: "A new dependency becomes part of the product." });
  }
  if (["npm", "bun", "pnpm", "yarn", "cargo"].includes(program) && argv[1] === "publish") effects.push({ kind: "ask", title: "Publish a package", body: "This publishes to a public registry." });
  if (program === "sudo" || program === "doas") effects.push({ kind: "ask", title: "Run a command as administrator", body: "It asked for administrator rights." });
  if (["ssh", "scp", "rsync", "sftp"].includes(program)) effects.push({ kind: "ask", title: "Connect to another machine", body: "It wants to open a connection to a remote machine." });
  if (CLOUD.has(program) || (program === "docker" && ["push", "login"].includes(argv[1] ?? ""))) effects.push({ kind: "ask", title: `Use ${program}`, body: "This can change cloud resources, which may cost money." });
  if (segment.interpreterFromStdin && segments.some((other) => ["curl", "wget"].includes(basename(other.argv[0] ?? "")))) {
    effects.push({ kind: "ask", title: "Run a script from the internet", body: "It wants to download a script and run it." });
  }
  if (["cat", "less", "more", "head", "tail", "source", "."].includes(program) && argv.slice(1).some((arg) => /(^|\/)\.env(\.|$)/.test(arg))) {
    effects.push({ kind: "ask", title: "Read a secrets file", body: "It wants to read a .env file." });
  }
  if (["rm", "rmdir", "mv", "chmod", "chown"].includes(program)) {
    const outside = argv.slice(1).filter((arg) => !arg.startsWith("-") && (arg.startsWith("~") || arg.includes("$") || !inside(worktree, arg)));
    if (outside.length) effects.push({ kind: "ask", title: "Change files outside the working copy", body: "This touches files outside the task's own copy." });
  }
  return effects;
}

/** Resolve symlinks (on the nearest existing parent for new files) before checking containment. */
function inside(root: string, path: string): boolean {
  const realRoot = realOrSelf(root);
  let target = isAbsolute(path) ? path : resolve(root, path);
  const missing: string[] = [];
  while (!existsSync(target) && dirname(target) !== target) {
    missing.unshift(basename(target));
    target = dirname(target);
  }
  const full = resolve(realOrSelf(target), ...missing);
  const rel = relative(realRoot, full);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** "Always allow" remembers one exact, simple command. Compound commands are never remembered. */
export function ruleFor(command: string): string | undefined {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized || analyze(normalized).compound) return undefined;
  return normalized;
}

export function decide(info: PermissionInfo, context: { role: Role; worktree: string; allowed: readonly string[] }): Decision {
  const { role, worktree, allowed } = context;
  const writes = info.kind === "edit" || info.kind === "delete" || info.kind === "move";

  if (writes && !role.canEdit) return { decision: "deny", reason: `${role.name} is read-only` };
  if (writes) {
    const outside = info.paths.filter((path) => !inside(worktree, path));
    if (outside.length) return { decision: "ask", title: "Change files outside its working copy", body: "It wants to change files outside the task's own copy.", detail: outside.join("\n") };
    if (info.paths.some((path) => /(^|\/)\.env(\.|$)/.test(path))) return { decision: "ask", title: "Change a secrets file", body: "It wants to edit a .env file.", detail: info.paths.join("\n") };
  }

  const command = info.command;
  if (!command) return { decision: "allow" };

  const analysis = analyze(command);
  const effects = analysis.segments.flatMap((segment) => effectsOf(segment, analysis.segments, worktree));

  // Hard rules first: nothing saved earlier can override them.
  const denied = effects.find((effect): effect is Extract<Effect, { kind: "deny" }> => effect.kind === "deny");
  if (denied) return { decision: "deny", reason: denied.reason };
  const shipping = effects.filter((effect): effect is Extract<Effect, { kind: "ship" }> => effect.kind === "ship");
  if (shipping.length && role.id !== "shipper") return { decision: "deny", reason: "Only the shipper pushes or talks to GitHub, after you approve the delivery" };
  if (shipping.some((effect) => effect.force)) return { decision: "ask", title: "Force-push or delete on GitHub", body: "This rewrites or removes history on GitHub.", detail: command };

  if (analysis.opaque) return { decision: "ask", title: "Run a command Petrina cannot read", body: `The command contains ${analysis.opaque}.`, detail: command };

  const ask = effects.find((effect): effect is Extract<Effect, { kind: "ask" }> => effect.kind === "ask");
  if (ask) {
    const rule = ruleFor(command);
    if (rule && allowed.includes(rule)) return { decision: "allow" };
    return { decision: "ask", title: ask.title, body: ask.body, detail: command, ...(rule ? { rule } : {}) };
  }
  return { decision: "allow" };
}

/** Environment that disables pushing for agents that must not push (defence in depth). */
export function noPushEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const count = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  return {
    GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: "remote.origin.pushurl",
    [`GIT_CONFIG_VALUE_${count}`]: "petrina-push-disabled://only-the-shipper-pushes",
    [`GIT_CONFIG_KEY_${count + 1}`]: "remote.pushDefault",
    [`GIT_CONFIG_VALUE_${count + 1}`]: "petrina-no-push",
  };
}
