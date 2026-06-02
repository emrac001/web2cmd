import { useCallback, useEffect, useState } from "react";
import {
  api,
  type AdminDevice,
  type AdminStatus,
  type DirEntry,
  type TunnelProviderInfo,
  type TunnelProviderName,
} from "../lib/api";

/**
 * Operator Console — shown to the admin (the person on localhost). Replaces the terminal with a
 * control panel: start/stop a tunnel, choose the project root, toggle the fence, share the URL +
 * pairing code, and manage connected clients (revoke / channel cap). All of this hits the
 * /api/admin/* endpoints, which the server only answers on the loopback interface.
 */
function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

function Copy({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* clipboard blocked */
        }
      }}
      className="shrink-0 rounded-md border border-[var(--border)] px-2 py-1 text-xs text-gray-300"
    >
      {done ? "✓" : "Copy"}
    </button>
  );
}

const card = "rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3";
const btn = "rounded-md border border-[var(--border)] bg-[#1a2030] px-3 py-2 text-sm disabled:opacity-50";
const btnAccent = "rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-black disabled:opacity-50";

export function OperatorConsole() {
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [providers, setProviders] = useState<TunnelProviderInfo[]>([]);
  const [devices, setDevices] = useState<AdminDevice[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [browsing, setBrowsing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [st, dv] = await Promise.all([api.adminStatus(), api.adminDevices()]);
      setStatus(st);
      setDevices(dv.devices);
    } catch (e) {
      setErr((e as Error).message);
    }
  }, []);

  useEffect(() => {
    refresh();
    api.adminTunnels().then((t) => setProviders(t.providers)).catch(() => {});
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setErr(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!status) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-500">
        Loading console… {err && <span className="ml-2 text-red-400">{err}</span>}
      </div>
    );
  }

  if (browsing) {
    return <RootBrowser startCwd={status.root} onPick={(p) => run("root", () => api.setRoot(p)).then(() => setBrowsing(false))} onCancel={() => setBrowsing(false)} />;
  }

  const t = status.tunnel;
  const installed = providers.filter((p) => p.available);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-lg space-y-3 p-3">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-semibold">Web2cmd · Operator</h1>
          <span className="rounded-md border border-[var(--border)] px-2 py-0.5 text-xs text-gray-400">
            {status.exposure === "remote" ? "🌐 remote" : "🔒 local"}
          </span>
        </div>
        {err && <p className="text-sm text-red-400">{err}</p>}

        {/* Connection / tunnel */}
        <div className={card}>
          <div className="mb-2 text-sm font-medium">Connection</div>
          {t.running ? (
            <>
              <div className="mb-2 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate rounded-md bg-[#0b0e14] px-2 py-1.5 text-xs text-gray-300">
                  {t.url}
                </span>
                <Copy value={t.url ?? ""} />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-gray-500">via {t.provider}</span>
                <button disabled={busy === "tunnel"} onClick={() => run("tunnel", () => api.stopTunnel())} className={btn}>
                  {busy === "tunnel" ? "…" : "Stop tunnel"}
                </button>
              </div>
            </>
          ) : installed.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              <span className="w-full text-xs text-gray-500">Start a public tunnel so a phone can reach this server:</span>
              {installed.map((p) => (
                <button
                  key={p.provider}
                  disabled={!!busy}
                  onClick={() => run("tunnel", () => api.startTunnel(p.provider as TunnelProviderName))}
                  className={btnAccent}
                >
                  {busy === "tunnel" ? "Starting…" : `Start ${p.provider}`}
                </button>
              ))}
            </div>
          ) : (
            <div className="space-y-1 text-xs text-gray-400">
              <p className="text-yellow-500">No tunnel tool found. Install one, then reopen:</p>
              {providers.map((p) => (
                <p key={p.provider}>• {p.install}</p>
              ))}
            </div>
          )}
        </div>

        {/* Pairing (only meaningful when remote) */}
        <div className={card}>
          <div className="mb-2 text-sm font-medium">Pair a client</div>
          {status.exposure === "remote" ? (
            <>
              <div className="mb-2 flex items-center gap-2">
                <span className="rounded-md bg-[#0b0e14] px-3 py-1.5 font-mono text-2xl tracking-[0.3em] text-[var(--accent)]">
                  {status.pairCode.code}
                </span>
                <Copy value={status.pairCode.code} />
                <button disabled={busy === "code"} onClick={() => run("code", () => api.regenerateCode())} className={btn}>
                  {busy === "code" ? "…" : "New code"}
                </button>
              </div>
              <p className="text-xs text-gray-500">
                Client opens the app, enters the URL above, then this code. Valid ~
                {Math.max(0, Math.round(status.pairCode.expiresInMs / 60000))} min.
              </p>
            </>
          ) : (
            <p className="text-xs text-gray-500">Start a tunnel first — pairing is only needed for remote clients.</p>
          )}
          <div className="mt-2 flex items-center gap-2 border-t border-[var(--border)]/50 pt-2">
            <span className="shrink-0 text-xs text-gray-500">Identity</span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-400">{status.identity}</span>
            <Copy value={status.identity} />
          </div>
        </div>

        {/* Project root + fence */}
        <div className={card}>
          <div className="mb-2 text-sm font-medium">Project</div>
          <div className="mb-2 flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate rounded-md bg-[#0b0e14] px-2 py-1.5 text-xs text-gray-300">{status.root}</span>
            <button onClick={() => setBrowsing(true)} className={btn}>Change</button>
          </div>
          <label className="flex items-center justify-between">
            <span className="text-sm">Project fence {status.fence ? "on" : "off"}</span>
            <button
              disabled={busy === "fence"}
              onClick={() => run("fence", () => api.setFence(!status.fence))}
              className={
                "relative h-6 w-11 rounded-full transition " + (status.fence ? "bg-[var(--accent)]" : "bg-[#1a2030] border border-[var(--border)]")
              }
            >
              <span className={"absolute top-0.5 h-5 w-5 rounded-full bg-white transition " + (status.fence ? "left-5" : "left-0.5")} />
            </button>
          </label>
          <p className="mt-1 text-[11px] text-gray-500">A nudge that keeps the shell in this folder — not a hard jail.</p>
        </div>

        {/* Clients */}
        <div className={card}>
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Clients ({status.devices.active})</span>
            <label className="flex items-center gap-1 text-xs text-gray-500">
              max
              <input
                type="number"
                min={0}
                defaultValue={status.devices.max}
                onBlur={(e) => run("max", () => api.setMaxDevices(Number(e.target.value)))}
                className="w-14 rounded border border-[var(--border)] bg-[#0b0e14] px-1.5 py-1 text-xs"
              />
              <span className="text-gray-600">(0=∞)</span>
            </label>
          </div>
          {devices.filter((d) => !d.revoked).length === 0 ? (
            <p className="text-xs text-gray-500">No paired clients.</p>
          ) : (
            <div className="space-y-1.5">
              {devices.filter((d) => !d.revoked).map((d) => (
                <div key={d.id} className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[#1a2030] px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{d.displayName || "Unnamed device"}</div>
                    <div className="truncate text-[11px] text-gray-500">id {d.id.slice(0, 8)} · paired {ago(d.createdAt)}</div>
                  </div>
                  <button disabled={busy === "rev" + d.id} onClick={() => run("rev" + d.id, () => api.revokeDevice(d.id))} className="rounded-md px-2 py-1 text-xs text-red-400">
                    Revoke
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Minimal folder browser for choosing the project root. */
function RootBrowser({ startCwd, onPick, onCancel }: { startCwd: string; onPick: (p: string) => void; onCancel: () => void }) {
  const [path, setPath] = useState(startCwd);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p?: string) => {
    setError(null);
    try {
      const res = await api.browse(p);
      setPath(res.path);
      setEntries(res.entries.filter((e) => e.type === "dir"));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load(startCwd);
  }, [load, startCwd]);

  const parent = () => {
    const sep = path.includes("\\") ? "\\" : "/";
    const trimmed = path.replace(/[\\/]+$/, "");
    load(trimmed.slice(0, trimmed.lastIndexOf(sep)) || sep);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-[var(--border)] p-3">
        <button onClick={parent} className={btn}>↑ Up</button>
        <div className="min-w-0 flex-1 truncate rounded-md border border-[var(--border)] bg-[#0b0e14] px-3 py-2 text-sm text-gray-300">{path}</div>
        <button onClick={onCancel} className="px-2 py-2 text-sm text-gray-400">Cancel</button>
      </div>
      {error && <p className="p-3 text-sm text-red-400">{error}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {entries.map((e) => (
          <button key={e.path} onClick={() => load(e.path)} className="flex w-full items-center gap-2 border-b border-[var(--border)]/40 px-4 py-3 text-left text-sm active:bg-[#1a2030]">
            <span className="text-[var(--accent)]">📁</span>
            <span className="truncate">{e.name}</span>
          </button>
        ))}
        {entries.length === 0 && !error && <p className="p-4 text-sm text-gray-500">No subfolders here.</p>}
      </div>
      <div className="border-t border-[var(--border)] p-3">
        <button onClick={() => onPick(path)} className="w-full rounded-lg bg-[var(--accent)] px-3 py-3 font-medium text-black">
          Use this folder as the project root
        </button>
      </div>
    </div>
  );
}
