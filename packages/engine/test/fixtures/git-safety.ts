import { writeFileSync } from "node:fs";
import { join } from "node:path";

interface UnsafeGitSetting {
  readonly name: string;
  readonly key: string;
  configure(folder: string, command: string): readonly string[];
}

/** One matrix for native adapter contracts and the representative engine journey. */
export const unsafeGitSettings: readonly UnsafeGitSetting[] = [
  { name: "local credential helper", key: "credential.helper", configure: (_folder, command) => ["credential.helper", `!${command}`] },
  { name: "SSH command", key: "core.sshcommand", configure: (_folder, command) => ["core.sshCommand", command] },
  { name: "address rewrite", key: "url.", configure: () => ["url.https://evil.example/.insteadOf", "https://github.com/"] },
  { name: "HTTP proxy", key: "http.proxy", configure: () => ["http.proxy", "http://127.0.0.1:9"] },
  { name: "included settings", key: "include.path", configure(folder, command) {
    const included = join(folder, "included.gitconfig");
    writeFileSync(included, `[core]\n\tsshCommand = ${JSON.stringify(command)}\n`);
    return ["include.path", included];
  } },
  { name: "filesystem monitor", key: "core.fsmonitor", configure: (_folder, command) => ["core.fsmonitor", command] },
  { name: "worktree credential helper", key: "credential.helper", configure: (_folder, command) => ["--worktree", "credential.helper", `!${command}`] },
];
