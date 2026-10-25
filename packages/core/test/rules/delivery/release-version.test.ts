import { describe as originalDescribe } from "vitest";
import { expect, it } from "vitest";
import { nextVersion, parseVersion } from "../../../src/release-version.js";

originalDescribe("Release versions", () => {
it("counts up from tags like v1.2.3 and keeps their style", () => {
    expect(nextVersion("v1.2.3", "patch")).toEqual({ version: "1.2.4", tag: "v1.2.4" });
    expect(nextVersion("1.2.3", "minor")).toEqual({ version: "1.3.0", tag: "1.3.0" });
    expect(nextVersion("v1.2.3", "major")).toEqual({ version: "2.0.0", tag: "v2.0.0" });
    expect(nextVersion("release-7", "patch")).toBeUndefined();
    expect(parseVersion("1.4.0")?.version).toBe("1.4.0");
  });
});
