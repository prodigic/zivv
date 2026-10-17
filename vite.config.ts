import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  normalizeSiteBase,
  renderPagesFallback,
  renderWebManifest,
} from "./src/utils/site-base.ts";

const siteBase = normalizeSiteBase(
  process.env.ZIVV_BASE_PATH ??
    (process.env.NODE_ENV === "production" ? "/zivv/" : "/")
);
let resolvedSiteBase = siteBase;

// https://vite.dev/config/
export default defineConfig({
  cacheDir: ".cache/vite",
  base: siteBase,
  plugins: [
    react(),
    {
      name: "zivv-pages-base",
      apply: "build",
      configResolved(config) {
        resolvedSiteBase = normalizeSiteBase(config.base);
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "404.html",
          source: renderPagesFallback(
            readFileSync(new URL("./public/404.html", import.meta.url), "utf8"),
            resolvedSiteBase
          ),
        });
        this.emitFile({
          type: "asset",
          fileName: "manifest.json",
          source: renderWebManifest(
            readFileSync(
              new URL("./public/manifest.json", import.meta.url),
              "utf8"
            ),
            resolvedSiteBase
          ),
        });
      },
    } satisfies Plugin,
  ],
  resolve: {
    alias: {
      "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./src"),
    },
  },
  optimizeDeps: {
    // Scan only the SPA entry. The default HTML glob also picks up generated
    // test-results reports and fixture HTML, which can corrupt or dead-lock the
    // esbuild dependency scan on Windows.
    entries: ["index.html"],
  },
  server: {
    // Dynamic port configuration for dev server management
    port: process.env.DEV_SERVER_PORT
      ? parseInt(process.env.DEV_SERVER_PORT)
      : 5173,
    host: process.env.DEV_SERVER_HOST || "localhost",

    // Allow port increment if specified port is occupied (legacy behavior)
    strictPort: false,

    open: false,

    // CORS settings for development
    cors: true,
  },
});
