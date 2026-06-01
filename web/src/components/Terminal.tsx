import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { getToken } from "../lib/api";
import { LineEditor } from "../lib/lineEditor";

export interface TerminalHandle {
  /** send input (raw bytes, or a line in line-mode) — used by the touch toolbar */
  sendData: (data: string) => void;
  focus: () => void;
  /** copy the current terminal selection to the clipboard; returns false if nothing selected */
  copySelection: () => Promise<boolean>;
  /** toggle touch selection mode (lets you long-press + drag to highlight text) */
  setSelectMode: (on: boolean) => void;
}

// Smaller font on narrow (portrait phone) screens so more columns fit.
function fontForWidth(): number {
  const w = window.innerWidth;
  if (w < 400) return 11;
  if (w < 480) return 12;
  if (w < 768) return 13;
  return 14;
}

interface Props {
  sessionId: string;
  /** reports connection state changes to the parent */
  onStatus?: (status: "connecting" | "open" | "closed") => void;
}

function wsUrl(sessionId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const token = getToken() ?? "";
  return `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}&session=${encodeURIComponent(
    sessionId,
  )}`;
}

// Strip ANSI/CSI/OSC so we can pattern-match the shell prompt in plain text.
const ANSI_RE = new RegExp(
  "\\u001b\\[[0-9;?]*[ -/]*[@-~]|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)|\\u001b[@-Z\\\\-_]",
  "g",
);
// "Idle at a shell prompt" = the visible tail ends with a pwsh prompt. Conservative on purpose:
// custom prompts simply fall back to raw mode (no regression), and a running program — including
// Claude's inline Ink UI — never matches, so its keystrokes pass through raw.
const PROMPT_RE = /PS [A-Za-z]:\\[^\n]*>\s*$/;

