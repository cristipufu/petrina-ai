import { describe, expect, it } from "bun:test";
import { originUrl } from "@petrina/repositories/discovery-values";

describe("The clone finder", () => {
it("reads the origin from a git config", () => {
    expect(originUrl(`[remote "upstream"]\n\turl = https://github.com/a/b\n[remote "origin"]\n\turl = git@github.com:me/b.git\n`)).toBe("git@github.com:me/b.git");
    expect(originUrl("[core]\n\tbare = false\n")).toBeUndefined();
  });
});
