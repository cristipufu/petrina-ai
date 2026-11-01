import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { toneRulesCss } from "../../src/themes/tones";

function loadCss(path: string): string {
  const source = readFileSync(path, "utf8");
  const base = dirname(path);
  return source.replace(/^@import\s+["']([^"']+)["'];\s*$/gm, (_line, target: string) =>
    loadCss(resolve(base, target)),
  );
}

/** Reads `src/styles.css` with all local `@import` stylesheets inlined in cascade order for HappyDOM `<style>` injection. */
export function readAppStyles(): string {
  return `${loadCss(resolve(__dirname, "../../src/styles.css"))}\n${toneRulesCss()}`;
}
