#!/usr/bin/env node
/**
 * Attach a native laptop terminal to a Web2cmd session, mirroring whatever the phone sees.
 *
 * This is how requirement #6 works on the laptop side: instead of a standalone PowerShell
 * window that the server can't see, you attach a real terminal to the SAME shared PTY the
 * phone is driving. Type here or on the phone — both mirror the one live session.
 *
 * Usage:
 *   node attach/attach.mjs [options]
 *
 * Options (also via env):
 *   --url   <base>      server base URL        (WEB2CMD_URL, default http://127.0.0.1:8787)
 *   --pass  <password>  login password         (WEB2CMD_PASSWORD)
 *   --token <token>     use an existing token instead of logging in (WEB2CMD_TOKEN)
 *   --session <id>      attach to an existing session id; otherwise pick/create
 *   --cwd   <path>      working dir for a new session (default: current dir)
 *   --claude            auto-start `claude` in a new session
 *   --continue          auto-start `claude --continue` (resume last conversation)
 *   --list              list sessions and exit
 *
 * Detach with Ctrl+] (the session keeps running on the server).
 */
import { argv, env, stdin, stdout, exit } from "node:process";

function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : true;
}

const base = (arg("url", env.WEB2CMD_URL) || "http://127.0.0.1:8787").replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");
const password = arg("pass", env.WEB2CMD_PASSWORD);
let token = arg("token", env.WEB2CMD_TOKEN);
const sessionArg = arg("session", undefined);
const cwd = arg("cwd", process.cwd());
const claudeMode = arg("continue", false) ? "continue" : arg("claude", false) ? "new" : undefined;
const listOnly = arg("list", false);

function die(msg) {
  console.error(`[attach] ${msg}`);
  exit(1);
}

async function jget(path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) die(`${path} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// --- auth ---
if (!token) {
  if (!password) die("provide --pass <password> or --token <token> (or set WEB2CMD_PASSWORD)");
  const r = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (!r.ok) die("login failed (wrong password?)");
  token = (await r.json()).token;
}

// --- list mode ---
if (listOnly) {
  const { sessions } = await jget("/api/sessions");
  if (!sessions.length) console.log("(no sessions)");
  for (const s of sessions)
    console.log(`${s.id}  ${s.alive ? "live" : "dead"}  clients=${s.clients}  ${s.cwd}`);
  exit(0);
}

// --- choose / create session ---
let sessionId = sessionArg;
if (!sessionId) {
  const { sessions } = await jget("/api/sessions");
  const live = sessions.filter((s) => s.alive);
  if (live.length && claudeMode === undefined) {
    sessionId = live[0].id;
    console.log(`[attach] attaching to existing session ${sessionId} (${live[0].cwd})`);
  } else {
    const info = await jget("/api/sessions", {
      method: "POST",
      body: JSON.stringify({
        cwd,
        cols: stdout.columns || 80,
        rows: stdout.rows || 24,
        startClaude: claudeMode !== undefined,
        claudeMode,
        title: cwd.split(/[\\/]/).pop(),
      }),
    });
    sessionId = info.id;
    console.log(`[attach] created session ${sessionId} in ${cwd}`);
  }
}

// --- connect ---
const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}&session=${sessionId}`);

ws.addEventListener("open", () => {
  console.log("[attach] connected — detach with Ctrl+]\n");
  sendResize();
});
ws.addEventListener("message", (ev) => {
  let msg;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  if (msg.type === "output") stdout.write(msg.data);
  else if (msg.type === "error") console.error(`\n[attach] ${msg.message}`);
});
ws.addEventListener("close", () => {
  cleanup();
  console.log("\n[attach] disconnected");
  exit(0);
});
ws.addEventListener("error", (e) => die(`ws error: ${e.message || e}`));

function sendResize() {
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "resize", cols: stdout.columns || 80, rows: stdout.rows || 24 }));
}

// poll for terminal resize (Windows has no SIGWINCH)
let lastCols = stdout.columns,
  lastRows = stdout.rows;
const resizeTimer = setInterval(() => {
  if (stdout.columns !== lastCols || stdout.rows !== lastRows) {
    lastCols = stdout.columns;
    lastRows = stdout.rows;
    sendResize();
  }
}, 500);

// raw stdin -> PTY; Ctrl+] (0x1d) detaches
if (stdin.isTTY) stdin.setRawMode(true);
stdin.resume();
stdin.on("data", (chunk) => {
  if (chunk.length === 1 && chunk[0] === 0x1d) {
    ws.close();
    return;
  }
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: "input", data: chunk.toString("utf8") }));
});

function cleanup() {
  clearInterval(resizeTimer);
  if (stdin.isTTY) stdin.setRawMode(false);
  stdin.pause();
}

process.on("SIGINT", () => {
  // pass Ctrl+C through to the remote shell rather than killing the attach client
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data: "\x03" }));
});
