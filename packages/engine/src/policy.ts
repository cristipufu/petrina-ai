// Agents start with full permissions inside their own working copy. This policy decides,
// for every permission request an agent makes, whether to allow it, deny it, or ask the
// coordinator. It runs in code, so no prompt can talk its way past it.

import { isAbsolute, relative, resolve } from "node:path";
import type { Role } from "@petrina/core";
import type { PermissionInfo } from "./acp-run.js";

export type Decision = { decision: "allow" } | { decision: "deny"; reason: string } | { decision: "ask"; title: string; body: string; detail?: string; rule?: string };

interface Rule {
  test: RegExp;
  title: (command: string) => string;
  body: string;
}

/** Commands the coordinator hears about before they run. */
const ASK: readonly Rule[] = [
  {
    test: /\b(npm (install|i|add)|bun (add|install)|pnpm (add|install)|yarn add|pip3? install|cargo add|gem install|go get|brew install|composer require)\b\s+\S/,
    title: (command) => `Add a new package: ${packagesOf(command) || "a dependency"}`,
    body: "A new dependency becomes part of the product.",
  },
  { test: /\bgit push\b.*(--force|-f\b|--force-with-lease)/, title: () => "Force-push to GitHub", body: "This rewrites history on GitHub." },
  { test: /\b(npm|bun|pnpm|yarn|cargo) publish\b/, title: () => "Publish a package", body: "This publishes to a public registry." },
  { test: /\bsudo\b/, title: () => "Run a command as administrator", body: "It asked for administrator rights." },
  { test: /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/, title: () => "Run a script from the internet", body: "It wants to download a script and run it." },
  { test: /\brm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\$HOME|\.\.)/, title: () => "Delete files outside the working copy", body: "This deletes files outside the task's own copy." },
  { test: /(^|\s)(cat|less|more|source|\.)\s+[^\s]*\.env\b/, title: () => "Read a secrets file", body: "It wants to read a .env file." },
  { test: /\b(ssh|scp|rsync)\b/, title: () => "Connect to another machine", body: "It wants to open a connection to a remote machine." },
];

/** Commands only the shipper may run, and only after the coordinator approved the delivery. */
const SHIPPING = /\b(git push|gh pr create|gh release create|git tag)\b/;

function packagesOf(command: string): string {
  const words = command.split(/\s+/);
  const verb = words.findIndex((word) => ["install", "i", "add", "require", "get"].includes(word));
  return words
    .slice(verb + 1)
    .filter((word) => word && !word.startsWith("-"))
    .slice(0, 3)
    .join(", ");
}

/** A short prefix to remember "always allow" decisions by: the command's first two words. */
export function ruleFor(command: string): string {
  return command.trim().split(/\s+/).slice(0, 2).join(" ");
}

export function decide(info: PermissionInfo, context: { role: Role; worktree: string; allowed: readonly string[] }): Decision {
  const { role, worktree, allowed } = context;
  const writes = info.kind === "edit" || info.kind === "delete" || info.kind === "move";

  if (writes && !role.canEdit) return { decision: "deny", reason: `${role.name} is read-only` };

  const outside = info.paths.filter((path) => {
    const rel = relative(worktree, isAbsolute(path) ? path : resolve(worktree, path));
    return rel.startsWith("..") || isAbsolute(rel);
  });
  if (writes && outside.length > 0) {
    return { decision: "ask", title: "Change files outside its working copy", body: "It wants to change files outside the task's own copy.", detail: outside.join("\n") };
  }
  if (writes && info.paths.some((path) => /(^|\/)\.env(\.|$)/.test(path))) {
    return { decision: "ask", title: "Change a secrets file", body: "It wants to edit a .env file.", detail: info.paths.join("\n") };
  }

  const command = info.command;
  if (command) {
    if (allowed.some((prefix) => command.trim().startsWith(prefix))) return { decision: "allow" };
    if (SHIPPING.test(command) && !/--force|-f\b/.test(command)) {
      return role.id === "shipper" ? { decision: "allow" } : { decision: "deny", reason: "Only the shipper pushes, after you approve the delivery" };
    }
    for (const rule of ASK) {
      if (rule.test.test(command)) return { decision: "ask", title: rule.title(command), body: rule.body, detail: command, rule: ruleFor(command) };
    }
  }
  return { decision: "allow" };
}
