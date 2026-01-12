import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  base: "/", // Using custom domain root path deployment
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Dynamic port configuration for dev server management
    port: process.env.DEV_SERVER_PORT ? parseInt(process.env.DEV_SERVER_PORT) : 5173,
    host: process.env.DEV_SERVER_HOST || 'localhost',

    // Allow port increment if specified port is occupied (legacy behavior)
    strictPort: false,

    // Open browser automatically (can be disabled via env var)
    open: process.env.DEV_SERVER_NO_OPEN !== 'true',

    // CORS settings for development
    cors: true,
  },
});
