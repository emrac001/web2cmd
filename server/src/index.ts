/**
 * Web2cmd server entrypoint.
 *
 * Serves the built web app, exposes a small REST API (auth, sessions, filesystem), and runs
 * a WebSocket endpoint (/ws) that bridges browser terminals to shared PTY sessions running
 * on this machine. Every REST call and the WS upgrade require a valid token.
 */
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { URL } from "node:url";

import { loadConfig, repoRoot } from "./config.js";
import {
  checkAccess,
  clearPassword,
  extractToken,
  isPasswordConfigured,
  issueToken,
  setPassword,
  verifyPassword,
  verifyToken,
} from "./auth.js";
import { ensureIdentity, fingerprint } from "./identity.js";
import { currentOtp, rotateOtp, verifyOtp } from "./pairing.js";
import { FenceManager, installClaudeHook, writeFenceScript } from "./fence.js";
import { DeviceManager } from "./devices.js";
import { TunnelManager, type TunnelProvider } from "./tunnel.js";
import { timingSafeEqual } from "node:crypto";
import { SessionManager } from "./sessions.js";
import { browseDir, listProject, readProjectFile, writeProjectFile } from "./files.js";
import { PushManager } from "./push.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cfg = loadConfig();

// Project fence: always initialized (checker + generated PowerShell guard script + Claude hook
// path) so it can be toggled at runtime; `fenceEnabled` controls whether new sessions use it.
const fence = new FenceManager(cfg.dataDir);
const fenceHookScript = process.env.WEB2CMD_FENCE_HOOK
  ? resolve(process.env.WEB2CMD_FENCE_HOOK)
  : join(repoRoot, "scripts", "fence-hook.mjs");
const fenceSpawn = {
  scriptPath: writeFenceScript(cfg.dataDir),
  secret: fence.secret,
  url: `http://127.0.0.1:${cfg.port}`,
};
let fenceEnabled = cfg.fence === "on";

const sessions = new SessionManager(cfg.dataDir, fenceEnabled ? fenceSpawn : null);
const push = new PushManager(cfg);
const devices = new DeviceManager(cfg.dataDir);
const tunnel = new TunnelManager(cfg.port);

// Exposure is dynamic: while a server-managed tunnel is running the server is "remote" (so pairing
// is required), otherwise it falls back to the static mode it booted with.
const staticExposure = cfg.exposure;

// A request is from the operator (admin) only if it hit the loopback interface directly — NOT
// proxied in through the tunnel (cloudflared runs on localhost too, but adds forwarding headers).
function isAdminReq(req: { socket: { remoteAddress?: string }; headers: Record<string, unknown> }): boolean {
  const ip = req.socket.remoteAddress || "";
  const loopback = ip === "127.0.0.1" || ip === "::1" || ip.endsWith(":127.0.0.1");
  const forwarded =
    req.headers["x-forwarded-for"] || req.headers["cf-connecting-ip"] || req.headers["x-real-ip"];
  return loopback && !forwarded;
}

// When a session looks like it's waiting for a confirmation, push to subscribed phones.
sessions.setWaitingHandler((info, snippet) => {
  push
    .notifyAll({
      title: `Claude needs you — ${info.title}`,
      body: snippet,
      sessionId: info.id,
      tag: info.id,
    })
    .catch(() => {});
});

// First-boot / rotate password from env if provided.
if (process.env.WEB2CMD_PASSWORD) {
  setPassword(cfg, process.env.WEB2CMD_PASSWORD);
  console.log("[web2cmd] password set from WEB2CMD_PASSWORD env");
}

// Stable server identity — generated once, pinned by clients (TOFU). Exposed via /api/server-info.
const identity = ensureIdentity(cfg);
const identityFp = fingerprint(identity.publicKey);

// Auth is optional in v2. If password mode is selected but no password is set, we can't gate.
if (cfg.authMode === "password" && !isPasswordConfigured(cfg)) {
  console.error(
    "\n[web2cmd] auth=password but no password is configured. Set one:\n" +
      "  pnpm --filter @web2cmd/server set-password -- <your-password>\n" +
      "  (or start once with WEB2CMD_PASSWORD=<your-password>)\n" +
      "  — or run with WEB2CMD_AUTH=off for localhost/LAN use.\n",
  );
  process.exit(1);
}

