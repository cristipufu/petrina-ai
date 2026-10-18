// Bun's isolated test workers bypass process exit hooks. Own their temporary files outside the
// workers, so even a failing run removes fixtures and private Git helpers after every worker stops.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const parent = process.platform === "darwin" && tmpdir().startsWith("/var/folders/") ? "/tmp" : tmpdir();
const folder = mkdtempSync(join(parent, "petrina-tests-"));
const home = join(folder, "home");
mkdirSync(home);
try {
  const child = Bun.spawn([process.execPath, "test", "--parallel", ...process.argv.slice(2)], {
    env: { ...process.env, TMPDIR: folder, TMP: folder, TEMP: folder, PETRINA_HOME: home },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });
  let interrupted: number | undefined;
  const onInt = () => { interrupted = 130; child.kill("SIGINT"); };
  const onTerm = () => { interrupted = 143; child.kill("SIGTERM"); };
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  try {
    const code = await child.exited;
    process.exitCode = interrupted ?? code;
  }
  finally {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    if (interrupted) process.exitCode = interrupted;
  }
} finally {
  rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
