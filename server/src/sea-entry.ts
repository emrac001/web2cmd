/**
 * Entry point for the packaged single-file .exe (esbuild bundles this, with node-pty external).
 *
 * The static import of sea-bootstrap is evaluated first (ES module order), so the embedded payload
 * is extracted and the env/module paths are set up before the server is loaded via dynamic import.
 * The dynamic import matters: it defers loading index.js (which reads WEB2CMD_WEB_DIST etc.) until
 * after the bootstrap has set those variables.
 */
import "./sea-bootstrap.js";

import("./index.js").catch((err) => {
  console.error("[web2cmd] failed to start:", err);
  process.exit(1);
});
