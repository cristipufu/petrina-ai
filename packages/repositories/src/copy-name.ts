/**
 * The folder name of one review member's own copy. Member names are logical places (`review-0`, `vote-third:opus-high`)
 * and may hold characters a file system refuses or folds together, so the name is encoded rather than tidied: lowercase
 * letters, digits and dashes stay; every other character, uppercase letters and the underscore included, becomes an
 * underscore and its hex code (`:` is `_3a`; beyond Latin-1, `_u` and four digits). Distinct members keep distinct
 * folders on every system, case-insensitive ones too, and none ends in a dot or space or is a Windows device name.
 */
export function copyFolderName(member: string): string {
  const hex = (text: string, digits: number) => text.charCodeAt(0).toString(16).padStart(digits, "0");
  const name = member.split("").map((char) => /[a-z0-9-]/.test(char) ? char : char.charCodeAt(0) < 0x100 ? `_${hex(char, 2)}` : `_u${hex(char, 4)}`).join("");
  // A bare device name is escaped at its first letter, which still decodes to the same member.
  return /^(con|prn|aux|nul|com\d|lpt\d)$/.test(name) ? `_${hex(name, 2)}${name.slice(1)}` : name || "_";
}
