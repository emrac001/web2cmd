/**
 * Set or rotate the Web2cmd login password.
 *   pnpm --filter @web2cmd/server set-password -- <password>
 */
import { loadConfig } from "../config.js";
import { setPassword } from "../auth.js";

const password = process.argv[2];
if (!password) {
  console.error("Usage: set-password -- <password>");
  process.exit(1);
}

const cfg = loadConfig();
setPassword(cfg, password);
console.log(`[web2cmd] password updated. Stored hash in ${cfg.dataDir}\\config.json`);
