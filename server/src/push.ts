/**
 * Web Push delivery. Sends "Claude is waiting" notifications to subscribed phones, even when
 * the tab is backgrounded or the screen is locked.
 *
 * Payloads are end-to-end encrypted by the Web Push spec, so the push service (FCM etc.)
 * can't read the prompt text we include. Subscriptions persist in the data dir; dead ones
 * (HTTP 404/410) are pruned automatically.
 */
import webpush, { type PushSubscription } from "web-push";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeConfig } from "./config.js";
import { saveStored } from "./config.js";

export interface PushPayload {
  title: string;
  body: string;
  sessionId?: string;
  tag?: string;
}

export class PushManager {
  private subs = new Map<string, PushSubscription>();
  private file: string;
  private enabled = false;

  constructor(private cfg: RuntimeConfig) {
    this.file = join(cfg.dataDir, "subscriptions.json");

    // generate + persist VAPID keys on first boot
    if (!cfg.stored.vapid) {
      cfg.stored.vapid = webpush.generateVAPIDKeys();
      saveStored(cfg.dataDir, cfg.stored);
    }
    webpush.setVapidDetails(
      process.env.WEB2CMD_VAPID_SUBJECT || "mailto:web2cmd@localhost",
      cfg.stored.vapid.publicKey,
      cfg.stored.vapid.privateKey,
    );
    this.enabled = true;
    this.load();
  }

  get publicKey(): string {
    return this.cfg.stored.vapid!.publicKey;
  }

  private load() {
    if (existsSync(this.file)) {
      try {
        const arr = JSON.parse(readFileSync(this.file, "utf8")) as PushSubscription[];
        for (const s of arr) this.subs.set(s.endpoint, s);
      } catch {
        /* ignore corrupt store */
      }
    }
  }

  private persist() {
    writeFileSync(this.file, JSON.stringify([...this.subs.values()], null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  subscribe(sub: PushSubscription) {
    if (!sub?.endpoint) return;
    this.subs.set(sub.endpoint, sub);
    this.persist();
  }

  unsubscribe(endpoint: string) {
    if (this.subs.delete(endpoint)) this.persist();
  }

  count(): number {
    return this.subs.size;
  }

  async notifyAll(payload: PushPayload): Promise<{ sent: number; pruned: number }> {
    if (!this.enabled || this.subs.size === 0) return { sent: 0, pruned: 0 };
    const data = JSON.stringify(payload);
    let sent = 0;
    let pruned = 0;
    await Promise.all(
      [...this.subs.values()].map(async (sub) => {
        try {
          await webpush.sendNotification(sub, data, { TTL: 600 });
          sent++;
        } catch (err: any) {
          const code = err?.statusCode;
          if (code === 404 || code === 410) {
            this.subs.delete(sub.endpoint);
            pruned++;
          }
        }
      }),
    );
    if (pruned) this.persist();
    return { sent, pruned };
  }
}
