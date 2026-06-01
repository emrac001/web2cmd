import { useEffect, useState } from "react";
import { api, type DirEntry } from "../lib/api";

/**
 * Browse the laptop's filesystem to pick a project folder, then start a session in it
 * (optionally auto-launching Claude).
 */
type ClaudeMode = "off" | "new" | "continue";

export function ProjectPicker({
  startCwd,
  onStart,
  onCancel,
}: {
  startCwd: string;
  onStart: (cwd: string, claudeMode: ClaudeMode) => void;
  onCancel?: () => void;
}) {
  const [path, setPath] = useState(startCwd);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [claudeMode, setClaudeMode] = useState<ClaudeMode>("new");

  const load = async (p?: string) => {
    setError(null);
    try {
      const res = await api.browse(p);
      setPath(res.path);
      setEntries(res.entries.filter((e) => e.type === "dir"));
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  useEffect(() => {
    load(startCwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const parent = () => {
    const sep = path.includes("\\") ? "\\" : "/";
    const trimmed = path.replace(/[\\/]+$/, "");
    const up = trimmed.slice(0, trimmed.lastIndexOf(sep)) || sep;
    load(up);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] p-3">
        <button
          onClick={parent}
          className="rounded-md border border-[var(--border)] bg-[#1a2030] px-3 py-2 text-sm"
        >
          ↑ Up
        </button>
        <div className="min-w-0 flex-1 truncate rounded-md border border-[var(--border)] bg-[#0b0e14] px-3 py-2 text-sm text-gray-300">
          {path}
        </div>
        {onCancel && (
          <button onClick={onCancel} className="px-2 py-2 text-sm text-gray-400">
            Cancel
          </button>
        )}
      </div>

      {error && <p className="p-3 text-sm text-red-400">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.map((e) => (
          <button
            key={e.path}
            onClick={() => load(e.path)}
            className="flex w-full items-center gap-2 border-b border-[var(--border)]/40 px-4 py-3 text-left text-sm active:bg-[#1a2030]"
          >
            <span className="text-[var(--accent)]">📁</span>
            <span className="truncate">{e.name}</span>
          </button>
        ))}
        {entries.length === 0 && !error && (
          <p className="p-4 text-sm text-gray-500">No subfolders here.</p>
        )}
      </div>

      <div className="border-t border-[var(--border)] p-3">
        <div className="mb-3">
          <div className="mb-1.5 text-xs uppercase tracking-wide text-gray-500">On open</div>
          <div className="grid grid-cols-3 gap-1.5">
            {(
              [
                ["off", "Shell only"],
                ["new", "Start Claude"],
                ["continue", "Resume Claude"],
              ] as [ClaudeMode, string][]
            ).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setClaudeMode(mode)}
                className={
                  "rounded-md border px-2 py-2 text-xs font-medium " +
                  (claudeMode === mode
                    ? "border-[var(--accent)] bg-[var(--accent)] text-black"
                    : "border-[var(--border)] bg-[#1a2030] text-[var(--text)]")
                }
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <button
          onClick={() => onStart(path, claudeMode)}
          className="w-full rounded-lg bg-[var(--accent)] px-3 py-3 font-medium text-black"
        >
          Open terminal here
        </button>
      </div>
    </div>
  );
}