// Safety coupling: an unauthenticated terminal may only be served locally. Anything remote/
// tunnelled is gated by device pairing — a fresh client must enter the OTP printed below before
// it can reach the API. We mint the first code here so it's on screen as the tunnel comes up.
function printPairingCode(): void {
  const { code, expiresInMs } = currentOtp();
  const mins = Math.round(expiresInMs / 60000);
  console.log(
    `\n[web2cmd] ── PAIRING CODE: ${code} ──  (valid ~${mins} min)\n` +
      "[web2cmd] Enter this on the client to pair this device.\n",
  );
}

const webDist = process.env.WEB2CMD_WEB_DIST
  ? resolve(process.env.WEB2CMD_WEB_DIST)
  : resolve(__dirname, "..", "..", "web", "dist");
const hasWebBuild = existsSync(join(webDist, "index.html"));

const app = Fastify({ logger: false });

// Tolerate empty bodies on application/json POSTs (no-body admin actions like regenerate-code /
// revoke would otherwise fail with FST_ERR_CTP_EMPTY_JSON_BODY when a client sends the JSON type).
app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_req, body: string, done) => {
    if (!body) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch (e) {
      done(e as Error);
    }
  },
);

// ---- CORS --------------------------------------------------------------------------------
// Lets the client be hosted on a *different* origin (e.g. GitHub Pages) and still reach this
// server over its tunnel/LAN URL. Auth is via Bearer token (not cookies), so reflecting the
// request origin is not a CSRF risk — a malicious page still can't read another origin's token.
// Restrict with WEB2CMD_ALLOW_ORIGIN (comma-separated) if you want an explicit allowlist.
const corsAllowList = process.env.WEB2CMD_ALLOW_ORIGIN
  ? process.env.WEB2CMD_ALLOW_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean)
  : null;
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (origin && (!corsAllowList || corsAllowList.includes(origin))) {
    reply.header("access-control-allow-origin", origin);
    reply.header("vary", "Origin");
    reply.header("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
    reply.header("access-control-allow-headers", "authorization, content-type");
    reply.header("access-control-max-age", "86400");
  }
  if (req.method === "OPTIONS") reply.code(204).send(); // preflight — short-circuit before auth
});

// ---- auth gate for the REST API -------------------------------------------------------
// Unauthenticated bootstrap endpoints; everything else goes through checkAccess.
const PUBLIC_PATHS = new Set([
  "/api/login",
  "/api/pair",
  "/api/health",
  "/api/server-info",
  "/api/fence/check", // called by the local shell, authenticated by the fence secret instead
]);
app.addHook("onRequest", async (req, reply) => {
  if (!req.url.startsWith("/api/")) return; // static assets are public
  const path = req.url.split("?")[0];
  if (PUBLIC_PATHS.has(path)) return;
  if (path.startsWith("/api/admin/")) return; // admin routes self-gate to localhost (isAdminReq)
  const token = extractToken(req.headers.authorization, undefined);
  if (!checkAccess(cfg, token, (id) => devices.isValid(id))) {
    reply.code(401).send({ error: "unauthorized" });
  }
});

// ---- REST API -------------------------------------------------------------------------
app.get("/api/health", async () => ({ ok: true }));

// Public bootstrap: lets the client learn whether to log in and pin the server's identity.
app.get("/api/server-info", async (req) => ({
  authMode: cfg.authMode,
  exposure: cfg.exposure,
  fence: fenceEnabled ? "on" : "off",
  // Which face to show: the operator (localhost, not via the tunnel) is the admin.
  role: isAdminReq(req) ? "admin" : "client",
  identity: { publicKey: identity.publicKey, fingerprint: identityFp },
}));

app.post<{ Body: { password?: string } }>("/api/login", async (req, reply) => {
  if (cfg.authMode === "off") {
    return reply.code(400).send({ error: "auth is disabled on this server" });
  }
  const { password } = req.body ?? {};
  if (!password || !verifyPassword(cfg, password)) {
    return reply.code(401).send({ error: "invalid password" });
  }
  return { token: issueToken(cfg, "session") };
});

