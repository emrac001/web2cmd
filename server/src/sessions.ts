/**
 * PTY session manager — the core of Web2cmd.
 *
 * Each Session owns one node-pty process (pwsh) rooted at a chosen project folder. Many
 * WebSocket clients can attach to the SAME session: output is broadcast to all of them and
 * input from any of them is written to the one shared PTY. This is what lets the phone and
 * the laptop mirror the same live session simultaneously (requirement #6).
 *
 * Key behaviours:
 *  - scrollback ring-buffer: a newly-attached client is replayed recent output so it renders
 *    the current screen instead of a blank one.
 *  - the PTY survives client disconnects; it only dies on explicit kill or shell exit. So you
 *    can walk away from the laptop and pick the session up on the phone.
 *  - resize: the PTY is sized to the SMALLEST attached client to avoid reflow garbage.
 *  - "waiting" detection: when output goes idle on what looks like a confirmation prompt, the
 *    session reports it so a push notification can be sent.
 */
import type * as PtyNS from "node-pty";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { appendHistory, loadHistory } from "./history.js";

// Load node-pty lazily (and via createRequire so it works in both the ESM dev build and the
// bundled CJS .exe). Deferring the require until the first session spawn means it resolves AFTER
// the SEA bootstrap has set NODE_PATH to the directory where the native files were extracted.
const nodeRequire = createRequire(import.meta.url);
let _pty: typeof PtyNS | null = null;
function pty(): typeof PtyNS {
  return (_pty ??= nodeRequire("node-pty"));
}

export interface ClientHandle {
  id: string;
  cols: number;
  rows: number;
  /** display name + persistent device id (for the typing-lock identity) */
  label: string;
  deviceId?: string;
  /** push a chunk of terminal output to this client */
  send: (data: string) => void;
  /** push a JSON control message (e.g. lock state) to this client */
  sendControl: (msg: unknown) => void;
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

export interface CreateOptions {
  cwd: string;
  shell?: string;
  /** initial arguments, e.g. to auto-start claude */
  args?: string[];
  cols?: number;
  rows?: number;
  title?: string;
}

export type WaitingHandler = (info: SessionInfo, snippet: string) => void;

/** What the shell needs to enforce the project fence (null = fence disabled). */
export interface FenceSpawn {
  scriptPath: string;
  secret: string;
  url: string;
}

const SCROLLBACK_BYTES = 256 * 1024;
const TYPING_FREEZE_MS = 10_000; // after an admin release, the previous typist waits this long
const DEFAULT_SHELL = process.platform === "win32" ? "pwsh.exe" : (process.env.SHELL || "bash");

// --- "Claude is waiting" detection -----------------------------------------------------
// After a quiet period (no PTY output), if the recent screen looks like a confirmation
// prompt, the session is considered "waiting" and fires once. Output streaming (e.g. Claude's
// working spinner) keeps resetting the timer, so we don't fire mid-task.
const WAITING_IDLE_MS = 1200;
const WAITING_TAIL_CHARS = 4000;
// ConPTY snapshots the host console's existing screen buffer when a shell spawns, so a new
// session's first output can contain stale text. Ignore detection during this startup grace
// and drop the stale tail at the end of it.
const WAITING_STARTUP_GRACE_MS = 1500;

// Strip ANSI/CSI/OSC escape sequences, then drop stray control chars while keeping CR and LF.
// Both regexes are built from \u-escaped strings so there are no literal control chars here.
const ANSI_RE = new RegExp(
  "\\u001b\\[[0-9;?]*[ -/]*[@-~]" + // CSI
    "|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)" + // OSC (BEL or ST terminated)
    "|\\u001b[@-Z\\\\-_]", // single-char escapes
  "g",
);
const CTRL_RE = new RegExp("[\\u0000-\\u0009\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g");

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "").replace(CTRL_RE, " ");
}

const PROMPT_PATTERNS: RegExp[] = [
  /do you want to /i, // "Do you want to proceed?", "...make this edit?", "...create...?"
  /❯\s*\d\.\s*yes/i, // selected "Yes" option in the permission menu
  /\b1\.\s*yes\b[\s\S]{0,120}\b2\.\s*(no|yes,)/i, // numbered yes/no menu
  /press\s+enter\s+to\s+continue/i,
];

function looksLikePrompt(text: string): boolean {
  if (PROMPT_PATTERNS.some((r) => r.test(text))) return true;
  // arrow selector present alongside both yes and no choices
  return text.includes("❯") && /\byes\b/i.test(text) && /\bno\b/i.test(text);
}

function promptSnippet(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const q = [...lines].reverse().find((l) => /do you want|proceed|edit|allow|run|continue/i.test(l));
  return (q || lines[lines.length - 1] || "Claude needs your input").slice(0, 140);
}

class Session {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  readonly cwd: string;
  readonly shell: string;
  title: string;
  alive = true;
  exitCode: number | null = null;

  private term: PtyNS.IPty;
  private clients = new Map<string, ClientHandle>();
  private scrollback = "";

