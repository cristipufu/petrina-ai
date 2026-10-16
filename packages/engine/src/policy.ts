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
  /** Code passed inline to an interpreter (python -c, node -e…): scanned, never trusted. */
  script?: string;
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
const WRAPPERS = new Set(["command", "nohup", "time", "nice", "stdbuf", "exec", "builtin", "caffeinate"]);
/** Shell keywords that can sit in front of a command. */
const RESERVED = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "for", "in", "case", "esac", "select", "function"]);
/** Inline-code flags per interpreter. */
const INLINE_CODE: Record<string, readonly string[]> = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "-p", "--print"],
  deno: ["eval"],
  ruby: ["-e"],
  perl: ["-e", "-E"],
  osascript: ["-e"],
};

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
    while (args.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0]!) || RESERVED.has(args[0]!))) args = args.slice(1);
    const program = basename(args[0] ?? "");
    if (program === "env" && args.some((arg) => arg === "-S" || arg.startsWith("--split-string"))) return { segments: [], opaque: "env -S, which builds a command Petrina cannot read" };
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
  // A program name built from a variable or a substitution cannot be read: fail closed.
  if (/[$`]|…/.test(args[0]!)) return { segments: [{ argv: args, interpreterFromStdin: false }], opaque: "a program name built at run time" };
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
  const inlineFlags = INLINE_CODE[program.replace(/[0-9.]+$/, "")] ?? INLINE_CODE[program];
  const inlineAt = inlineFlags ? args.findIndex((arg, index) => index > 0 && inlineFlags.includes(arg)) : -1;
  const script = inlineAt >= 0 ? args[inlineAt + 1] ?? "" : undefined;
  const interpreterFromStdin = INTERPRETERS.has(program) && inlineAt < 0 && args.slice(1).every((arg) => arg.startsWith("-"));
  return { segments: [{ argv: args, interpreterFromStdin, ...(script !== undefined ? { script } : {}) }] };
}

/** git's subcommand, after its global options, and any `-c` settings that change what it does. */
function gitCommand(argv: string[]): { sub: string; rest: string[]; risky: string[] } {
  const risky: string[] = [];
  let i = 1;
  for (; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "-c" || arg === "--config-env") {
      const setting = argv[i + 1] ?? "";
      if (/^(alias|credential|remote|url|push|core\.(sshcommand|hookspath|fsmonitor|editor|pager)|include)/i.test(setting)) risky.push(setting.split("=")[0]!);
      i += 1;
      continue;
    }
    if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace" || arg === "--exec-path") {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    break;
  }
  return { sub: argv[i] ?? "", rest: argv.slice(i + 1), risky };
}

/** What a non-shipper may run: git that only reads or changes its own working copy. */
const GIT_LOCAL = new Set(["status", "diff", "log", "show", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "rev-list", "describe", "shortlog", "reflog", "cat-file", "merge-base", "name-rev", "for-each-ref", "show-ref", "add", "commit", "checkout", "switch", "restore", "reset", "stash", "merge", "rebase", "cherry-pick", "revert", "rm", "mv", "clean", "branch", "tag", "fetch", "config", "worktree", "apply", "am", "format-patch", "notes", "bisect", "difftool", "range-diff", "whatchanged", "check-ignore", "check-attr", "count-objects", "fsck", "gc", "help", "version", "--version"]);
/** What a read-only role may run: git that changes nothing. */
const GIT_READ = new Set(["status", "diff", "log", "show", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "rev-list", "describe", "shortlog", "reflog", "cat-file", "merge-base", "name-rev", "for-each-ref", "show-ref", "range-diff", "whatchanged", "check-ignore", "check-attr", "help", "version", "--version"]);
/** gh commands that only read. */
const GH_READ = /^(pr|issue|repo|release|run|workflow|label|search|gist|status)$/;
const GH_READ_ACTIONS = new Set(["view", "list", "diff", "status", "checks", "watch", "download", ""]);

/** A whole-command fallback: git or gh that the parser did not see as a program. */
const HIDDEN_GIT = /(^|[\s;&|('"`$=])(git|gh)\s+(-[A-Za-z-]+\s+\S+\s+)*(push|pr|release|api|repo|remote|credential|tag|config|-c)\b/;

