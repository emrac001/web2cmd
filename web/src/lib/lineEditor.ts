/**
 * Client-side line editor for the shared shell's "broadcast on submit" mode.
 *
 * At the normal shell prompt the terminal does NOT forward keystrokes to the shared PTY. Instead
 * this editor buffers the line locally and echoes it only to *this* client — so other attached
 * clients never see a half-typed line. On Enter it erases its own local echo and submits the whole
 * line at once; the PTY then echoes the committed command, which is what every client sees. The
 * result: in-progress typing is private, committed commands + their output are the shared history.
 *
 * Trade-off (accepted): because keystrokes don't reach the shell until submit, there's no
 * PSReadLine tab-completion / shell history / syntax highlighting at the bare prompt — the editor
 * provides its own local history instead. Inside full-screen TUIs (Claude, vim) the terminal
 * bypasses this editor entirely and sends raw keystrokes, so those apps work unchanged.
 *
 * Known limitation: cursor math assumes the input fits on one screen row; a single command longer
 * than the terminal width can mis-render on edit/erase. Submitting still sends the correct text.
 */
export interface LineEditorCallbacks {
  /** Render a string to this client's local terminal only (never sent to the PTY). */
  echo: (s: string) => void;
  /** Commit a finished line — the implementation sends `line + "\r"` to the shared PTY. */
  submit: (line: string) => void;
  /** Forward raw bytes straight to the PTY (e.g. Ctrl-C, or EOF at an empty prompt). */
  raw: (data: string) => void;
}

const MAX_HISTORY = 100;

export class LineEditor {
  private buf = "";
  private cursor = 0;
  private history: string[] = [];
  private histIdx: number | null = null; // index into history while navigating, else null
  private savedBuf = ""; // the in-progress line, stashed while browsing history

  constructor(private cb: LineEditorCallbacks) {}

  /** Discard any in-progress line state (no echo). Call when switching away from line mode. */
  reset(): void {
    this.buf = "";
    this.cursor = 0;
    this.histIdx = null;
    this.savedBuf = "";
  }

  /** Feed input (a keystroke, an escape sequence, or a pasted chunk) into the editor. */
  feed(data: string): void {
    for (let i = 0; i < data.length; ) {
      const ch = data[i];

      // ----- newline → submit -----
      if (ch === "\r" || ch === "\n") {
        // collapse a CRLF pair into a single submit
        if (ch === "\r" && data[i + 1] === "\n") i++;
        this.submit();
        i++;
        continue;
      }

      // ----- escape sequences -----
      if (ch === "\x1b") {
        const consumed = this.handleEscape(data, i);
        if (consumed > 0) {
          i += consumed;
          continue;
        }
        // lone/unknown ESC — ignore the ESC byte
        i++;
        continue;
      }

      // ----- control characters -----
      if (ch < " " || ch === "\x7f") {
        this.handleControl(ch);
        i++;
        continue;
      }

      // ----- printable -----
      this.insert(ch);
      i++;
    }
  }

