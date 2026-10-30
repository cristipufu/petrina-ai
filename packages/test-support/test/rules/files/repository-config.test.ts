import { expect, it } from "bun:test";
import { privateOriginConfig } from "../../../src/repository-config.js";

it("binds only the exact immutable origin template and preserves every other config byte", () => {
  const section = '[remote "origin"]\n\turl = https://example.test/product.git\n';
  const template = '[core]\n\tbare = false\n' + section + '\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\tremote = origin\n';
  const result = privateOriginConfig(template, "https://example.test/product.git", 'C:\\literal $& ";#\t\n\b end');
  expect(result).toBe(template.replace(section, () => '[remote "origin"]\n\turl = "C:\\\\literal $& \\";#\\t\\n\\b end"\n'));
  for (const unknown of ["", template.replace("https:", "ssh:"), template.replace('\turl =', '\tpushurl ='), template + section])
    expect(() => privateOriginConfig(unknown, "https://example.test/product.git", "private")).toThrow("unexpected origin configuration");
});
