import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ProductCheck } from "@petrina/core";

/** The scripts that usually prove a JavaScript project works, in the order they are worth running. */
const SCRIPTS: readonly [string, string][] = [
  ["typecheck", "Type check"],
  ["check-types", "Type check"],
  ["lint", "Lint"],
  ["test", "Tests"],
  ["build", "Build"],
];

function packageManager(root: string): string {
  if (existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

/** Suggest checks from what the repository already declares. The coordinator can change them. */
export function detectChecks(root: string): ProductCheck[] {
  const checks: ProductCheck[] = [];
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const scripts = (JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
      const pm = packageManager(root);
      const seen = new Set<string>();
      for (const [script, name] of SCRIPTS) {
        if (typeof scripts[script] !== "string" || seen.has(name)) continue;
        // npm's placeholder test script fails on purpose: it proves nothing.
        if (script === "test" && /no test specified/i.test(String(scripts[script]))) continue;
        seen.add(name);
        checks.push({ name, argv: [pm, "run", script] });
      }
    } catch {
      // An unreadable package.json suggests nothing.
    }
  }
  if (existsSync(join(root, "Cargo.toml"))) checks.push({ name: "Rust tests", argv: ["cargo", "test"] });
  if (existsSync(join(root, "go.mod"))) checks.push({ name: "Go vet", argv: ["go", "vet", "./..."] }, { name: "Go tests", argv: ["go", "test", "./..."] });
  if (existsSync(join(
    root,
    "pyproject.toml"
  )) || existsSync(join(
    root,
    "pytest.ini"
  ))) checks.push({
    name: "Python tests",
    argv: [
    "python3",
    "-m",
    "pytest",
    "-q"
  ]
  });
  return checks;
}

/** How many sets of CI and build files a product remembers the checks for. */
export const CHECKS_SEEN = 6;

/** The checks for a working copy: the coordinator's, else those found for its CI and build files, else the latest found. */
export function checksFor(product: {
  checks?: readonly ProductCheck[];
  checksBy?: string;
  checksSeen?: readonly {
  fingerprint: string;
  checks: readonly ProductCheck[]
}[]
}, root: string): readonly ProductCheck[] {
  if (product.checksBy === "coordinator") return product.checks ?? [];
  const fingerprint = checksFingerprint(root);
  return product.checksSeen?.find((entry) => entry.fingerprint === fingerprint)?.checks ?? product.checks ?? [];
}

/** The files a product's checks come from: CI workflows and build files at the root. */
const CI_FOLDERS = [".github/workflows", ".gitlab", ".circleci", ".azure-pipelines"];
const BUILD_FILE = /^(package\.json|bun\.lockb?|Cargo\.toml|go\.mod|pyproject\.toml|pytest\.ini|setup\.cfg|Package\.swift|Makefile|Justfile|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|pom\.xml|global\.json|Directory\.Build\.props|.+\.sln|.+\.csproj|.+\.fsproj|azure-pipelines\.ya?ml|\.gitlab-ci\.ya?ml|turbo\.json|nx\.json)$/;

/** A fingerprint of what the Check finder bases its answer on. It changes when CI or build files do. */
export function checksFingerprint(root: string): string {
  const hash = createHash("sha256");
  const add = (path: string, name: string) => {
    try {
      if (statSync(path).isFile()) hash.update(`${name}\0`).update(readFileSync(path)).update("\0");
    } catch {
      // Gone or unreadable: it simply doesn't count.
    }
  };
  let entries: string[] = [];
  try {
    entries = readdirSync(root).sort();
  } catch {
    return "";
  }
  for (const name of entries) if (BUILD_FILE.test(name)) add(join(root, name), name);
  for (const folder of CI_FOLDERS) {
    try {
      for (const name of readdirSync(join(root, folder)).sort()) add(join(root, folder, name), `${folder}/${name}`);
    } catch {
      // No such folder.
    }
  }
  return hash.digest("hex").slice(0, 16);
}
