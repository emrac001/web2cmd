import { useState } from "react";

/**
 * On-screen keys that mobile keyboards don't provide but terminals (and Claude's confirmation
 * prompts) need: Esc, Tab, arrows, Enter, and common Ctrl combos. Also a Paste button that
 * pumps the clipboard into the PTY (mobile paste into xterm is otherwise unreliable).
 */
interface Props {
  send: (data: string) => void;
  /** copy the current terminal selection; returns whether anything was copied */
  onCopy?: () => Promise<boolean> | void;
  /** toggle touch text-selection mode on the terminal */
  onSelectToggle?: (on: boolean) => void;
}

interface Key {
  label: string;
  data?: string;
  /** special actions */
  action?: "paste" | "copy" | "select" | "ctrl";
  wide?: boolean;
}

const KEYS: Key[] = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "Ctrl", action: "ctrl" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "←", data: "\x1b[D" },
  { label: "→", data: "\x1b[C" },
  { label: "^C", data: "\x03" },
  { label: "^D", data: "\x04" },
  { label: "^Z", data: "\x1a" },
  { label: "^L", data: "\x0c" },
  { label: "Home", data: "\x1b[H" },
  { label: "End", data: "\x1b[F" },
  { label: "PgUp", data: "\x1b[5~" },
  { label: "PgDn", data: "\x1b[6~" },
  { label: "Select", action: "select" },
  { label: "Copy", action: "copy" },
  { label: "Paste", action: "paste" },
];

export function TouchBar({ send, onCopy, onSelectToggle }: Props) {
  const [ctrl, setCtrl] = useState(false);
  const [selecting, setSelecting] = useState(false);

  const onKey = async (k: Key) => {
    if (k.action === "ctrl") {
      setCtrl((c) => !c);
      return;
    }
    if (k.action === "select") {
      setSelecting((s) => {
        const next = !s;
        onSelectToggle?.(next);
        return next;
      });
      return;
    }
    if (k.action === "copy") {
      const copied = await onCopy?.();
      // leaving select mode after a successful copy is the natural flow
      if (copied && selecting) {
        setSelecting(false);
        onSelectToggle?.(false);
      }
      return;
    }
    if (k.action === "paste") {
      try {
        const text = await navigator.clipboard.readText();
        if (text) send(text);
      } catch {
        /* clipboard blocked; ignore */
      }
      return;
    }
    let data = k.data ?? "";
    // sticky Ctrl: turn a following single letter into its control code
    if (ctrl && data.length === 1) {
      const code = data.toUpperCase().charCodeAt(0);
      if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64);
      setCtrl(false);
    }
    send(data);
  };

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(2.75rem,1fr))] gap-1.5 border-t border-[var(--border)] bg-[var(--panel)] px-2 py-2">
      {KEYS.map((k) => {
        const active = (k.action === "ctrl" && ctrl) || (k.action === "select" && selecting);
        return (
          <button
            key={k.label}
            onPointerDown={(e) => {
              e.preventDefault();
              onKey(k);
            }}
            className={
              "select-none rounded-md border py-2 text-center text-sm font-medium active:scale-95 " +
              (active
                ? "border-[var(--accent)] bg-[var(--accent)] text-black"
                : "border-[var(--border)] bg-[#1a2030] text-[var(--text)]")
            }
          >
            {k.label}
          </button>
        );
      })}
    </div>
  );
}