// Device pairing: exchange a valid OTP (+ the password, when auth=password) for a device token
// bound to a new registry record (so the operator can later list/revoke/cap it).
app.post<{ Body: { otp?: string; password?: string; displayName?: string } }>(
  "/api/pair",
  async (req, reply) => {
    const { otp, password, displayName } = req.body ?? {};
    if (!otp || !verifyOtp(otp)) {
      return reply.code(401).send({ error: "invalid or expired pairing code" });
    }
    if (cfg.authMode === "password" && !(password && verifyPassword(cfg, password))) {
      return reply.code(401).send({ error: "password required" });
    }
    let device;
    try {
      device = devices.create(displayName);
    } catch {
      return reply.code(403).send({ error: "device limit reached — ask the operator to free a slot" });
    }
    // Single-use: burn the code now and surface a fresh one on the server console.
    rotateOtp();
    printPairingCode();
    return { token: issueToken(cfg, "device", device.id), deviceId: device.id };
  },
);

// A client sets its own display name (used as its typing-lock identity).
app.post<{ Body: { name?: string } }>("/api/device/name", async (req, reply) => {
  const payload = verifyToken(cfg, extractToken(req.headers.authorization, undefined));
  if (!payload?.deviceId) return reply.code(400).send({ error: "no device identity on this token" });
  devices.setName(payload.deviceId, String(req.body?.name ?? ""));
  return { ok: true, displayName: devices.get(payload.deviceId)?.displayName ?? null };
});

app.get("/api/config", async () => ({
  defaultCwd: cfg.defaultCwd,
  platform: process.platform,
  pathSep: process.platform === "win32" ? "\\" : "/",
}));

app.get("/api/sessions", async () => ({ sessions: sessions.list() }));

app.post<{
  Body: {
    cwd?: string;
    cols?: number;
    rows?: number;
    startClaude?: boolean;
    claudeMode?: "new" | "continue";
    title?: string;
  };
}>("/api/sessions", async (req, reply) => {
  const { cwd, cols, rows, startClaude, claudeMode, title } = req.body ?? {};
  if (!cwd || !existsSync(cwd)) {
    return reply.code(400).send({ error: "cwd does not exist" });
  }
  // node-pty cannot pass initial keystrokes; we spawn the shell, then write the command.
  const info = sessions.create({ cwd, cols, rows, title });
  // claudeMode takes precedence; startClaude (legacy) means "new".
  const mode = claudeMode ?? (startClaude ? "new" : undefined);
  if (mode) {
    const s = sessions.get(info.id);
    // `claude --continue` resumes the most recent conversation in this folder (req #6 resume).
    const cmd = mode === "continue" ? "claude --continue\r" : "claude\r";
    // small delay so the shell prompt is ready before we type
    setTimeout(() => s?.write(cmd), 600);
  }
  return info;
});

app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req) => ({
  killed: sessions.kill(req.params.id),
}));

// ---- filesystem (project picker + editor) --------------------------------------------
app.get<{ Querystring: { path?: string } }>("/api/fs/browse", async (req, reply) => {
  try {
    return await browseDir(req.query.path || cfg.defaultCwd);
  } catch (e) {
    return reply.code(400).send({ error: String((e as Error).message) });
  }
});

app.get<{ Querystring: { root?: string; rel?: string } }>("/api/fs/list", async (req, reply) => {
  if (!req.query.root) return reply.code(400).send({ error: "root required" });
  try {
    return await listProject(req.query.root, req.query.rel || ".");
  } catch (e) {
    return reply.code(400).send({ error: String((e as Error).message) });
  }
});

app.get<{ Querystring: { root?: string; path?: string } }>("/api/fs/read", async (req, reply) => {
  if (!req.query.root || !req.query.path)
    return reply.code(400).send({ error: "root and path required" });
  try {
    return { content: await readProjectFile(req.query.root, req.query.path) };
  } catch (e) {
    return reply.code(400).send({ error: String((e as Error).message) });
  }
});

app.post<{ Body: { root?: string; path?: string; content?: string } }>(
  "/api/fs/write",
  async (req, reply) => {
    const { root, path, content } = req.body ?? {};
    if (!root || !path || content === undefined)
      return reply.code(400).send({ error: "root, path, content required" });
    try {
      await writeProjectFile(root, path, content);
      return { ok: true };
    } catch (e) {
      return reply.code(400).send({ error: String((e as Error).message) });
    }
  },
);

// ---- web push --------------------------------------------------------------------------
app.get("/api/push/key", async () => ({ publicKey: push.publicKey }));

app.post<{ Body: { subscription?: unknown } }>("/api/push/subscribe", async (req, reply) => {
  const sub = req.body?.subscription as any;
  if (!sub?.endpoint) return reply.code(400).send({ error: "invalid subscription" });
  push.subscribe(sub);
  return { ok: true, count: push.count() };
});

