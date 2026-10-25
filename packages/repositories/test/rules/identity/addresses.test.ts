import { describe, expect, it } from "bun:test";
import { githubRepo, githubRepoOf, sameRepo } from "../../../src/identity.js";

describe("Petrina's own git steps", () => {
  it("knows a GitHub address by its owner and name, SSH host nicknames included", () => {
    expect(githubRepoOf("https://github.com/acme/shop.git")).toBe("acme/shop");
    expect(githubRepoOf("git@github.com:acme/shop.git")).toBe("acme/shop");
    expect(githubRepoOf("git@github-work:acme/shop")).toBe("acme/shop");
    expect(githubRepoOf("ssh://git@github.com:22/acme/shop.git")).toBe("acme/shop");
    expect(githubRepoOf("https://evil.example/acme/shop.git")).toBeUndefined();
    expect(githubRepoOf("--upload-pack=sh:acme/shop")).toBeUndefined();
    // http and git:// on github.com are GitHub too: discovery already listed them, and adding one
    // used to keep the work on this machine because only https counted.
    for (const url of [
      "http://github.com/acme/shop.git",
      "http://www.github.com/acme/shop",
      "git://github.com/acme/shop.git",
      "git://github.com:9418/acme/shop.git",
      "https://github.com:443/acme/shop.git",
      "https://ssh.github.com/acme/shop.git",
    ]) {
      expect(githubRepoOf(url)).toBe("acme/shop");
      expect(githubRepo(url)).toBe("acme/shop");
      expect(sameRepo(url, "acme/shop")).toBe(true);
    }
    expect(githubRepoOf("http://gitlab.com/acme/shop.git")).toBeUndefined();
    expect(githubRepoOf("git://gitlab.com/acme/shop.git")).toBeUndefined();
    expect(githubRepoOf("http://github.com.evil/acme/shop.git")).toBeUndefined();
    expect(sameRepo("git@github-work:Acme/Shop.git", "acme/shop")).toBe(true);
    expect(sameRepo("git@github.com:evil/shop.git", "acme/shop")).toBe(false);
  });
});