  // single-typist write lock
  private lockHolder: string | null = null; // clientId currently allowed to type
  private freezeUntil = new Map<string, number>(); // deviceId -> ts it may type again

  // waiting detection state
  private tail = "";
  private idleTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private startTime = Date.now();
  private notifiedWaiting = false;

  constructor(
    opts: CreateOptions,
    private dataDir: string,
    fence: FenceSpawn | null,
    private onWaiting?: (snippet: string) => void,
  ) {
    this.cwd = opts.cwd;
    this.shell = opts.shell || DEFAULT_SHELL;
    this.title = opts.title || opts.cwd;
    // Seed the scrollback with this project's persisted history so a fresh session replays the
    // prior screen above its new prompt — continuity across restarts. Direct assignment (not
    // appendScrollback) so we don't write the already-stored history back to disk.
    this.scrollback = loadHistory(dataDir, this.cwd);

    // When the fence is on (and we're on PowerShell), dot-source the generated guard script at
    // startup and hand it the root + secret via env, so cd/Set-Location/pushd are checked.
    const env = { ...process.env } as Record<string, string>;
    let args = opts.args ?? [];
    if (fence && /pwsh|powershell/i.test(this.shell)) {
      env.WEB2CMD_FENCE_URL = fence.url;
      env.WEB2CMD_FENCE_SECRET = fence.secret;
      env.WEB2CMD_FENCE_ROOT = this.cwd;
      const dot = `. '${fence.scriptPath.replace(/'/g, "''")}'`;
      args = ["-NoLogo", "-NoExit", "-Command", dot, ...args];
    }
    this.term = pty().spawn(this.shell, args, {
      name: "xterm-256color",
      cols: opts.cols ?? 80,
      rows: opts.rows ?? 24,
      cwd: opts.cwd,
      env,
    });

    this.term.onData((data) => {
      this.appendScrollback(data);
      for (const c of this.clients.values()) c.send(data);
      this.trackForWaiting(data);
    });

    this.term.onExit(({ exitCode }) => {
      this.alive = false;
      this.exitCode = exitCode;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      const note = `\r\n\x1b[33m[session exited with code ${exitCode}]\x1b[0m\r\n`;
      this.appendScrollback(note);
      for (const c of this.clients.values()) c.send(note);
    });
  }

  private appendScrollback(data: string) {
    this.scrollback += data;
    if (this.scrollback.length > SCROLLBACK_BYTES) {
      this.scrollback = this.scrollback.slice(this.scrollback.length - SCROLLBACK_BYTES);
    }
    // Persist the same stream to the project's durable history (survives restarts).
    appendHistory(this.dataDir, this.cwd, data);
  }