type Effect =
  | { kind: "deny"; reason: string }
  | { kind: "ship"; force: boolean }
  | { kind: "ask"; title: string; body: string }
  | { kind: "opaque"; reason: string }
  | { kind: "git-other"; sub: string }
  | { kind: "git-write"; sub: string }
  | { kind: "gh-write"; what: string };

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
    const { sub, rest, risky } = gitCommand(argv);
    if (risky.length) effects.push({ kind: "opaque", reason: `git settings that change what it does (${risky.join(", ")})` });
    if (sub === "push") {
      // Short option clusters (-uf), long forms (--force-with-lease, --mirror…) and +/: refspecs all rewrite or delete.
      const force = rest.some((arg) => (/^-[a-zA-Z]+$/.test(arg) && /[fd]/.test(arg)) || /^--(force|mirror|delete|prune)/.test(arg) || (!arg.startsWith("-") && (arg.includes("+") || arg.startsWith(":"))));
      effects.push({ kind: "ship", force });
    } else if (!GIT_LOCAL.has(sub)) {
      effects.push({ kind: "git-other", sub });
    }
    if (!GIT_READ.has(sub)) effects.push({ kind: "git-write", sub });
  }
  if (program === "gh") {
    const [, group = "", action = ""] = argv;
    const reads = (GH_READ.test(group) && GH_READ_ACTIONS.has(action.startsWith("-") ? "" : action)) || (group === "api" && !argv.some((arg, index) => /^(-f|-F|--field|--raw-field|--input)$/.test(arg) || ((argv[index - 1] === "-X" || argv[index - 1] === "--method") && arg.toUpperCase() !== "GET"))) || group === "auth" && action === "status" || group === "--version" || group === "help";
    if (!reads) effects.push({ kind: "gh-write", what: `${group} ${action}`.trim() });
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
  const shipper = role.id === "shipper";
  const of = <K extends Effect["kind"]>(kind: K) => effects.filter((effect): effect is Extract<Effect, { kind: K }> => effect.kind === kind);

  // Hard rules first: nothing saved earlier can override them.
  const denied = of("deny")[0];
  if (denied) return { decision: "deny", reason: denied.reason };
  if (!shipper) {
    // Fail closed for the programs that can publish: git and gh are allowlisted per role.
    if (of("ship").length || of("gh-write").length) return { decision: "deny", reason: "Only the shipper pushes or writes to GitHub, after you approve the delivery" };
    const unknownGit = of("git-other")[0];
    if (unknownGit) return { decision: "deny", reason: `git ${unknownGit.sub} is not something agents run (aliases included)` };
    const write = of("git-write")[0];
    if (write && !role.canEdit) return { decision: "deny", reason: `${role.name} is read-only (git ${write.sub})` };
    const scripts = analysis.segments.map((segment) => segment.script).filter((script): script is string => script !== undefined);
    if (HIDDEN_GIT.test(command) && !analysis.segments.some((segment) => ["git", "gh"].includes(basename(segment.argv[0] ?? ""))) || scripts.some((script) => /\b(git|gh)\b/.test(script))) {
      return { decision: "deny", reason: "git or gh hidden inside another command; run it directly" };
    }
  } else if (of("ship").some((effect) => effect.force)) {
    return { decision: "ask", title: "Force-push or delete on GitHub", body: "This rewrites or removes history on GitHub.", detail: command };
  }

  const opaque = analysis.opaque ?? of("opaque")[0]?.reason;
  if (opaque) return { decision: "ask", title: "Run a command Petrina cannot read", body: `The command contains ${opaque}.`, detail: command };

  const ask = effects.find((effect): effect is Extract<Effect, { kind: "ask" }> => effect.kind === "ask");
  if (ask) {
    const rule = ruleFor(command);
    if (rule && allowed.includes(rule)) return { decision: "allow" };
    return { decision: "ask", title: ask.title, body: ask.body, detail: command, ...(rule ? { rule } : {}) };
  }
  return { decision: "allow" };
}

const CREDENTIAL_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AUTH_SOCK", "GIT_ASKPASS", "SSH_ASKPASS"];

/**
 * The environment for agents that must not publish anything. They get no GitHub credentials
 * at all (defence in depth, so a policy miss still cannot push): no tokens, an empty gh
 * config, git credential helpers reset, and no SSH for git.
 */
export function agentEnv(env: NodeJS.ProcessEnv, emptyGhConfig: string): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const name of CREDENTIAL_VARS) delete clean[name];
  const count = Number(env.GIT_CONFIG_COUNT ?? 0) || 0;
  const settings: [string, string][] = [
    ["credential.helper", ""],
    ["remote.origin.pushurl", "petrina-push-disabled://only-the-shipper-pushes"],
    ["core.sshCommand", "petrina-ssh-disabled"],
  ];
  settings.forEach(([key, value], index) => {
    clean[`GIT_CONFIG_KEY_${count + index}`] = key;
    clean[`GIT_CONFIG_VALUE_${count + index}`] = value;
  });
  clean.GIT_CONFIG_COUNT = String(count + settings.length);
  clean.GIT_SSH_COMMAND = "petrina-ssh-disabled";
  clean.GIT_TERMINAL_PROMPT = "0";
  clean.GH_CONFIG_DIR = emptyGhConfig;
  clean.GH_PROMPT_DISABLED = "1";
  return clean;
}
