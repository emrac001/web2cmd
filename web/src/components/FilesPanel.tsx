import { useEffect, useMemo, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import type { Extension } from "@codemirror/state";
import { api, type DirEntry } from "../lib/api";

function langFor(name: string): Extension[] {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  switch (ext) {
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "mjs":
    case "cjs":
      return [javascript({ jsx: true, typescript: true })];
    case "json":
      return [json()];
    case "html":
    case "htm":
      return [html()];
    case "css":
    case "scss":
      return [css()];
    case "md":
    case "markdown":
      return [markdown()];
    case "py":
      return [python()];
    default:
      return [];
  }
}

/** File tree + in-browser editor, scoped to the session's project root. */
export function FilesPanel({ root }: { root: string }) {
  const [rel, setRel] = useState(".");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = async (r: string) => {
    setError(null);
    try {
      const res = await api.listProject(root, r);
      setRel(res.rel);
      setEntries(res.entries);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  useEffect(() => {
    load(".");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  const openFile = async (path: string) => {
    try {
      const { content: c } = await api.readFile(root, path);
      setOpenPath(path);
      setContent(c);
      setDirty(false);
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const save = async () => {
    if (!openPath) return;
    setSaving(true);
    try {
      await api.writeFile(root, openPath, content);
      setDirty(false);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setSaving(false);
    }
  };

  const extensions = useMemo(() => langFor(openPath ?? ""), [openPath]);

  const up = () => {
    if (rel === "." || rel === "") return;
    const parent = rel.split("/").slice(0, -1).join("/") || ".";
    load(parent);
  };

  if (openPath) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] p-2">
          <button
            onClick={() => setOpenPath(null)}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm"
          >
            ← Files
          </button>
          <span className="min-w-0 flex-1 truncate text-sm">
            {openPath}
            {dirty ? " •" : ""}
          </span>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-black disabled:opacity-40"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {error && <p className="bg-red-950/40 px-3 py-1.5 text-sm text-red-300">{error}</p>}
        <div className="min-h-0 flex-1 overflow-auto">
          <CodeMirror
            value={content}
            theme={oneDark}
            extensions={extensions}
            height="100%"
            style={{ height: "100%", fontSize: 13 }}
            onChange={(v) => {
              setContent(v);
              setDirty(true);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] p-2">
        <button
          onClick={up}
          disabled={rel === "." || rel === ""}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-40"
        >
          ↑ Up
        </button>
        <span className="min-w-0 flex-1 truncate text-sm text-gray-400">
          {rel === "." ? root : `${root} / ${rel}`}
        </span>
      </div>
      {error && <p className="px-3 py-2 text-sm text-red-400">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.map((e) => (
          <button
            key={e.path}
            onClick={() => (e.type === "dir" ? load(e.path) : openFile(e.path))}
            className="flex w-full items-center gap-2 border-b border-[var(--border)]/40 px-4 py-3 text-left text-sm active:bg-[#1a2030]"
          >
            <span>{e.type === "dir" ? "📁" : "📄"}</span>
            <span className="min-w-0 flex-1 truncate">{e.name}</span>
            {e.type === "file" && (
              <span className="text-xs text-gray-600">{e.size.toLocaleString()} B</span>
            )}
          </button>
        ))}
        {entries.length === 0 && !error && (
          <p className="p-4 text-sm text-gray-500">Empty folder.</p>
        )}
      </div>
    </div>
  );
}