app.post<{ Body: { endpoint?: string } }>("/api/push/unsubscribe", async (req) => {
  if (req.body?.endpoint) push.unsubscribe(req.body.endpoint);
  return { ok: true, count: push.count() };
});

app.post("/api/push/test", async () => {
  const res = await push.notifyAll({
    title: "Web2cmd",
    body: "Push notifications are working 🎉",
  });
  return res;
});

// ---- project fence ---------------------------------------------------------------------
function secretOk(provided: unknown): boolean {
  if (!fence || typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(fence.secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Called by the local PowerShell fence script before every cd. Authenticated by the fence
// secret (not the user token), since it's the server's own shell asking over localhost.
app.post<{ Body: { root?: string; target?: string; secret?: string } }>(
  "/api/fence/check",
  async (req, reply) => {
    if (!fenceEnabled) return { allowed: true, reason: "fence-off" };
    const { root, target, secret } = req.body ?? {};
    if (!secretOk(secret)) return reply.code(403).send({ error: "bad fence secret" });
    if (!root || !target) return reply.code(400).send({ error: "root and target required" });
    return fence.check(root, target);
  },
);

app.get("/api/fence/denials", async () => ({ denials: fence ? fence.listDenials() : [] }));

app.post<{ Body: { root?: string; path?: string; mode?: "once" | "always" } }>(
  "/api/fence/allow",
  async (req, reply) => {
    if (!fence) return reply.code(400).send({ error: "fence is disabled" });
    const { root, path, mode } = req.body ?? {};
    if (!root || !path) return reply.code(400).send({ error: "root and path required" });
    fence.grant(root, path, mode === "once" ? "once" : "always");
    return { ok: true };
  },
);

// Opt-in: install the Claude PreToolUse fence hook into a project's .claude/settings.json.
app.post<{ Body: { root?: string } }>("/api/fence/install-claude-hook", async (req, reply) => {
  const { root } = req.body ?? {};
  if (!root) return reply.code(400).send({ error: "root required" });
  try {
    return installClaudeHook(root, fenceHookScript);
  } catch (e) {
    return reply.code(400).send({ error: String((e as Error).message) });
  }
});

// ---- admin (operator) ------------------------------------------------------------------
// Reachable only from the loopback interface (the operator at the machine), NOT through the
// tunnel. The auth gate skips /api/admin/*; each handler enforces isAdminReq. Phase B builds the
// full operator console on top of these.
function requireAdmin(req: any, reply: any): boolean {
  if (!isAdminReq(req)) {
    reply.code(403).send({ error: "admin only — available on the server machine (localhost)" });
    return false;
  }
  return true;
}

app.get("/api/admin/devices", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return { devices: devices.list(), maxDevices: devices.getMax(), active: devices.activeCount() };
});

app.post<{ Params: { id: string } }>("/api/admin/devices/:id/revoke", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return { revoked: devices.revoke(req.params.id) };
});

app.post<{ Body: { max?: number } }>("/api/admin/max-devices", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const n = Number(req.body?.max);
  if (!Number.isFinite(n) || n < 0) return reply.code(400).send({ error: "max must be >= 0 (0 = unlimited)" });
  devices.setMax(n);
  return { maxDevices: devices.getMax() };
});

// Mint a fresh pairing code on demand (e.g. when the old one expired) — the operator reads it off
// the response (and it's also printed to the console).
app.post("/api/admin/regenerate-code", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  rotateOtp();
  printPairingCode();
  return { code: currentOtp().code, expiresInMs: currentOtp().expiresInMs };
});

app.get("/api/admin/code", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { code, expiresInMs } = currentOtp();
  return { code, expiresInMs };
});

// One-shot snapshot for the operator Console.
app.get("/api/admin/status", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const { code, expiresInMs } = currentOtp();
  return {
    authMode: cfg.authMode,
    exposure: cfg.exposure,
    fence: fenceEnabled,
    root: cfg.defaultCwd,
    identity: identityFp,
    tunnel: tunnel.getStatus(),
    pairCode: { code, expiresInMs },
    devices: { active: devices.activeCount(), max: devices.getMax() },
    hasPassword: isPasswordConfigured(cfg),
  };
});

// Admin-only: set or clear the login password.
app.post<{ Body: { password?: string | null } }>("/api/admin/password", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const pw = req.body?.password;
  if (pw) {
    setPassword(cfg, pw);
  } else {
    clearPassword(cfg);
    if (cfg.authMode === "password") cfg.authMode = "off"; // can't gate without a password
  }
  return { hasPassword: isPasswordConfigured(cfg), authMode: cfg.authMode };
});