  /** Accumulate plain-text tail; after output goes idle, fire once if it looks like a prompt. */
  private trackForWaiting(data: string) {
    if (!this.onWaiting) return;
    const text = stripAnsi(data);
    this.tail = (this.tail + text).slice(-WAITING_TAIL_CHARS);
    // During startup, schedule a one-time tail reset (drops the inherited console snapshot)
    // and don't arm detection yet.
    if (Date.now() - this.startTime < WAITING_STARTUP_GRACE_MS) {
      if (!this.graceTimer) {
        this.graceTimer = setTimeout(() => {
          this.tail = "";
        }, WAITING_STARTUP_GRACE_MS);
      }
      return;
    }
    // Only chunks with visible characters count as activity. ConPTY emits periodic
    // cursor/redraw escape sequences that strip to nothing; if those reset the idle timer
    // the session would never appear idle and we'd never detect a waiting prompt.
    if (text.replace(/\s/g, "").length === 0) return;
    if (process.env.WEB2CMD_DEBUG_WAIT) console.error("[wait] activity, arming timer");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (process.env.WEB2CMD_DEBUG_WAIT)
        console.error(
          `[wait] idle fired alive=${this.alive} notified=${this.notifiedWaiting} prompt=${looksLikePrompt(
            this.tail,
          )}`,
        );
      if (!this.alive || this.notifiedWaiting) return;
      if (looksLikePrompt(this.tail)) {
        this.notifiedWaiting = true;
        this.onWaiting?.(promptSnippet(this.tail));
      }
    }, WAITING_IDLE_MS);
  }

  attach(client: ClientHandle) {
    this.clients.set(client.id, client);
    // replay current screen state to the freshly-attached client
    if (this.scrollback) client.send(this.scrollback);
    this.applySmallestSize();
    this.broadcastLock(); // tell everyone (incl. the newcomer) who currently holds control
  }

  detach(clientId: string) {
    if (this.lockHolder === clientId) this.lockHolder = null; // holder left → free the lock
    this.clients.delete(clientId);
    this.applySmallestSize();
    this.broadcastLock();
  }

  /** Raw write to the PTY — server-initiated (e.g. auto-starting Claude); bypasses the lock. */
  write(data: string) {
    if (!this.alive) return;
    // any input means the user responded — re-arm waiting detection for the next prompt
    this.notifiedWaiting = false;
    this.term.write(data);
  }

  // ---- single-typist write lock ----------------------------------------------------------
  private freezeRemaining(deviceId?: string): number {
    if (!deviceId) return 0;
    return Math.max(0, (this.freezeUntil.get(deviceId) ?? 0) - Date.now());
  }

  private holderLabel(): string | null {
    return this.lockHolder ? (this.clients.get(this.lockHolder)?.label ?? null) : null;
  }

  /** Tell each attached client the current lock state (tailored: youHold + their own freeze). */
  private broadcastLock(): void {
    const holderId = this.lockHolder;
    const holderLabel = this.holderLabel();
    for (const c of this.clients.values()) {
      c.sendControl({
        type: "lock",
        holderId,
        holderLabel,
        youHold: holderId === c.id,
        frozenMs: this.freezeRemaining(c.deviceId),
      });
    }
  }

  /** Client input, gated by the lock: the first typist takes control; others are read-only. */
  handleInput(clientId: string, data: string): void {
    if (!this.alive) return;
    const c = this.clients.get(clientId);
    if (!c) return;
    if (this.lockHolder === clientId) {
      this.write(data);
    } else if (this.lockHolder === null) {
      if (this.freezeRemaining(c.deviceId) > 0) return; // just released this device — frozen out
      this.lockHolder = clientId;
      this.broadcastLock();
      this.write(data);
    }
    // else: someone else holds the lock → drop (read-only)
  }

  /** Release the lock. Admin release freezes the previous holder briefly; self-release doesn't. */
  releaseLock(freeze: boolean): void {
    if (!this.lockHolder) return;
    if (freeze) {
      const dev = this.clients.get(this.lockHolder)?.deviceId;
      if (dev) this.freezeUntil.set(dev, Date.now() + TYPING_FREEZE_MS);
    }
    this.lockHolder = null;
    this.broadcastLock();
  }

  /** Hand control to a specific client (admin). */
  transferLock(toClientId: string): void {
    if (!this.clients.has(toClientId)) return;
    this.lockHolder = toClientId;
    this.broadcastLock();
  }

  /** A client voluntarily gives up control (no freeze). */
  selfRelease(clientId: string): void {
    if (this.lockHolder === clientId) this.releaseLock(false);
  }

  lockInfo() {
    return {
      holderId: this.lockHolder,
      holderLabel: this.holderLabel(),
      clients: [...this.clients.values()].map((c) => ({ id: c.id, label: c.label })),
    };
  }

  /** Update one client's dimensions, then size the PTY to the smallest client. */
  resizeClient(clientId: string, cols: number, rows: number) {
    const c = this.clients.get(clientId);
    if (!c) return;
    c.cols = cols;
    c.rows = rows;
    this.applySmallestSize();
  }

  private applySmallestSize() {
    if (!this.alive || this.clients.size === 0) return;
    let cols = Infinity;
    let rows = Infinity;
    for (const c of this.clients.values()) {
      cols = Math.min(cols, c.cols);
      rows = Math.min(rows, c.rows);
    }
    cols = Math.max(2, Number.isFinite(cols) ? cols : 80);
    rows = Math.max(2, Number.isFinite(rows) ? rows : 24);
    try {
      this.term.resize(cols, rows);
    } catch {
      /* resize can throw if the pty is tearing down; ignore */
    }
  }

  kill() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.graceTimer) clearTimeout(this.graceTimer);
    try {
      this.term.kill();
    } catch {
      /* already gone */
    }
    this.alive = false;
  }

  info(): SessionInfo {
    return {
      id: this.id,
      title: this.title,
      cwd: this.cwd,
      shell: this.shell,
      createdAt: this.createdAt,
      clients: this.clients.size,
      alive: this.alive,
    };
  }
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private waitingHandler: WaitingHandler | null = null;

  constructor(
    private dataDir: string,
    private fence: FenceSpawn | null = null,
  ) {}

  /** Register a callback invoked when a session appears to be waiting for confirmation. */
  setWaitingHandler(fn: WaitingHandler) {
    this.waitingHandler = fn;
  }

  /** Enable/disable the fence for sessions created from now on (runtime toggle). */
  setFence(fence: FenceSpawn | null) {
    this.fence = fence;
  }

  create(opts: CreateOptions): SessionInfo {
    const s = new Session(opts, this.dataDir, this.fence, (snippet) => {
      this.waitingHandler?.(s.info(), snippet);
    });
    this.sessions.set(s.id, s);
    return s.info();
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  /** Sessions enriched with lock + client info, for the operator console. */
  adminList() {
    return [...this.sessions.values()].map((s) => ({ ...s.info(), lock: s.lockInfo() }));
  }

  releaseControl(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.releaseLock(true);
    return true;
  }

  transferControl(id: string, clientId: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.transferLock(clientId);
    return true;
  }

  kill(id: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.kill();
    this.sessions.delete(id);
    return true;
  }

  /** Drop sessions whose shell has exited and that have no attached clients. */
  reap() {
    for (const [id, s] of this.sessions) {
      if (!s.alive && s.info().clients === 0) this.sessions.delete(id);
    }
  }

  killAll() {
    for (const s of this.sessions.values()) s.kill();
    this.sessions.clear();
  }
}

export type { Session };
