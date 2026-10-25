/** A literal word for the shell supplied by Git on Unix and Windows. No path normalization is implied. */
export const quoteGitShellWord = (word: string) => `'${word.replaceAll("'", "'\\''")}'`;
