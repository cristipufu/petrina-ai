/** The url of the "origin" remote in a git config file. */
export function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) inOrigin = /^\[\s*remote\s+"origin"\s*\]$/.test(line);
    else if (inOrigin) {
      const match = /^url\s*=\s*(.+)$/.exec(line);
      if (match) return match[1]!.trim().replace(/^"(.*)"$/, "$1");
    }
  }
  return undefined;
}