// Admin-only: turn the password gate on/off at runtime.
app.post<{ Body: { mode?: "off" | "password" } }>("/api/admin/auth", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const mode = req.body?.mode;
  if (mode !== "off" && mode !== "password") {
    return reply.code(400).send({ error: "mode must be 'off' or 'password'" });
  }
  if (mode === "password" && !isPasswordConfigured(cfg)) {
    return reply.code(400).send({ error: "set a password first" });
  }
  cfg.authMode = mode;
  return { authMode: cfg.authMode };
});

// Which tunnel tools are installed (for the Console picker + install guidance).
app.get("/api/admin/tunnels", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return { providers: tunnel.discover(), current: tunnel.getStatus() };
});

app.post<{ Body: { provider?: TunnelProvider } }>("/api/admin/tunnel/start", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const provider = req.body?.provider;
  if (provider !== "cloudflared" && provider !== "ngrok") {
    return reply.code(400).send({ error: "provider must be 'cloudflared' or 'ngrok'" });
  }
  try {
    const status = await tunnel.start(provider);
    cfg.exposure = "remote"; // a public tunnel is up ⇒ require pairing
    rotateOtp();
    printPairingCode();
    return { ...status, pairCode: currentOtp().code };
  } catch (e) {
    return reply.code(400).send({ error: String((e as Error).message) });
  }
});

app.post("/api/admin/tunnel/stop", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  await tunnel.stop();
  cfg.exposure = staticExposure; // back to how it booted
  return tunnel.getStatus();
});

// Set the folder the project picker opens at (the "client root").
app.post<{ Body: { path?: string } }>("/api/admin/root", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  const path = req.body?.path;
  if (!path || !existsSync(path)) return reply.code(400).send({ error: "path does not exist" });
  cfg.defaultCwd = resolve(path);
  return { root: cfg.defaultCwd };
});

// Toggle the project fence for sessions created from now on.
app.post<{ Body: { on?: boolean } }>("/api/admin/fence", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  fenceEnabled = Boolean(req.body?.on);
  sessions.setFence(fenceEnabled ? fenceSpawn : null);
  return { fence: fenceEnabled };
});

// Sessions + their connected clients + who holds the typing lock (for the console).
app.get("/api/admin/sessions", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return { sessions: sessions.adminList() };
});

// Release the typing lock on a session (freezes the previous holder briefly).
app.post<{ Params: { id: string } }>("/api/admin/sessions/:id/release", async (req, reply) => {
  if (!requireAdmin(req, reply)) return;
  return { released: sessions.releaseControl(req.params.id) };
});

// Hand the typing lock to a specific client.
app.post<{ Params: { id: string }; Body: { clientId?: string } }>(
  "/api/admin/sessions/:id/control",
  async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    if (!req.body?.clientId) return reply.code(400).send({ error: "clientId required" });
    return { ok: sessions.transferControl(req.params.id, req.body.clientId) };
  },
);

// ---- static web app (SPA) -------------------------------------------------------------
// Registered inside start() (before app.ready()) so this module has no top-level await — which
// keeps it bundleable into the CJS single-file .exe.
async function registerStatic(): Promise<void> {
  if (hasWebBuild) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      return reply.sendFile("index.html");
    });
  } else {
    app.get("/", async (_req, reply) => {
      reply
        .code(200)
        .type("text/plain")
        .send(
          "Web2cmd API is running, but the web app has not been built yet.\n" +
            "Run `pnpm --filter @web2cmd/web build` (or `pnpm dev:web` for development).",
        );
    });
  }
}

// ---- WebSocket terminal bridge --------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WebSocket, sessionId: string, deviceId?: string, label?: string) => {
  const session = sessions.get(sessionId);
  if (!session) {
    ws.send(JSON.stringify({ type: "error", message: "session not found" }));
    ws.close();
    return;
  }

  const clientId = randomUUID();
  session.attach({
    id: clientId,
    cols: 80,
    rows: 24,
    label: label || "Guest",
    deviceId,
    send: (data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "output", data }));
    },
    sendControl: (msg) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    },
  });

  ws.send(JSON.stringify({ type: "ready", sessionId, clientId }));

  ws.on("message", (raw) => {
    let msg: { type?: string; data?: string; cols?: number; rows?: number };
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      session.handleInput(clientId, msg.data); // gated by the single-typist lock
    } else if (msg.type === "release") {
      session.selfRelease(clientId);
    } else if (msg.type === "resize" && msg.cols && msg.rows) {
      session.resizeClient(clientId, msg.cols, msg.rows);
    }
  });

  ws.on("close", () => {
    session.detach(clientId);
    sessions.reap();
  });
});

