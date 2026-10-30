/** Bind only the known Git-written seed template; this is not a general config editor. */
export function privateOriginConfig(template: string, address: string, origin: string): string {
  const section = '[remote "origin"]';
  const marker = `${section}\n\turl = ${address}\n`;
  if (template.split(section).length !== 2 || template.split(marker).length !== 2)
    throw new Error("The immutable repository seed has an unexpected origin configuration");
  // Git's quoted values recognize these escapes. Quotes protect literal #, ; and surrounding space.
  const quoted = origin.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\t/g, "\\t").replace(/\x08/g, "\\b");
  return template.replace(marker, () => `${section}\n\turl = "${quoted}"\n`);
}
