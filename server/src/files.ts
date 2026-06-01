/**
 * Scoped filesystem access for the project picker and the in-browser editor.
 *
 * Two distinct concerns:
 *  - browseDir(): lets the user pick a project folder anywhere they can read (read-only
 *    directory listing). Used by the project picker.
 *  - read/write within a project root: editing files is hard-scoped to the selected root
 *    with path-traversal protection, so a compromised client can't escape the project.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface DirEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
}

/** Resolve a child path and guarantee it stays inside `root`. Throws on escape. */
export function resolveInRoot(root: string, rel: string): string {
  const abs = resolve(root, rel);
  const r = relative(root, abs);
  if (r === "" ) return abs;
  if (r.startsWith("..") || isAbsolute(r) || r.split(sep).includes("..")) {
    throw new Error("path escapes project root");
  }
  return abs;
}

/** Read-only directory listing for the project picker (any readable path). */
export async function browseDir(path: string): Promise<{ path: string; entries: DirEntry[] }> {
  const abs = resolve(path);
  const names = await readdir(abs, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of names) {
    const full = join(abs, d.name);
    let size = 0;
    if (d.isFile()) {
      try {
        size = (await stat(full)).size;
      } catch {
        /* ignore unreadable */
      }
    }
    entries.push({
      name: d.name,
      path: full,
      type: d.isDirectory() ? "dir" : "file",
      size,
    });
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
  return { path: abs, entries };
}

/** Directory listing scoped to a project root. */
export async function listProject(root: string, rel = "."): Promise<{ rel: string; entries: DirEntry[] }> {
  const abs = resolveInRoot(root, rel);
  const names = await readdir(abs, { withFileTypes: true });
  const entries: DirEntry[] = [];
  for (const d of names) {
    const full = join(abs, d.name);
    let size = 0;
    if (d.isFile()) {
      try {
        size = (await stat(full)).size;
      } catch {
        /* ignore */
      }
    }
    entries.push({
      name: d.name,
      path: relative(root, full).split(sep).join("/"),
      type: d.isDirectory() ? "dir" : "file",
      size,
    });
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
  );
  return { rel: relative(root, abs).split(sep).join("/") || ".", entries };
}

const MAX_EDIT_BYTES = 5 * 1024 * 1024;

export async function readProjectFile(root: string, rel: string): Promise<string> {
  const abs = resolveInRoot(root, rel);
  const s = await stat(abs);
  if (s.size > MAX_EDIT_BYTES) throw new Error("file too large to edit in browser");
  return readFile(abs, "utf8");
}

export async function writeProjectFile(root: string, rel: string, content: string): Promise<void> {
  const abs = resolveInRoot(root, rel);
  await writeFile(abs, content, "utf8");
}
