/**
 * Server identity.
 *
 * On first boot the server generates a stable ed25519 keypair and persists it alongside the
 * other secrets in config.json. Clients pin the server's public-key *fingerprint* at pairing
 * time (SSH `known_hosts` style / TOFU), so they trust the server's *identity* rather than its
 * URL — which matters because a tunnel (e.g. trycloudflare) hands out a fresh URL on every
 * restart. The signing helper lets the server prove ownership of that identity to a client
 * holding the pinned fingerprint (used by the pairing flow in a later phase).
 */
import { createHash, createPublicKey, generateKeyPairSync, sign as edSign } from "node:crypto";
import type { RuntimeConfig } from "./config.js";
import { saveStored } from "./config.js";

export interface IdentityKeys {
  /** SPKI PEM of the ed25519 public key. */
  publicKey: string;
  /** PKCS8 PEM of the ed25519 private key. Never leaves the server. */
  privateKey: string;
}

/** Ensure the server has an identity keypair, generating + persisting one on first boot. */
export function ensureIdentity(cfg: RuntimeConfig): IdentityKeys {
  if (cfg.stored.identity?.publicKey && cfg.stored.identity?.privateKey) {
    return cfg.stored.identity;
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  cfg.stored.identity = { publicKey, privateKey };
  saveStored(cfg.dataDir, cfg.stored);
  return cfg.stored.identity;
}

/**
 * Stable, human-comparable fingerprint of a public key: `SHA256:<base64url(sha256(DER))>`,
 * matching the shape OpenSSH prints. This is what a client pins.
 */
export function fingerprint(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const digest = createHash("sha256").update(der).digest("base64url");
  return `SHA256:${digest}`;
}

/** Sign a challenge with the server's identity key (ed25519 → algorithm must be null). */
export function signChallenge(cfg: RuntimeConfig, data: Buffer): Buffer {
  const key = ensureIdentity(cfg).privateKey;
  return edSign(null, data, key);
}
