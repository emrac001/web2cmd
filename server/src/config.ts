/**
 * Configuration + persisted secrets for the Web2cmd server.
 *
 * Secrets live in a local data dir (default: <repo>/.web2cmd/config.json), which is
 * gitignored. The auth password is stored only as a bcrypt hash; the token secret is a
 * random value generated on first boot. Nothing sensitive is ever committed.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// repo root = server/.. (works from both src/ via tsx and dist/ via node)
const repoRoot = resolve(__dirname, "..", "..");

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** How the server gates access. `off` = open (localhost/LAN only); `password` = shared password. */
export type AuthMode = "off" | "password";
/** How the server is reached. `local` = localhost/LAN; `remote` = tunnelled / public. */
export type Exposure = "local" | "remote";

export interface StoredConfig {
  /** bcrypt hash of the login password, or null until set. */
  passwordHash: string | null;
  /** secret used to sign session tokens. */
  tokenSecret: string;
  /** VAPID keypair for Web Push, generated on first boot. */
  vapid?: VapidKeys;
  /** stable ed25519 server-identity keypair, generated on first boot. */
  identity?: { publicKey: string; privateKey: string };
}

export interface RuntimeConfig {
  host: string;
  port: number;
  /** absolute path to the data dir holding config.json */
  dataDir: string;
  /** how long a session token (password login) stays valid */
  tokenTtl: string;
  /** how long a device token (OTP pairing) stays valid */
  deviceTokenTtl: string;
  /** default working directory offered in the project picker */
  defaultCwd: string;
  /** whether access is gated and how */
  authMode: AuthMode;
  /** declared exposure; couples with authMode to decide what's required */
  exposure: Exposure;
  /** whether the project fence (shell cd guard + Claude hook) is active */
  fence: "on" | "off";
  stored: StoredConfig;
}

function dataDirPath(): string {
  return process.env.WEB2CMD_DATA_DIR
    ? resolve(process.env.WEB2CMD_DATA_DIR)
    : join(repoRoot, ".web2cmd");
}

function loadStored(dataDir: string): StoredConfig {
  const file = join(dataDir, "config.json");
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredConfig>;
      return {
        passwordHash: parsed.passwordHash ?? null,
        tokenSecret: parsed.tokenSecret || randomBytes(32).toString("hex"),
        vapid: parsed.vapid,
        identity: parsed.identity,
      };
    } catch {
      // fall through to fresh config on corrupt file
    }
  }
  return { passwordHash: null, tokenSecret: randomBytes(32).toString("hex") };
}

export function saveStored(dataDir: string, stored: StoredConfig): void {
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(stored, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
}

export function loadConfig(): RuntimeConfig {
  const dataDir = dataDirPath();
  const stored = loadStored(dataDir);
  // persist a freshly-generated token secret so tokens survive restarts
  if (!existsSync(join(dataDir, "config.json"))) saveStored(dataDir, stored);

  // Auth is optional and OFF by default. An explicit WEB2CMD_AUTH wins; otherwise we default to
  // "password" when a password already exists (so pre-v2 setups keep gating) and "off" if not.
  const authEnv = process.env.WEB2CMD_AUTH?.toLowerCase();
  const authMode: AuthMode =
    authEnv === "password" || authEnv === "off"
      ? authEnv
      : stored.passwordHash
        ? "password"
        : "off";

  const expEnv = process.env.WEB2CMD_EXPOSURE?.toLowerCase();
  const exposure: Exposure = expEnv === "remote" ? "remote" : "local";

  const fence: "on" | "off" = process.env.WEB2CMD_FENCE?.toLowerCase() === "off" ? "off" : "on";

  return {
    host: process.env.WEB2CMD_HOST || "0.0.0.0",
    port: Number(process.env.WEB2CMD_PORT || 8787),
    dataDir,
    tokenTtl: process.env.WEB2CMD_TOKEN_TTL || "30d",
    deviceTokenTtl: process.env.WEB2CMD_DEVICE_TTL || "365d",
    defaultCwd: process.env.WEB2CMD_DEFAULT_CWD || repoRoot,
    authMode,
    exposure,
    fence,
    stored,
  };
}

export { repoRoot };
