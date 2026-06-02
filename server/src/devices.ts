/**
 * Device registry — the operator-gated successor to "pair once, valid forever".
 *
 * Every paired client gets a persisted record; its device token carries the record id. Access
 * checks consult this registry, so the operator can LIST connected clients, REVOKE any of them
 * (unpair), and CAP how many may pair at once ("channels"). Revocation is real: a revoked id is
 * rejected on the very next request even though its JWT is still cryptographically valid.
 *
 * Stored in <dataDir>/devices.json.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface DeviceRecord {
  id: string;
  displayName: string | null;
  createdAt: number;
  lastSeen: number;
  revoked: boolean;
}

interface Persisted {
  maxDevices: number; // 0 = unlimited
  devices: DeviceRecord[];
}

export class DeviceManager {
  private file: string;
  private data: Persisted = { maxDevices: 0, devices: [] };

  constructor(private dataDir: string) {
    this.file = join(dataDir, "devices.json");
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted>;
        this.data = {
          maxDevices: typeof parsed.maxDevices === "number" ? parsed.maxDevices : 0,
          devices: Array.isArray(parsed.devices) ? parsed.devices : [],
        };
      } catch {
        /* corrupt registry — start empty */
      }
    }
  }

  private save(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }

  /** Number of currently-paired (non-revoked) devices. */
  activeCount(): number {
    return this.data.devices.filter((d) => !d.revoked).length;
  }

  getMax(): number {
    return this.data.maxDevices;
  }
  setMax(n: number): void {
    this.data.maxDevices = Math.max(0, Math.floor(n));
    this.save();
  }

  /** Create a new device record. Throws "device limit reached" if the cap is hit. */
  create(displayName?: string | null): DeviceRecord {
    if (this.data.maxDevices > 0 && this.activeCount() >= this.data.maxDevices) {
      throw new Error("device limit reached");
    }
    const now = Date.now();
    const rec: DeviceRecord = {
      id: randomUUID(),
      displayName: displayName?.trim() || null,
      createdAt: now,
      lastSeen: now,
      revoked: false,
    };
    this.data.devices.push(rec);
    this.save();
    return rec;
  }

  get(id: string): DeviceRecord | undefined {
    return this.data.devices.find((d) => d.id === id);
  }

  /** A device id is valid for access iff it exists and isn't revoked. */
  isValid(id: string | undefined | null): boolean {
    if (!id) return false;
    const d = this.get(id);
    return Boolean(d && !d.revoked);
  }

  /** Mark a device as seen now (cheap; persisted). */
  touch(id: string): void {
    const d = this.get(id);
    if (d) {
      d.lastSeen = Date.now();
      this.save();
    }
  }

  revoke(id: string): boolean {
    const d = this.get(id);
    if (!d || d.revoked) return false;
    d.revoked = true;
    this.save();
    return true;
  }

  /** All records (including revoked, flagged) — newest first. */
  list(): DeviceRecord[] {
    return [...this.data.devices].sort((a, b) => b.createdAt - a.createdAt);
  }
}
