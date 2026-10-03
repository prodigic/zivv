#!/usr/bin/env node
// Build only the experimental preview. The normal dist/ server stays unchanged.
import { spawn } from "node:child_process";
const vite = "node_modules/vite/bin/vite.js";
const directory = ".cache/prototype-venue-tiles";
const env = { ...process.env, VITE_VENUE_TILE_PROTOTYPE: "true" };
const build = spawn(process.execPath, [vite, "build", "--outDir", directory], {
  stdio: "inherit",
  env,
});
build.on("exit", (code) => {
  if (code !== 0) process.exit(code ?? 1);
  const server = spawn(
    process.execPath,
    [
      vite,
      "preview",
      "--outDir",
      directory,
      "--host",
      "127.0.0.1",
      "--port",
      "5176",
      "--strictPort",
    ],
    { stdio: "inherit", env }
  );
  const stop = () => server.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  server.on("exit", (status) => process.exit(status ?? 0));
});