// When launched as the .exe, replace a previous Web2cmd instance still holding our port (so
// double-clicking again "just works" instead of opening the stale one). Only kills a process that
// is actually a Web2cmd server (verified via /api/health) — never an unrelated app on the port.
async function takeOverPort(): Promise<void> {
  if (process.env.WEB2CMD_AUTO_OPEN !== "1" || process.platform !== "win32") return;
  let ours = false;
  try {
    const r = await fetch(`http://127.0.0.1:${cfg.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    ours = ((await r.json()) as { ok?: boolean }).ok === true;
  } catch {
    return; // nothing listening → port is free for us
  }
  if (!ours) return; // a non-Web2cmd app holds the port; let listen() fail with a clear error
  try {
    const out = execSync("netstat -ano", { encoding: "utf8", windowsHide: true });
    const pids = new Set<string>();
    for (const line of out.split(/\r?\n/)) {
      if (/LISTENING/i.test(line) && new RegExp(`[:.]${cfg.port}\\b`).test(line)) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && /^\d+$/.test(pid) && pid !== String(process.pid)) pids.add(pid);
      }
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /PID ${pid} /F /T`, { stdio: "ignore" }); // /T also stops its tunnel child
      } catch {
        /* ignore */
      }
    }
    if (pids.size) console.log(`[web2cmd] replaced a previous instance on port ${cfg.port}`);
  } catch {
    /* ignore */
  }
  for (let i = 0; i < 25; i++) {
    try {
      await fetch(`http://127.0.0.1:${cfg.port}/api/health`, { signal: AbortSignal.timeout(700) });
    } catch {
      return; // connection refused → port freed
    }
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function start() {
  await takeOverPort();
  await registerStatic();
  await app.ready();
  app.server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", `http://${request.headers.host}`);
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const token = url.searchParams.get("token");
    if (!checkAccess(cfg, token, (id) => devices.isValid(id))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    const sessionId = url.searchParams.get("session") || "";
    // Resolve the device identity for the typing-lock label.
    const payload = verifyToken(cfg, token);
    const deviceId = payload?.deviceId;
    if (deviceId) devices.touch(deviceId);
    const dev = deviceId ? devices.get(deviceId) : undefined;
    const label = dev?.displayName || (deviceId ? `Device ${deviceId.slice(0, 4)}` : "Local");
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, sessionId, deviceId, label);
    });
  });

  await app.listen({ host: cfg.host, port: cfg.port });
  // Packaged .exe: pop the operator Console in the default browser (WEB2CMD_NO_OPEN=1 to disable).
  if (
    process.env.WEB2CMD_AUTO_OPEN === "1" &&
    process.env.WEB2CMD_NO_OPEN !== "1" &&
    process.platform === "win32"
  ) {
    try {
      const url = `http://localhost:${cfg.port}`;
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } catch {
      /* no browser — operator can open the URL manually */
    }
  }
  console.log(`\n[web2cmd] listening on http://${cfg.host}:${cfg.port}`);
  console.log(`[web2cmd] auth: ${cfg.authMode}  ·  exposure: ${cfg.exposure}  ·  fence: ${cfg.fence}`);
  console.log(`[web2cmd] identity: ${identityFp}`);
  if (cfg.exposure === "remote") {
    // Remote clients must pair — show the code, and let the operator press Enter for a fresh one.
    printPairingCode();
    if (process.stdin.isTTY) {
      process.stdin.on("data", () => {
        rotateOtp();
        printPairingCode();
      });
    }
  } else if (cfg.authMode === "off") {
    console.log("[web2cmd] ⚠ auth is OFF — anyone who can reach this address gets a shell.");
  }
  console.log(`[web2cmd] web build: ${hasWebBuild ? "served" : "NOT built yet"}`);
  console.log(`[web2cmd] data dir: ${cfg.dataDir}\n`);
}

process.on("SIGINT", () => {
  void tunnel.stop();
  sessions.killAll();
  process.exit(0);
});

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
