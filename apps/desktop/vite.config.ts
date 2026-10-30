import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    allowedHosts: [".tunnelite.com"],
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1431 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "safari16",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replaceAll("\\", "/");
          if (normalized.includes("/packages/core/")) return "core";
          if (!normalized.includes("/node_modules/")) return undefined;
          if (normalized.includes("/@xyflow/") || normalized.includes("/d3-")) return "flow";
          if (normalized.includes("/lucide-react/")) return "icons";
          if (
            normalized.includes("/react-markdown/")
            || normalized.includes("/remark-")
            || normalized.includes("/rehype-")
            || normalized.includes("/micromark")
            || normalized.includes("/mdast-")
            || normalized.includes("/hast-")
            || normalized.includes("/unist-")
            || normalized.includes("/vfile")
          ) {
            return "markdown";
          }
          if (
            normalized.includes("/react/")
            || normalized.includes("/react-dom/")
            || normalized.includes("/scheduler/")
          ) {
            return "react-vendor";
          }
          return undefined;
        },
      },
    },
  },
});
