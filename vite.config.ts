import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "node:url";

// https://vite.dev/config/
export default defineConfig({
  cacheDir: ".cache/vite",
  base: process.env.NODE_ENV === "production" ? "/zivv/" : "/", // GitHub Pages subpath until custom domain active
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(path.dirname(fileURLToPath(import.meta.url)), "./src"),
    },
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
