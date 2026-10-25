import { posix, win32 } from "node:path";

/** A pasted folder path: quotes and escaped spaces from a terminal undone, ~ meaning the home folder. */
export function expandPastedPath(input: string, home: string, platform: NodeJS.Platform): string {
  const paths = platform === "win32" ? win32 : posix;
  let path = input.trim();
  const quoted = /^(["'])(.*)\1$/.exec(path);
  if (quoted) path = quoted[2]!;
  else if (platform !== "win32") path = path.replace(/\\(.)/g, "$1");
  if (path === "~") path = home;
  else if (path.startsWith(`~/`) || path.startsWith(`~${paths.sep}`)) path = paths.join(home, path.slice(2));
  return paths.isAbsolute(path) ? paths.resolve(path) : paths.resolve(home, path);
}
