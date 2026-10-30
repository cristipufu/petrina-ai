/** Git's --numstat -z --stat --patch output: literal paths precede the display material. */
export function parseDiffPacket(text: string): { paths: string[]; stat: string; patch: string } {
  if (!text) return { paths: [], stat: "", patch: "" };
  const paths: string[] = [];
  let offset = 0;
  const field = () => {
    const end = text.indexOf("\0", offset);
    if (end < 0) throw new Error("Git returned an incomplete comparison packet");
    const value = text.slice(offset, end); offset = end + 1;
    return value;
  };
  while (true) {
    const value = field();
    const count = /^(?:\d+|-)\t(?:\d+|-)\t([\s\S]*)$/.exec(value);
    if (!count) {
      if (!paths.length || !value.endsWith("\n")) throw new Error("Git returned an invalid comparison packet");
      // Git's configured submodule format may start with "Submodule", not a diff header.
      // The NUL framing delimits this display payload; its contents stay verbatim.
      return { paths, stat: value, patch: text.slice(offset) };
    }
    // Renames and copies have an empty path in the counts field, then two literal names.
    const names = count[1] ? [count[1]] : [field(), field()];
    if (names.some(name => !name)) throw new Error("Git returned an empty comparison path");
    paths.push(...names);
  }
}
