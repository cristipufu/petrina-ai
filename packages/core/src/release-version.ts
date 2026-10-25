export type Bump = "patch" | "minor" | "major";
const SEMVER = /^(v?)(\d+)\.(\d+)\.(\d+)$/;

/** A release tag or version number Petrina can count up from, e.g. v1.2.3 or 1.2.3. */
export function parseVersion(text: string): { prefix: string; version: string; parts: [number, number, number] } | undefined {
  const match = SEMVER.exec(text.trim());
  if (!match) return undefined;
  const parts: [number, number, number] = [Number(match[2]), Number(match[3]), Number(match[4])];
  return { prefix: match[1]!, version: parts.join("."), parts };
}

/** The next release after `latest`, keeping its tag style. */
export function nextVersion(latest: string, bump: Bump): { version: string; tag: string } | undefined {
  const parsed = parseVersion(latest);
  if (!parsed) return undefined;
  const [major, minor, patch] = parsed.parts;
  const version = bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
  return { version, tag: `${parsed.prefix}${version}` };
}