  /** Returns the number of bytes consumed (0 if `data[i]` isn't a recognised escape). */
  private handleEscape(data: string, i: number): number {
    const rest = data.slice(i);
    // CSI sequences we care about
    const map: Record<string, () => void> = {
      "\x1b[A": () => this.historyPrev(),
      "\x1b[B": () => this.historyNext(),
      "\x1b[C": () => this.right(),
      "\x1b[D": () => this.left(),
      "\x1b[H": () => this.home(),
      "\x1b[F": () => this.end(),
      "\x1b[3~": () => this.deleteForward(),
      "\x1b[1~": () => this.home(),
      "\x1b[4~": () => this.end(),
    };
    for (const seq of Object.keys(map)) {
      if (rest.startsWith(seq)) {
        map[seq]();
        return seq.length;
      }
    }
    // Unknown CSI: consume the whole sequence so its bytes aren't treated as text.
    const m = /^\x1b\[[0-9;?]*[ -/]*[@-~]/.exec(rest);
    if (m) return m[0].length;
    return 0;
  }

  private handleControl(ch: string): void {
    switch (ch) {
      case "\x03": // Ctrl-C — abandon the local line and interrupt the shell
        this.clearEcho();
        this.reset();
        this.cb.raw("\x03");
        return;
      case "\x7f": // DEL
      case "\b": // BS
        this.backspace();
        return;
      case "\x01": // Ctrl-A → start of line
        this.home();
        return;
      case "\x05": // Ctrl-E → end of line
        this.end();
        return;
      case "\x15": // Ctrl-U → clear line
        this.killLine();
        return;
      case "\t": // Tab — no completion in line mode; swallow
        return;
      default:
        // Any other control char (Ctrl-D, Ctrl-L, …) only makes sense at an empty prompt; pass it
        // through raw there so e.g. Ctrl-D can EOF/exit. Mid-line we ignore it.
        if (this.buf.length === 0) this.cb.raw(ch);
        return;
    }
  }

  // ---- editing primitives (each keeps buf/cursor and the local echo in sync) ---------------

  private insert(ch: string): void {
    const after = this.buf.slice(this.cursor);
    this.buf = this.buf.slice(0, this.cursor) + ch + after;
    this.cursor++;
    this.cb.echo(ch + after);
    if (after.length) this.cb.echo(`\x1b[${after.length}D`); // move back over the tail
  }

  private backspace(): void {
    if (this.cursor === 0) return;
    const after = this.buf.slice(this.cursor);
    this.buf = this.buf.slice(0, this.cursor - 1) + after;
    this.cursor--;
    this.cb.echo("\b" + after + " " + `\x1b[${after.length + 1}D`);
  }

  private deleteForward(): void {
    if (this.cursor >= this.buf.length) return;
    const after = this.buf.slice(this.cursor + 1);
    this.buf = this.buf.slice(0, this.cursor) + after;
    this.cb.echo(after + " " + `\x1b[${after.length + 1}D`);
  }

  private left(): void {
    if (this.cursor === 0) return;
    this.cursor--;
    this.cb.echo("\x1b[D");
  }

  private right(): void {
    if (this.cursor >= this.buf.length) return;
    this.cursor++;
    this.cb.echo("\x1b[C");
  }

  private home(): void {
    if (this.cursor === 0) return;
    this.cb.echo(`\x1b[${this.cursor}D`);
    this.cursor = 0;
  }

  private end(): void {
    const d = this.buf.length - this.cursor;
    if (d === 0) return;
    this.cb.echo(`\x1b[${d}C`);
    this.cursor = this.buf.length;
  }

  private killLine(): void {
    if (this.cursor > 0) this.cb.echo(`\x1b[${this.cursor}D`);
    this.cb.echo("\x1b[K");
    this.buf = "";
    this.cursor = 0;
  }

  /** Erase the locally-echoed input, leaving the shell prompt untouched. */
  private clearEcho(): void {
    if (this.cursor > 0) this.cb.echo(`\x1b[${this.cursor}D`);
    this.cb.echo("\x1b[K");
  }

  private replaceLine(s: string): void {
    this.clearEcho();
    this.buf = s;
    this.cursor = s.length;
    this.cb.echo(s);
  }

  private historyPrev(): void {
    if (this.history.length === 0) return;
    if (this.histIdx === null) {
      this.savedBuf = this.buf;
      this.histIdx = this.history.length - 1;
    } else if (this.histIdx > 0) {
      this.histIdx--;
    }
    this.replaceLine(this.history[this.histIdx]);
  }

  private historyNext(): void {
    if (this.histIdx === null) return;
    if (this.histIdx < this.history.length - 1) {
      this.histIdx++;
      this.replaceLine(this.history[this.histIdx]);
    } else {
      this.histIdx = null;
      this.replaceLine(this.savedBuf);
    }
  }

  private submit(): void {
    const line = this.buf;
    this.clearEcho(); // remove our local echo; the PTY's echo of the command is the shared copy
    if (line && this.history[this.history.length - 1] !== line) {
      this.history.push(line);
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    this.buf = "";
    this.cursor = 0;
    this.histIdx = null;
    this.savedBuf = "";
    this.cb.submit(line);
  }
}