export const Terminal = forwardRef<TerminalHandle, Props>(function Terminal(
  { sessionId, onStatus },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const routeRef = useRef<(data: string) => void>(() => {});
  const [, setTick] = useState(0);

  // input-mode signals: refs drive the hot path, state drives the toggle label
  const forceRawRef = useRef(false);
  const altRef = useRef(false);
  const atPromptRef = useRef(false);
  const [forceRaw, setForceRaw] = useState(false);
  const [alt, setAlt] = useState(false);
  const [atPrompt, setAtPrompt] = useState(false);

  useImperativeHandle(ref, () => ({
    sendData: (data: string) => {
      routeRef.current(data);
      termRef.current?.focus();
    },
    focus: () => termRef.current?.focus(),
    copySelection: async () => {
      // prefer the native browser selection (used in select mode); fall back to xterm's own
      const native = window.getSelection?.()?.toString() ?? "";
      const sel = native || termRef.current?.getSelection() || "";
      if (!sel) return false;
      try {
        await navigator.clipboard.writeText(sel);
        return true;
      } catch {
        return false;
      }
    },
    setSelectMode: (on: boolean) => {
      const term = termRef.current;
      const host = hostRef.current;
      if (!term || !host) return;
      host.classList.toggle("select-mode", on);
      // stop input while selecting so taps select text instead of moving the cursor
      term.options.disableStdin = on;
      if (on) {
        (document.activeElement as HTMLElement | null)?.blur();
      } else {
        window.getSelection?.()?.removeAllRanges();
        term.focus();
      }
    },
  }));

  useEffect(() => {
    const term = new XTerm({
      cursorBlink: true,
      fontFamily:
        'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: fontForWidth(),
      lineHeight: 1.0,
      scrollback: 5000,
      theme: {
        background: "#0b0e14",
        foreground: "#d7dce5",
        cursor: "#4d9fff",
        selectionBackground: "#2a3754",
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(new ClipboardAddon());
    term.open(hostRef.current!);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const sendToPty = (data: string) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data }));
    };

    // The line editor buffers input locally at the prompt and submits whole commands, so other
    // attached clients never see half-typed lines. Its echo goes only to this terminal.
    const editor = new LineEditor({
      echo: (s) => term.write(s),
      submit: (line) => sendToPty(line + "\r"),
      raw: (data) => sendToPty(data),
    });

    // Route every input source (desktop, touch IME, touch toolbar) through one decision:
    // raw passthrough while a program is running / in a TUI / when forced; line-mode at the prompt.
    const routeInput = (data: string) => {
      const raw = forceRawRef.current || altRef.current || !atPromptRef.current;
      if (raw) sendToPty(data);
      else editor.feed(data);
    };
    routeRef.current = routeInput;

    // Detect the alternate screen (vim/less/full-screen TUIs) — always raw there.
    const bufSub = term.buffer.onBufferChange((buf) => {
      altRef.current = buf.type === "alternate";
      setAlt(altRef.current);
      editor.reset(); // drop any half-typed line when entering/leaving a full-screen app
    });

    // Track the prompt from PTY output so we know when it's safe to switch to line-mode.
    let tail = "";
    const updatePrompt = (chunk: string) => {
      tail = (tail + chunk.replace(ANSI_RE, "")).slice(-400);
      const now = PROMPT_RE.test(tail);
      if (now !== atPromptRef.current) {
        atPromptRef.current = now;
        setAtPrompt(now);
        if (!now) editor.reset(); // a command started running; abandon any local line state
      }
    };

    // --- input handling ------------------------------------------------------------------
    // Android Gboard composes whole words via predictive text and re-commits them on
    // punctuation (comma/period/space), which duplicates input under xterm's default keyboard
    // handling. On touch devices we take over text input via the textarea's composition/input
    // events (the IME-correct path) and stop xterm from also processing it — so each character
    // or composed word is sent exactly once. Desktop keeps xterm's normal handling.
    const textarea = hostRef.current!.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
    let detachTouchInput: (() => void) | null = null;
    if (textarea) {
      textarea.setAttribute("autocorrect", "off");
      textarea.setAttribute("autocapitalize", "none");
      textarea.setAttribute("autocomplete", "off");
      textarea.setAttribute("spellcheck", "false");
      textarea.setAttribute("inputmode", "text");
    }

    const isTouch =
      window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 0;
    if (textarea && isTouch) {
      let composing = false;
      // Keep a small "guard" buffer in the (hidden) textarea so a Backspace tap always has
      // something to delete — Android fires no delete event on an empty field, which made
      // single taps do nothing while long-press key-repeat over-deleted.
      const GUARD = "   ";
      const seed = () => {
        if (composing) return;
        textarea.value = GUARD;
        try {
          textarea.setSelectionRange(GUARD.length, GUARD.length);
        } catch {
          /* selection range may fail if not focused; ignore */
        }
      };
      const NAV: Record<string, string> = {
        Enter: "\r",
        Tab: "\t",
        Backspace: "\x7f",
        Escape: "\x1b",
        ArrowUp: "\x1b[A",
        ArrowDown: "\x1b[B",
        ArrowRight: "\x1b[C",
        ArrowLeft: "\x1b[D",
        Home: "\x1b[H",
        End: "\x1b[F",
        PageUp: "\x1b[5~",
        PageDown: "\x1b[6~",
        Delete: "\x1b[3~",
      };
      const onKeyDown = (e: KeyboardEvent) => {
        e.stopImmediatePropagation(); // we own input on touch; keep xterm from double-sending
        const seq = NAV[e.key];
        if (seq) {
          e.preventDefault();
          routeInput(seq);
          seed();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key.length === 1) {
          const code = e.key.toUpperCase().charCodeAt(0);
          if (code >= 64 && code <= 95) {
            e.preventDefault();
            routeInput(String.fromCharCode(code - 64));
          }
          return;
        }
        // printable keys + IME composition fall through to the input/composition handlers,
        // which send exactly once.
      };
      const onCompositionStart = (e: Event) => {
        e.stopImmediatePropagation();
        composing = true;
      };
      const onCompositionEnd = (e: CompositionEvent) => {
        e.stopImmediatePropagation();
        composing = false;
        if (e.data) routeInput(e.data);
        seed();
      };
      const onInput = (e: Event) => {
        e.stopImmediatePropagation();
        if (composing) return;
        const ie = e as InputEvent;
        const t = ie.inputType;
        if (t === "insertCompositionText") {
          return; // committed via compositionend
        } else if (t && t.startsWith("insert") && ie.data != null) {
          routeInput(ie.data);
        } else if (t === "insertLineBreak" || t === "insertParagraph") {
          routeInput("\r");
        } else if (t && t.startsWith("delete")) {
          routeInput("\x7f"); // a guard char was deleted -> one backspace
        }
        seed(); // refill the guard so the next Backspace/keystroke registers
      };
      const onFocus = () => seed();
      seed();
      textarea.addEventListener("keydown", onKeyDown, true);
      textarea.addEventListener("compositionstart", onCompositionStart, true);
      textarea.addEventListener("compositionend", onCompositionEnd, true);
      textarea.addEventListener("input", onInput, true);
      textarea.addEventListener("focus", onFocus, true);
      detachTouchInput = () => {
        textarea.removeEventListener("keydown", onKeyDown, true);
        textarea.removeEventListener("compositionstart", onCompositionStart, true);
        textarea.removeEventListener("compositionend", onCompositionEnd, true);
        textarea.removeEventListener("input", onInput, true);
        textarea.removeEventListener("focus", onFocus, true);
      };
    }

    let closedByUs = false;
    let reconnectTimer: number | undefined;

    const sendResize = () => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    const connect = () => {
      onStatus?.("connecting");
      const ws = new WebSocket(wsUrl(sessionId));
      wsRef.current = ws;
      ws.onopen = () => {
        onStatus?.("open");
        sendResize();
      };
      ws.onmessage = (ev) => {
        let msg: { type?: string; data?: string; message?: string };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === "output" && msg.data) {
          term.write(msg.data);
          updatePrompt(msg.data);
        } else if (msg.type === "error") term.write(`\r\n\x1b[31m[${msg.message}]\x1b[0m\r\n`);
      };
      ws.onclose = () => {
        onStatus?.("closed");
        if (!closedByUs) reconnectTimer = window.setTimeout(connect, 1200);
      };
      ws.onerror = () => ws.close();
    };

    // Desktop path (and any input that still reaches xterm): route it.
    const onData = term.onData((data) => routeInput(data));

    connect();

    const ro = new ResizeObserver(() => {
      try {
        const want = fontForWidth();
        if (term.options.fontSize !== want) term.options.fontSize = want;
        fit.fit();
        sendResize();
        setTick((t) => t + 1);
      } catch {
        /* ignore transient resize errors */
      }
    });
    ro.observe(hostRef.current!);

    return () => {
      closedByUs = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ro.disconnect();
      bufSub.dispose();
      detachTouchInput?.();
      onData.dispose();
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [sessionId, onStatus]);

  // Effective mode for the toggle label (mirrors routeInput's decision).
  const effRaw = forceRaw || alt || !atPrompt;
  const modeLabel = forceRaw ? "raw 🔒" : effRaw ? "raw" : "line";
  const cycleMode = () => {
    setForceRaw((f) => {
      const next = !f;
      forceRawRef.current = next;
      return next;
    });
    termRef.current?.focus();
  };

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full" onClick={() => termRef.current?.focus()} />
      <button
        onPointerDown={(e) => {
          e.preventDefault();
          cycleMode();
        }}
        title={
          forceRaw
            ? "Input: raw (forced). Tap for auto."
            : `Input: ${effRaw ? "raw" : "line"} (auto). Tap to force raw.`
        }
        className="absolute right-1 top-1 z-10 rounded border border-[var(--border)] bg-black/50 px-1.5 py-0.5 text-[10px] font-medium text-gray-300 active:scale-95"
      >
        ⌨ {modeLabel}
      </button>
    </div>
  );
});
