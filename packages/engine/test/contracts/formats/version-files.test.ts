import { describe as originalDescribe } from "bun:test";
import { expect, it } from "bun:test";
import { declaredVersion, onlyVersionChanged, isVersionFile } from "../../../src/version.js";
const pkg = (version: string) => `${JSON.stringify({ name: "demo", version }, null, 2)}\n`;

originalDescribe("Release versions", () => {
it("reads what a main version file says, and never passes one it cannot read", () => {
    expect(declaredVersion("package.json", pkg("1.2.3"))).toEqual({ version: "1.2.3" });
    expect(declaredVersion("package.json", '{"name": "demo", "private": true}')).toBe("none");
    expect(declaredVersion("package.json", '{"version": "1.2"}')).toBe("unreadable");
    expect(declaredVersion("package.json", '{"version": 3}')).toBe("unreadable");
    expect(declaredVersion("package.json", "{ not json")).toBe("unreadable");
    expect(declaredVersion("src-tauri/tauri.conf.json", '{"version": "../package.json"}')).toBe("none");
    expect(declaredVersion("Cargo.toml", '[package] # the app\nname = "demo"\nversion = \'1.2.3\'\n\n[dependencies]\nserde = { version = "1.0" }\n')).toEqual({ version: "1.2.3" });
    expect(declaredVersion("Cargo.toml", '[workspace]\nmembers = ["app"]\n\n[workspace.package]\nversion = "0.4.0"\n\n[package]\nversion.workspace = true\n')).toEqual({ version: "0.4.0" });
    expect(declaredVersion("Cargo.toml", '[workspace]\nmembers = ["app"]\n')).toBe("none");
    expect(declaredVersion("Cargo.toml", '[package]\nversion = "1.2"\n')).toBe("unreadable");
    expect(declaredVersion("Cargo.toml", '[package]\nversion = "1.2.3"\n[workspace.package]\nversion = "2.0.0"\n')).toBe("unreadable");
  });
});

originalDescribe("Release versions", () => {
it("reads every legal way of writing Cargo.toml's version, and stops on any it cannot read", () => {
    for (const text of [
      '[package]\nname = "demo"\n"version" = "1.2.3"\n',
      'package.name = "demo"\npackage.version = "1.2.3"\n',
      '["package"]\nname = "demo"\nversion = "1.2.3"\n',
      'package = { name = "demo", version = "1.2.3" }\n',
      '[package]\nname = "demo"\nversion = { workspace = true }\n\n[workspace.package]\nversion = "1.2.3"\n',
      '[project]\nname = "demo"\nversion = "1.2.3"\n',
    ]) {
      expect(declaredVersion("Cargo.toml", text)).toEqual({ version: "1.2.3" });
    }
    for (const text of [
      '[package]\nname = "demo"\n',
      '[package]\nname = "demo"\nversion.workspace = true\n',
      "[package]\nversion = 1.2\n",
      '[package]\nversion = "1.2.3"\nversion = "1.2.4"\n',
      '[[package]]\nversion = "1.2.3"\n',
      'package = "demo"\n',
      '[package\nversion = "1.2.3"\n',
    ]) {
      expect(declaredVersion("Cargo.toml", text)).toBe("unreadable");
    }
  });
});

// Independent parser controls for version-only commits.
originalDescribe("a release's version commit sets the version and nothing else", () => {
{
 const pkg = (version: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "app", version, scripts: { test: "bun test" }, ...extra }, null, 2);
it("accepts the version fields, and only them, changing to the new version", () => {
    expect(onlyVersionChanged("package.json", pkg("1.2.3"), pkg("1.2.4"), "1.2.4", "1.2.3")).toBe(true);
    expect(onlyVersionChanged("package.json", pkg("1.2.3"), pkg("1.2.5"), "1.2.4", "1.2.3")).toBe(false);
    const lock = (version: string) => JSON.stringify({ name: "app", version, lockfileVersion: 3, packages: { "": { name: "app", version }, "node_modules/left-pad": { version: "1.3.0" } } });
    expect(onlyVersionChanged("package-lock.json", lock("1.2.3"), lock("1.2.4"), "1.2.4", "1.2.3")).toBe(true);
    expect(onlyVersionChanged("VERSION", "1.2.3\n", "1.2.4\n", "1.2.4")).toBe(true);
    expect(onlyVersionChanged("src-tauri/Cargo.toml", '[package]\nname = "app"\nversion = "1.2.3"\n\n[dependencies]\nserde = "1"\n', '[package]\nname = "app"\nversion = "1.2.4"\n\n[dependencies]\nserde = "1"\n', "1.2.4", "1.2.3")).toBe(true);
  });
it("refuses a dependency, a script or a pinned version riding along", () => {
    expect(onlyVersionChanged("package.json", pkg("1.2.3"), pkg("1.2.4", { dependencies: { "evil-pkg": "1.0.0" } }), "1.2.4", "1.2.3")).toBe(false);
    expect(onlyVersionChanged("package.json", pkg("1.2.3"), pkg("1.2.4", { scripts: { test: "bun test", postinstall: "curl x | sh" } }), "1.2.4", "1.2.3")).toBe(false);
    expect(onlyVersionChanged("Cargo.toml", '[package]\nversion = "1.2.3"\n', '[package]\nversion = "1.2.4"\nbuild = "steal.rs"\n', "1.2.4", "1.2.3")).toBe(false);
    // A dependency's version written as a table's own line, set to the release's number.
    const table = (serde: string) => `[package]\nname = "app"\nversion = "1.2.3"\n\n[dependencies.serde]\nversion = "${serde}"\n`;
    expect(onlyVersionChanged("Cargo.toml", table("1.0"), table("1.2.4").replace('version = "1.2.3"', 'version = "1.2.4"'), "1.2.4", "1.2.3")).toBe(false);
    expect(onlyVersionChanged("pyproject.toml", '[project]\nname = "app"\nversion = "1.2.3"\ndependencies = ["requests"]\n', '[project]\nname = "app"\nversion = "1.2.4"\ndependencies = ["requests", "evil"]\n', "1.2.4", "1.2.3")).toBe(false);
    // In the lock file only the product's own (local) entries move; a registry package's pin never does.
    const cargoLock = (own: string, dep: string) => `version = 3\n\n[[package]]\nname = "app"\nversion = "${own}"\n\n[[package]]\nname = "serde"\nversion = "${dep}"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "abc"\n`;
    expect(onlyVersionChanged("Cargo.lock", cargoLock("1.2.3", "1.0.0"), cargoLock("1.2.4", "1.0.0"), "1.2.4", "1.2.3")).toBe(true);
    expect(onlyVersionChanged("Cargo.lock", cargoLock("1.2.3", "1.2.3"), cargoLock("1.2.4", "1.2.4"), "1.2.4", "1.2.3")).toBe(false);
    // A first release has no previous version: its lock file does not change at all.
    expect(onlyVersionChanged("Cargo.lock", cargoLock("1.2.3", "1.0.0"), cargoLock("1.2.4", "1.0.0"), "1.2.4")).toBe(false);
    // Version files at any depth (a monorepo's packages), and nothing else.
    expect(isVersionFile("apps/desktop/package.json")).toBe(true);
    expect(isVersionFile("src/index.ts")).toBe(false);
    expect(onlyVersionChanged("package.json", undefined, pkg("1.2.4"), "1.2.4")).toBe(false);
  });
}
});
