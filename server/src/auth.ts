/**
 * Access control. Two independent credentials, both carried as a signed JWT:
 *   - a **session** token, issued by password login (`/api/login`);
 *   - a **device** token, issued by OTP pairing (`/api/pair`).
 *
 * What a request needs depends on how the server is reached (see {@link checkAccess}):
 *   - local + auth off      → nothing (open on localhost/LAN);
 *   - local + auth password → any valid token;
 *   - remote (tunnelled)    → a device token (i.e. the client must have paired).
 *
 * Pairing is the gate that makes remote exposure safe; the optional password is layered in at
 * pairing time (you must supply it to pair when auth=password), so a device token always implies
 * the password was known.
 */
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import type { RuntimeConfig } from "./config.js";
import { saveStored } from "./config.js";

export type TokenKind = "session" | "device";

export interface TokenPayload {
  sub: "web2cmd-user";
  kind: TokenKind;
  /** device-registry id for device tokens (absent on session tokens). */
  deviceId?: string;
}

export function isPasswordConfigured(cfg: RuntimeConfig): boolean {
  return Boolean(cfg.stored.passwordHash);
}

/** Set/replace the login password (used by the set-password script and first-boot env). */
export function setPassword(cfg: RuntimeConfig, plain: string): void {
  cfg.stored.passwordHash = bcrypt.hashSync(plain, 12);
  saveStored(cfg.dataDir, cfg.stored);
}

/** Remove the login password. */
export function clearPassword(cfg: RuntimeConfig): void {
  cfg.stored.passwordHash = null;
  saveStored(cfg.dataDir, cfg.stored);
}

export function verifyPassword(cfg: RuntimeConfig, plain: string): boolean {
  if (!cfg.stored.passwordHash) return false;
  return bcrypt.compareSync(plain, cfg.stored.passwordHash);
}

export function issueToken(cfg: RuntimeConfig, kind: TokenKind, deviceId?: string): string {
  const payload: TokenPayload = { sub: "web2cmd-user", kind, ...(deviceId ? { deviceId } : {}) };
  const ttl = kind === "device" ? cfg.deviceTokenTtl : cfg.tokenTtl;
  return jwt.sign(payload, cfg.stored.tokenSecret, { expiresIn: ttl as any });
}

/** Verify a JWT and return its payload, or null if missing/invalid/expired. */
export function verifyToken(cfg: RuntimeConfig, token: string | undefined | null): TokenPayload | null {
  if (!token) return null;
  try {
    return jwt.verify(token, cfg.stored.tokenSecret) as TokenPayload;
  } catch {
    return null;
  }
}

/**
 * Decide whether a request bearing `token` may access the API/WS under the current config.
 * `deviceValid` checks the device registry (id known + not revoked) so the operator can revoke a
 * paired client. Device tokens minted before the registry (no deviceId) are rejected — a clean
 * forced re-pair.
 */
export function checkAccess(
  cfg: RuntimeConfig,
  token: string | undefined | null,
  deviceValid: (id: string) => boolean,
): boolean {
  const payload = verifyToken(cfg, token);
  if (cfg.exposure === "remote") {
    // Remote access is gated by pairing — a device token whose id is still in the registry.
    return payload?.kind === "device" && !!payload.deviceId && deviceValid(payload.deviceId);
  }
  // Local: open when auth is off, otherwise any valid token (and device tokens must be live).
  if (cfg.authMode === "off") return true;
  if (!payload) return false;
  if (payload.kind === "device") return !!payload.deviceId && deviceValid(payload.deviceId);
  return true; // session token
}

/** Pull a bearer token from an Authorization header or a `token` query param. */
export function extractToken(authHeader?: string, queryToken?: string): string | undefined {
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  return queryToken || undefined;
}
