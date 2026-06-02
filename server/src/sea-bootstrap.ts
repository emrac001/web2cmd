/**
 * SEA bootstrap — runs first inside the packaged single-file .exe (see sea-entry.ts).
 *
 * A SEA blob can carry the bundled server JS and arbitrary *assets*, but it cannot load a native
 * addon directly from inside the blob — node-pty's `.node`/`.dll` files must exist on disk. So on
 * first run we extract the embedded payload (the web build, the node-pty package for this
 * platform, and the Claude fence hook) to a per-user runtime directory, point the server at it via
 * env vars, and add the extracted node_modules to the module search path so `require('node-pty')`
 * resolves to the on-disk copy. Subsequent runs reuse the already-extracted directory.
 *
 * When NOT running as a SEA (normal dev / `node dist/index.js`), this is a no-op.
 */
import { createRequire, Module } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const req = createRequire(import.meta.url);

interface Manifest {
  version: string;
  files: string[]; // asset keys = POSIX-relative paths under the runtime dir
}

function localAppData(): string {
  return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
}

function runBootstrap(): void {
  // node:sea exists on Node 20+, but isSea() is only true inside a packaged binary.
  let sea: typeof import("node:sea");
  try {
    sea = req("node:sea");
  } catch {
    return;
  }
  if (!sea.isSea()) return;

  const manifest = JSON.parse(sea.getAsset("manifest.json", "utf8")) as Manifest;
  const baseDir = join(localAppData(), "Web2cmd");
  const runtimeDir = join(baseDir, "runtime", manifest.version);
  const marker = join(runtimeDir, ".extracted");

  if (!existsSync(marker)) {
    for (const rel of manifest.files) {
      const dest = join(runtimeDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, Buffer.from(sea.getRawAsset(rel)));
    }
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, manifest.version);
  }

  // Point the server at the extracted payload.
  const nodeModules = join(runtimeDir, "node_modules");
  process.env.NODE_PATH = process.env.NODE_PATH
    ? `${nodeModules};${process.env.NODE_PATH}`
    : nodeModules;
  process.env.WEB2CMD_WEB_DIST = join(runtimeDir, "web", "dist");
  process.env.WEB2CMD_FENCE_HOOK = join(runtimeDir, "scripts", "fence-hook.mjs");
  if (!process.env.WEB2CMD_DATA_DIR) {
    process.env.WEB2CMD_DATA_DIR = join(baseDir, "data");
  }
  // Running as the packaged .exe → open the operator Console in the browser once we're listening.
  process.env.WEB2CMD_AUTO_OPEN = "1";
  // Re-read NODE_PATH so require() picks up the extracted node_modules (for node-pty).
  (Module as unknown as { _initPaths(): void })._initPaths();
}

runBootstrap();
