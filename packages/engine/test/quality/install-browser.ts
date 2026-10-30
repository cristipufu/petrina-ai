import { bundledPlaywrightMcpCliPath } from "./bundled-browser.js";

if (import.meta.main) {
  const cli = bundledPlaywrightMcpCliPath();
  const child = Bun.spawn([process.execPath, cli, "install-browser", "--no-shell", "chromium", ...process.argv.slice(2)], {
    stdio: ["inherit", "inherit", "inherit"],
    windowsHide: true,
  });
  process.exitCode = await child.exited;
}
