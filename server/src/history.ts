/**
 * Durable per-project shell history.
 *
 * The shared shell's output (its scrollback) is persisted to disk keyed by the project folder, so
 * it survives both client disconnects and full server restarts. When a session is (re)opened for a
 * project, the stored tail is replayed into the terminal — so either side picks up the same screen
 * and can continue where the work left off, even after the .exe was closed and relaunched.
 *
 * One file per project under <dataDir>/history/<hash>.log. We only ever keep the tail (the last
 * ~256 KB, same budget as the in-memory ring), trimming on open so files stay bounded.
 */
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

const HISTORY_BYTES = 256 * 1024;

function historyDir(dataDir: string): string {
  return join(dataDir, "history");
}

/** Stable filename for a project root (paths are case-insensitive on Windows, so normalize). */
function fileFor(dataDir: string, cwd: string): string {
  const key = resolve(cwd).toLowerCase();
  const hash = createHash("sha1").update(key).digest("hex").slice(0, 16);
  return join(historyDir(dataDir), `${hash}.log`);
}

/**
 * Load a project's stored history tail, trimming the on-disk file to that tail so it can't grow
 * without bound. Returns "" when there's nothing stored yet.
 */
export function loadHistory(dataDir: string, cwd: string): string {
  const file = fileFor(dataDir, cwd);
  if (!existsSync(file)) return "";
  try {
    let data = readFileSync(file, "utf8");
    if (data.length > HISTORY_BYTES) {
      data = data.slice(data.length - HISTORY_BYTES);
      writeFileSync(file, data, { encoding: "utf8", mode: 0o600 });
    }
    return data;
  } catch {
    return "";
  }
}

/** Append a chunk of output to a project's history file (best-effort; failures are ignored). */
export function appendHistory(dataDir: string, cwd: string, data: string): void {
  if (!data) return;
  try {
    mkdirSync(historyDir(dataDir), { recursive: true });
    appendFileSync(fileFor(dataDir, cwd), data, { encoding: "utf8", mode: 0o600 });
  } catch {
    /* disk full / permissions — history is best-effort, never break the live session */
  }
}
