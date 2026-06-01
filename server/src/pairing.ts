/**
 * Device pairing via a short-lived one-time code (OTP).
 *
 * When the server is exposed remotely, a fresh device must pair before it can talk to the API.
 * The server prints a 6-digit code to its own console; the operator reads it off the screen and
 * enters it once on the client, which then receives a long-lived device token. The code lives
 * only in memory, expires after a few minutes, and is rotated the moment it's used — so a code
 * glimpsed over someone's shoulder is useless after the first successful pairing.
 */
import { randomInt, timingSafeEqual } from "node:crypto";

const TTL_MS = 10 * 60 * 1000; // codes are valid for 10 minutes

interface Otp {
  code: string;
  expiresAt: number;
}

let current: Otp | null = null;

/** Generate (or replace) the active pairing code and return it. */
export function rotateOtp(): string {
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  current = { code, expiresAt: Date.now() + TTL_MS };
  return code;
}

/** The active code, generating a fresh one if none exists or it has expired. */
export function currentOtp(): { code: string; expiresInMs: number } {
  if (!current || Date.now() > current.expiresAt) rotateOtp();
  return { code: current!.code, expiresInMs: current!.expiresAt - Date.now() };
}

/** Verify a submitted code against the active one (constant-time, expiry-checked). */
export function verifyOtp(code: string): boolean {
  if (!current) return false;
  if (Date.now() > current.expiresAt) {
    current = null;
    return false;
  }
  if (typeof code !== "string" || code.length !== current.code.length) return false;
  return timingSafeEqual(Buffer.from(code), Buffer.from(current.code));
}
