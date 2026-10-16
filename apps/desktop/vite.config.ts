import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** In development, point the UI at the local engine when it is running. */
function engineAddress(): Plugin {
  return {
    name: "petrina-engine-address",
    apply: "serve",
    transformIndexHtml(html) {
      const file = join(process.env.PETRINA_HOME || join(homedir(), ".petrina"), "engine.json");
      if (!existsSync(file)) return html;
      const { url, token } = JSON.parse(readFileSync(file, "utf8")) as { url: string; token: string };
      const content = JSON.stringify({ url, token }).replace(/"/g, "&quot;");
      return html.replace("<head>", `<head>\n    <meta name="petrina-engine" content="${content}" />`);
    },
  };
}

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react(), engineAddress()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "safari16",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
