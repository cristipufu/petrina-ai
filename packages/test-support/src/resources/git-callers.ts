/** Optional diagnostics retain repository source locations, never argv, environment or stack messages. */
export function isGitCaller(value: unknown): value is string {
  return typeof value === "string" && value.length <= 240
    && /^(?:packages|apps)\/[^/():]+\/(?:src|test)\/[^():\n]+\.[cm]?[jt]sx?:[1-9]\d*$/.test(value)
    && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function isRepositoryGitFrame(frame: string): boolean {
  return frame.startsWith("packages/repositories/src/git.")
    || frame.startsWith("packages/repositories/src/git/");
}

export function gitCaller(stack: string | undefined, sourceRoot: string): string | undefined {
  const root = sourceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!root || !stack) return undefined;
  const prefix = `${root}/`;
  const frames: string[] = [];
  for (const raw of stack.slice(0, 16_384).split("\n").slice(0, 40)) {
    if (!/^\s*at\s/.test(raw)) continue;
    const line = raw.replaceAll("\\", "/");
    const at = line.lastIndexOf(prefix);
    if (at < 0) continue;
    const location = line.slice(at + prefix.length).trim();
    const match = /^((?:packages|apps)\/[^/():]+\/(?:src|test)\/[^():\n]+\.[cm]?[jt]sx?):([1-9]\d*):[1-9]\d*\)?$/.exec(location);
    if (!match) continue;
    const frame = `${match[1]}:${match[2]}`;
    if (isGitCaller(frame) && !frames.includes(frame)) frames.push(frame);
  }
  const outsidePlumbing = frames.filter(frame =>
    !frame.startsWith("packages/test-support/src/resources/")
    && !frame.startsWith("packages/test-support/src/commands.")
    && !isRepositoryGitFrame(frame));
  return outsidePlumbing.find(frame => frame.startsWith("packages/engine/src/"))
    ?? outsidePlumbing[0]
    // Async stacks can stop inside the adapter. Keep its operation's call site,
    // rather than attributing every such command to the shared spawn wrapper.
    ?? frames.findLast(isRepositoryGitFrame);
}
