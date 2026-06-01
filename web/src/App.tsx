import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  clearToken,
  getServerBase,
  getToken,
  setServerBase,
  type FenceDenial,
  type ServerConfig,
  type ServerInfo,
  type SessionInfo,
} from "./lib/api";
import { Login } from "./components/Login";
import { Pairing } from "./components/Pairing";
import { IdentityChanged } from "./components/IdentityChanged";
import { ServerUrl } from "./components/ServerUrl";
import { ProjectPicker } from "./components/ProjectPicker";
import { Terminal, type TerminalHandle } from "./components/Terminal";
import { TouchBar } from "./components/TouchBar";
import { FilesPanel } from "./components/FilesPanel";
import {
  disablePush,
  enablePush,
  getStatus as getPushStatus,
  registerServiceWorker,
  type PushStatus,
} from "./lib/push";

type Status = "connecting" | "open" | "closed";
type Panel = "terminal" | "editor";

export function App() {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [authed, setAuthed] = useState(false);
  const [pinnedFp, setPinnedFp] = useState<string | null>(null); // set only on identity mismatch
  const [needServer, setNeedServer] = useState(false); // hosted standalone, no reachable server
  const [serverErr, setServerErr] = useState<string | null>(null);
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [picking, setPicking] = useState(false);
  const [status, setStatus] = useState<Status>("connecting");
  const [panel, setPanel] = useState<Panel>("terminal");
  const [pushStatus, setPushStatus] = useState<PushStatus>("default");
  const [pushBusy, setPushBusy] = useState(false);
  const [fenceDenials, setFenceDenials] = useState<FenceDenial[]>([]);
  const [hookMsg, setHookMsg] = useState<string | null>(null);
  const termRef = useRef<TerminalHandle>(null);

  const active = sessions.find((s) => s.id === activeId) || null;

  const refresh = useCallback(async () => {
    try {
      const [cfg, ses] = await Promise.all([api.config(), api.listSessions()]);
      setConfig(cfg);
      setSessions(ses.sessions);
      return ses.sessions;
    } catch {
      // A 401 means our token is missing/stale. Whenever the server actually requires one
      // (remote ⇒ device token, or password mode ⇒ session token), drop back to the pairing/
      // login screen so the user can re-authenticate. (Local + auth off needs no token.)
      const needsToken = info?.exposure === "remote" || info?.authMode === "password";
      if (needsToken) {
        clearToken();
        setAuthed(false);
      }
      return [];
    }
  }, [info]);

  const applyInfo = useCallback((si: ServerInfo) => {
    setInfo(si);
    const PIN_KEY = "web2cmd_server_fp";
    const pinned = localStorage.getItem(PIN_KEY);
    if (pinned && pinned !== si.identity.fingerprint) {
      // Identity changed — block until the user consciously re-pairs (see IdentityChanged).
      setPinnedFp(pinned);
      return;
    }
    if (!pinned) localStorage.setItem(PIN_KEY, si.identity.fingerprint); // TOFU
    // Open only when local + auth off. Remote always needs a (device) token; password mode needs
    // a session/device token — in both cases we're authed only if we already hold one.
    const open = si.authMode === "off" && si.exposure === "local";
    setAuthed(open || Boolean(getToken()));
  }, []);

  // Bootstrap: reach the server (same origin when it serves the app, or a configured URL when the
  // client is hosted standalone), then learn its auth mode + pinned identity.
  const connect = useCallback(async () => {
    setServerErr(null);
    try {
      const si = await api.serverInfo();
      setNeedServer(false);
      applyInfo(si);
    } catch {
      // No server reachable. If a URL is configured it's wrong/down; otherwise we're likely
      // hosted standalone (e.g. Pages) and need the user to point us at their server.
      if (getServerBase()) setServerErr("Couldn't reach that server — check the URL and that it's running.");
      setNeedServer(true);
    }
  }, [applyInfo]);

  useEffect(() => {
    connect();
  }, [connect]);

  useEffect(() => {
    if (!authed) return;
    // a notification tap deep-links to a specific session via ?session=<id>
    const deepLink = new URLSearchParams(location.search).get("session");
    refresh().then((ses) => {
      const target = deepLink && ses.find((s) => s.id === deepLink) ? deepLink : null;
      if (target) {
        setActiveId(target);
        history.replaceState(null, "", location.pathname);
      } else if (ses.length > 0) setActiveId((cur) => cur ?? ses[0].id);
      else setPicking(true);
    });
    // register the service worker and reflect current push status
    registerServiceWorker().then(() => getPushStatus().then(setPushStatus));
  }, [authed, refresh]);

  const togglePush = async () => {
    setPushBusy(true);
    try {
      setPushStatus(pushStatus === "enabled" ? await disablePush() : await enablePush());
    } finally {
      setPushBusy(false);
    }
  };

  const loadDenials = useCallback(async () => {
    try {
      setFenceDenials((await api.fenceDenials()).denials);
    } catch {
      /* ignore */
    }
  }, []);

  // Refresh the fence denial list whenever the drawer opens.
  useEffect(() => {
    if (drawer && info?.fence === "on") loadDenials();
  }, [drawer, info, loadDenials]);

  const approveFence = async (d: FenceDenial, mode: "once" | "always") => {
    await api.fenceAllow(d.root, d.target, mode);
    await loadDenials();
  };

  const installHook = async () => {
    if (!active) return;
    setHookMsg("Installing…");
    try {
      const r = await api.installClaudeHook(active.cwd);
      setHookMsg(r.alreadyPresent ? "Already installed." : "Installed — restart Claude to apply.");
    } catch (e) {
      setHookMsg("Failed: " + (e as Error).message);
    }
  };

  const startSession = async (cwd: string, claudeMode: "off" | "new" | "continue") => {
    const info = await api.createSession({
      cwd,
      claudeMode: claudeMode === "off" ? undefined : claudeMode,
      title: cwd.split(/[\\/]/).pop(),
    });
    await refresh();
    setActiveId(info.id);
    setPicking(false);
    setDrawer(false);
    setPanel("terminal");
  };

  const killSession = async (id: string) => {
    await api.killSession(id);
    const ses = await refresh();
    if (activeId === id) setActiveId(ses[0]?.id ?? null);
  };

  const logout = () => {
    clearToken();
    setAuthed(false);
    setActiveId(null);
    setSessions([]);
  };

  if (needServer)
    return (
      <ServerUrl
        current={getServerBase()}
        error={serverErr}
        onSet={(url) => {
          setServerBase(url);
          connect();
        }}
      />
    );
  if (!info)
    return (
      <div className="flex h-full items-center justify-center text-sm text-gray-500">
        Connecting…
      </div>
    );
  if (pinnedFp)
    return (
      <IdentityChanged
        info={info}
        pinned={pinnedFp}
        onReset={() => {
          clearToken();
          localStorage.setItem("web2cmd_server_fp", info.identity.fingerprint);
          setPinnedFp(null);
          setAuthed(info.authMode === "off" && info.exposure === "local");
        }}
      />
    );
  if (!authed)
    return info.exposure === "remote" ? (
      <Pairing info={info} onPaired={() => setAuthed(true)} />
    ) : (
      <Login onAuthed={() => setAuthed(true)} />
    );

  const statusColor =
    status === "open" ? "bg-green-400" : status === "connecting" ? "bg-yellow-400" : "bg-red-400";

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-2">
        <button
          onClick={() => setDrawer(true)}
          className="rounded-md border border-[var(--border)] px-2.5 py-1.5 text-lg leading-none"
          aria-label="Sessions"
        >
          ☰
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{active ? active.title : "Web2cmd"}</div>
          <div className="truncate text-xs text-gray-500">{active?.cwd ?? "no session"}</div>
        </div>
        {active && (
          <div className="flex overflow-hidden rounded-md border border-[var(--border)] text-xs">
            <button
              onClick={() => setPanel("terminal")}
              className={panel === "terminal" ? "bg-[var(--accent)] px-3 py-1.5 text-black" : "px-3 py-1.5"}
            >
              Term
            </button>
            <button
              onClick={() => setPanel("editor")}
              className={panel === "editor" ? "bg-[var(--accent)] px-3 py-1.5 text-black" : "px-3 py-1.5"}
            >
              Files
            </button>
          </div>
        )}
        <span className={`ml-1 h-2.5 w-2.5 rounded-full ${statusColor}`} title={status} />
      </header>

      {/* Main */}
      <main className="relative min-h-0 flex-1">
        {picking ? (
          <ProjectPicker
            startCwd={config?.defaultCwd ?? "/"}
            onStart={startSession}
            onCancel={sessions.length > 0 ? () => setPicking(false) : undefined}
          />
        ) : active ? (
          panel === "terminal" ? (
            <div className="h-full bg-[#0b0e14] p-1">
              <Terminal key={active.id} ref={termRef} sessionId={active.id} onStatus={setStatus} />
            </div>
          ) : (
            <FilesPanel root={active.cwd} />
          )
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <p className="text-gray-400">No active session.</p>
            <button
              onClick={() => setPicking(true)}
              className="rounded-lg bg-[var(--accent)] px-4 py-2 font-medium text-black"
            >
              New session
            </button>
          </div>
        )}
      </main>

      {/* Touch toolbar (terminal only) */}
      {active && panel === "terminal" && !picking && (
        <TouchBar
          send={(d) => termRef.current?.sendData(d)}
          onCopy={() => termRef.current?.copySelection()}
          onSelectToggle={(on) => termRef.current?.setSelectMode(on)}
        />
      )}

      {/* Sessions drawer */}
      {drawer && (
        <div className="absolute inset-0 z-20 flex" onClick={() => setDrawer(false)}>
          <div
            className="flex h-full w-72 max-w-[80%] flex-col border-r border-[var(--border)] bg-[var(--panel)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[var(--border)] p-3">
              <span className="font-medium">Sessions</span>
              <button onClick={refresh} className="text-xs text-gray-400">
                Refresh
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {sessions.map((s) => (
                <div
                  key={s.id}
                  className={`flex items-center gap-2 border-b border-[var(--border)]/40 px-3 py-3 ${
                    s.id === activeId ? "bg-[#1a2030]" : ""
                  }`}
                >
                  <button
                    onClick={() => {
                      setActiveId(s.id);
                      setDrawer(false);
                      setPicking(false);
                    }}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="truncate text-sm">{s.title}</div>
                    <div className="truncate text-xs text-gray-500">
                      {s.alive ? `${s.clients} client(s)` : "exited"} · {s.cwd}
                    </div>
                  </button>
                  <button
                    onClick={() => killSession(s.id)}
                    className="rounded-md px-2 py-1 text-xs text-red-400"
                  >
                    Kill
                  </button>
                </div>
              ))}
              {sessions.length === 0 && (
                <p className="p-4 text-sm text-gray-500">No sessions yet.</p>
              )}
            </div>
            <div className="border-t border-[var(--border)] p-3">
              <button
                onClick={() => {
                  setPicking(true);
                  setDrawer(false);
                }}
                className="mb-3 w-full rounded-lg bg-[var(--accent)] px-3 py-2.5 font-medium text-black"
              >
                + New session
              </button>

              {/* Push notifications */}
              <div className="mb-3 rounded-lg border border-[var(--border)] p-2.5">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-sm font-medium">🔔 Notifications</span>
                  <span className="text-xs text-gray-500">
                    {pushStatus === "enabled"
                      ? "On"
                      : pushStatus === "denied"
                        ? "Blocked"
                        : pushStatus === "unsupported"
                          ? "N/A"
                          : "Off"}
                  </span>
                </div>
                <p className="mb-2 text-xs text-gray-500">
                  Get pinged when Claude is waiting for a confirmation.
                </p>
                {pushStatus === "unsupported" ? (
                  <p className="text-xs text-yellow-500">
                    Needs HTTPS. On iPhone, add to Home Screen first.
                  </p>
                ) : pushStatus === "denied" ? (
                  <p className="text-xs text-yellow-500">
                    Blocked — enable notifications for this site in browser settings.
                  </p>
                ) : (
                  <div className="flex gap-2">
                    <button
                      onClick={togglePush}
                      disabled={pushBusy}
                      className="flex-1 rounded-md border border-[var(--border)] bg-[#1a2030] px-3 py-2 text-sm disabled:opacity-50"
                    >
                      {pushBusy ? "…" : pushStatus === "enabled" ? "Disable" : "Enable"}
                    </button>
                    {pushStatus === "enabled" && (
                      <button
                        onClick={() => api.pushTest()}
                        className="rounded-md border border-[var(--border)] px-3 py-2 text-sm text-gray-300"
                      >
                        Test
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Server URL (only when hosted standalone, i.e. a base URL is configured) */}
              {getServerBase() && (
                <div className="mb-3 rounded-lg border border-[var(--border)] p-2.5">
                  <div className="mb-1 text-sm font-medium">🖥️ Server</div>
                  <div className="mb-2 break-all text-xs text-gray-500">{getServerBase()}</div>
                  <button
                    onClick={() => {
                      setDrawer(false);
                      setNeedServer(true);
                    }}
                    className="w-full rounded-md border border-[var(--border)] px-2 py-2 text-xs text-gray-300"
                  >
                    Change server URL
                  </button>
                </div>
              )}

              {/* Project fence */}
              {info?.fence === "on" && (
                <div className="mb-3 rounded-lg border border-[var(--border)] p-2.5">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-sm font-medium">🚧 Project fence</span>
                    <button onClick={loadDenials} className="text-xs text-gray-400">
                      Refresh
                    </button>
                  </div>
                  <p className="mb-2 text-xs text-gray-500">
                    Blocked attempts to leave the project root. Approve to allow, then re-run the
                    command.
                  </p>
                  {fenceDenials.length === 0 ? (
                    <p className="text-xs text-gray-600">Nothing blocked.</p>
                  ) : (
                    <div className="space-y-2">
                      {fenceDenials.slice(0, 6).map((d, i) => (
                        <div key={i} className="rounded-md border border-[var(--border)] bg-[#1a2030] p-2">
                          <div className="mb-1 break-all text-xs text-gray-300">{d.target}</div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => approveFence(d, "once")}
                              className="flex-1 rounded border border-[var(--border)] px-2 py-1 text-xs"
                            >
                              Allow once
                            </button>
                            <button
                              onClick={() => approveFence(d, "always")}
                              className="flex-1 rounded border border-[var(--border)] px-2 py-1 text-xs"
                            >
                              Always
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {active && (
                    <button
                      onClick={installHook}
                      className="mt-2 w-full rounded-md border border-[var(--border)] px-2 py-2 text-xs text-gray-300"
                    >
                      Protect Claude in this project
                    </button>
                  )}
                  {hookMsg && <p className="mt-1 text-xs text-gray-500">{hookMsg}</p>}
                </div>
              )}

              {(info?.authMode === "password" || info?.exposure === "remote") && (
                <button
                  onClick={logout}
                  className="w-full rounded-lg border border-[var(--border)] px-3 py-2 text-sm text-gray-300"
                >
                  {info?.authMode === "off" ? "Unpair device" : "Sign out"}
                </button>
              )}
            </div>
          </div>
          <div className="flex-1" />
        </div>
      )}
    </div>
  );
}
