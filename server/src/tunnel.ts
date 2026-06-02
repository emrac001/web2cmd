/**
 * Server-managed tunnels.
 *
 * Lets the operator start/stop a public tunnel from the Console instead of a separate script:
 * the server spawns cloudflared/ngrok as a child, reads back the public URL, and tracks state.
 * It also reports which tunnel tools are installed (so the Console can offer a picker) and gives
 * install guidance when none are present.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type TunnelProvider = "cloudflared" | "ngrok";

export interface TunnelStatus {
  running: boolean;
  provider: TunnelProvider | null;
  url: string | null;
  startedAt: number | null;
}

const INSTALL_HINTS: Record<TunnelProvider, string> = {
  cloudflared:
    "Install cloudflared: `winget install --id Cloudflare.cloudflared` (or github.com/cloudflare/cloudflared/releases). No account needed for quick tunnels.",
  ngrok:
    "Install ngrok: `winget install --id Ngrok.Ngrok` (or ngrok.com/download), then `ngrok config add-authtoken <token>`.",
};

export class TunnelManager {
  private child: ChildProcess | null = null;
  private status: TunnelStatus = { running: false, provider: null, url: null, startedAt: null };

  constructor(private port: number) {}

  /** Likely install locations, used when PATH resolution misses the binary (detached process,
   *  reduced PATH, ngrok installed under %LOCALAPPDATA%, winget shims, Homebrew, etc.). */
  private candidatePaths(provider: TunnelProvider): string[] {
    if (process.platform === "win32") {
      const exe = `${provider}.exe`;
      const pf = process.env.ProgramFiles || "C:\\Program Files";
      const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
      const lad = process.env.LOCALAPPDATA || "";
      const dirs =
        provider === "cloudflared"
          ? [join(pf86, "cloudflared"), join(pf, "cloudflared")]
          : [join(lad, "ngrok"), join(pf, "ngrok")];
      if (lad) dirs.push(join(lad, "Microsoft", "WinGet", "Links"));
      return dirs.map((d) => join(d, exe));
    }
    return ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/snap/bin"].map((d) =>
      join(d, provider),
    );
  }

  /** Resolve the absolute path to a provider's binary, or null. Tries PATH (where/which) first,
   *  then known install locations. Not cached, so a tool installed after boot is still found. */
  private resolveBinary(provider: TunnelProvider): string | null {
    try {
      const which = process.platform === "win32" ? "where" : "which";
      const r = spawnSync(which, [provider], { timeout: 5000, windowsHide: true, encoding: "utf8" });
      const hit = (r.stdout || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s && existsSync(s));
      if (hit) return hit;
    } catch {
      /* fall through to known locations */
    }
    return this.candidatePaths(provider).find((p) => existsSync(p)) ?? null;
  }

  /** Whether a provider's binary can be found (on PATH or in a known install location). */
  available(provider: TunnelProvider): boolean {
    return this.resolveBinary(provider) !== null;
  }

  /** All known providers with availability + install hints (for the Console picker). */
  discover(): Array<{ provider: TunnelProvider; available: boolean; install: string }> {
    return (["cloudflared", "ngrok"] as TunnelProvider[]).map((p) => ({
      provider: p,
      available: this.available(p),
      install: INSTALL_HINTS[p],
    }));
  }

  getStatus(): TunnelStatus {
    return { ...this.status };
  }

  /** Start a tunnel and resolve once its public URL is known. Replaces any running tunnel. */
  async start(provider: TunnelProvider): Promise<TunnelStatus> {
    await this.stop();
    const bin = this.resolveBinary(provider);
    if (!bin) throw new Error(`${provider} is not installed. ${INSTALL_HINTS[provider]}`);
    const url =
      provider === "cloudflared" ? await this.startCloudflared(bin) : await this.startNgrok(bin);
    this.status = { running: true, provider, url, startedAt: Date.now() };
    return this.getStatus();
  }

  private startCloudflared(bin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, ["tunnel", "--url", `http://localhost:${this.port}`], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      let buf = "";
      const onData = (d: Buffer) => {
        buf += d.toString();
        const m = buf.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) {
          cleanup();
          resolve(m[0]);
        }
      };
      const onExit = () => {
        cleanup();
        reject(new Error("cloudflared exited before a URL appeared"));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("timed out waiting for the cloudflared URL"));
      }, 30000);
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onData);
        child.off("exit", onExit);
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.on("exit", onExit);
    });
  }

  private startNgrok(bin: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(bin, ["http", String(this.port), "--log", "stdout"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      let tries = 0;
      const poll = setInterval(async () => {
        if (++tries > 40) {
          clearInterval(poll);
          reject(new Error("timed out waiting for the ngrok URL"));
          return;
        }
        try {
          const res = await fetch("http://127.0.0.1:4040/api/tunnels");
          const j = (await res.json()) as { tunnels?: Array<{ public_url?: string }> };
          const https = (j.tunnels ?? []).find((t) => t.public_url?.startsWith("https"));
          if (https?.public_url) {
            clearInterval(poll);
            resolve(https.public_url);
          }
        } catch {
          /* ngrok API not up yet */
        }
      }, 500);
      child.on("exit", () => clearInterval(poll));
    });
  }

  async stop(): Promise<void> {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
      this.child = null;
    }
    this.status = { running: false, provider: null, url: null, startedAt: null };
  }
}
