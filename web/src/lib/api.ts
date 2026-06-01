/** Thin REST client. The token is kept in localStorage and sent as a bearer header. */

const TOKEN_KEY = "web2cmd_token";
const SERVER_KEY = "web2cmd_server_url";

/**
 * Base URL of the Web2cmd server. Empty string = same origin (the normal case when the server
 * itself serves the app, e.g. the .exe or the dev proxy). A non-empty value is used when the
 * client is hosted separately (e.g. GitHub Pages) and must reach a server elsewhere.
 */
export function getServerBase(): string {
  return localStorage.getItem(SERVER_KEY) || "";
}
export function setServerBase(url: string) {
  const clean = url.trim().replace(/\/+$/, "");
  if (clean) localStorage.setItem(SERVER_KEY, clean);
  else localStorage.removeItem(SERVER_KEY);
}
/** WebSocket origin matching the server base (http→ws, https→wss); falls back to same origin. */
export function wsBase(): string {
  const base = getServerBase();
  // https://… → wss://… and http://… → ws://… (replacing the leading "http" with "ws").
  if (base) return base.replace(/^http/i, "ws");
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
export function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}
export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export interface SessionInfo {
  id: string;
  title: string;
  cwd: string;
  shell: string;
  createdAt: number;
  clients: number;
  alive: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
}

export interface ServerConfig {
  defaultCwd: string;
  platform: string;
  pathSep: string;
}

export interface ServerInfo {
  authMode: "off" | "password";
  exposure: "local" | "remote";
  fence: "on" | "off";
  identity: { publicKey: string; fingerprint: string };
}

export interface FenceDenial {
  root: string;
  target: string;
  at: number;
}

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(getServerBase() + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    clearToken();
    // Surface the server's actual reason (e.g. "invalid or expired pairing code") rather than a
    // generic "unauthorized" — otherwise an expired code looks like a broken pairing flow.
    throw new ApiError(401, (body as { error?: string }).error || "unauthorized");
  }
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error || res.statusText);
  return body as T;
}

export const api = {
  serverInfo: () => req<ServerInfo>("/api/server-info"),
  async login(password: string): Promise<string> {
    const { token } = await req<{ token: string }>("/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    setToken(token);
    return token;
  },
  /** Exchange a one-time pairing code (+ password when required) for a long-lived device token. */
  async pair(otp: string, password?: string): Promise<string> {
    const { token } = await req<{ token: string }>("/api/pair", {
      method: "POST",
      body: JSON.stringify({ otp, password }),
    });
    setToken(token);
    return token;
  },
  config: () => req<ServerConfig>("/api/config"),
  listSessions: () => req<{ sessions: SessionInfo[] }>("/api/sessions"),
  createSession: (body: {
    cwd: string;
    cols?: number;
    rows?: number;
    startClaude?: boolean;
    claudeMode?: "new" | "continue";
    title?: string;
  }) => req<SessionInfo>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),
  killSession: (id: string) =>
    req<{ killed: boolean }>(`/api/sessions/${id}`, { method: "DELETE" }),
  browse: (path?: string) =>
    req<{ path: string; entries: DirEntry[] }>(
      `/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  listProject: (root: string, rel = ".") =>
    req<{ rel: string; entries: DirEntry[] }>(
      `/api/fs/list?root=${encodeURIComponent(root)}&rel=${encodeURIComponent(rel)}`,
    ),
  readFile: (root: string, path: string) =>
    req<{ content: string }>(
      `/api/fs/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`,
    ),
  writeFile: (root: string, path: string, content: string) =>
    req<{ ok: boolean }>("/api/fs/write", {
      method: "POST",
      body: JSON.stringify({ root, path, content }),
    }),

  fenceDenials: () => req<{ denials: FenceDenial[] }>("/api/fence/denials"),
  fenceAllow: (root: string, path: string, mode: "once" | "always") =>
    req<{ ok: boolean }>("/api/fence/allow", {
      method: "POST",
      body: JSON.stringify({ root, path, mode }),
    }),
  installClaudeHook: (root: string) =>
    req<{ installed: boolean; alreadyPresent: boolean; settingsPath: string }>(
      "/api/fence/install-claude-hook",
      { method: "POST", body: JSON.stringify({ root }) },
    ),

  pushKey: () => req<{ publicKey: string }>("/api/push/key"),
  pushSubscribe: (subscription: PushSubscriptionJSON) =>
    req<{ ok: boolean; count: number }>("/api/push/subscribe", {
      method: "POST",
      body: JSON.stringify({ subscription }),
    }),
  pushUnsubscribe: (endpoint: string) =>
    req<{ ok: boolean; count: number }>("/api/push/unsubscribe", {
      method: "POST",
      body: JSON.stringify({ endpoint }),
    }),
  pushTest: () =>
    req<{ sent: number; pruned: number }>("/api/push/test", {
      method: "POST",
      body: JSON.stringify({}),
    }),
};

export { ApiError };
