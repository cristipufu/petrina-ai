import { describe, expect, it } from "bun:test";
import { mergePath, pathFromEnv } from "@petrina/platform/environment-values";

describe("the PATH an app opened from the Dock gets", () => {
it("reads the PATH between the markers, whatever the shell printed around them", () => {
    expect(pathFromEnv("Welcome!\n__petrina_env__\nHOME=/u\nPATH=/opt/bin:/usr/bin\n__petrina_env__\n")).toBe("/opt/bin:/usr/bin");
    expect(pathFromEnv("no markers\nPATH=/x\n")).toBeUndefined();
  });
});

describe("the PATH an app opened from the Dock gets", () => {
it("puts the terminal's PATH first and keeps what only the app had", () => {
    expect(mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin", ":")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(mergePath(undefined, "/usr/bin", ":")).toBe("/usr/bin");
  });
});

describe("the PATH an app opened from the Dock gets", () => {
it("reads the PATH even when the shell exports the marker as `_` (dash)", () => {
    const output = ["__petrina_env__", "_=__petrina_env__", "HOME=/home/me", "PATH=/usr/local/bin:/usr/bin", "__petrina_env__", ""].join("\n");
    expect(pathFromEnv(output)).toBe("/usr/local/bin:/usr/bin");
    expect(pathFromEnv("no markers here")).toBeUndefined();
  });
});
