/** Do two concurrent PTY sessions stay isolated, or does ConPTY cross-talk on this Windows build? */
import { SessionManager } from "../server/dist/sessions.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mgr = new SessionManager();
function mk() {
  const info = mgr.create({ cwd: process.cwd(), cols: 100, rows: 30 });
  const s = mgr.get(info.id);
  const cap = { buf: "" };
  s.attach({ id: "c", cols: 100, rows: 30, send: (d) => (cap.buf += d) });
  return { s, cap };
}
async function ready(cap) {
  for (let i = 0; i < 80; i++) {
    if (cap.buf.includes("Web2cmd>")) return;
    await sleep(150);
  }
}

const a = mk();
const b = mk();
await ready(a.cap);
await ready(b.cap);
a.cap.buf = "";
b.cap.buf = "";
a.s.write("Write-Output 'AAA_ONLY'\r");
b.s.write("Write-Output 'BBB_ONLY'\r");
await sleep(2500);

const aHasA = a.cap.buf.includes("AAA_ONLY");
const aHasB = a.cap.buf.includes("BBB_ONLY");
const bHasA = b.cap.buf.includes("AAA_ONLY");
const bHasB = b.cap.buf.includes("BBB_ONLY");
console.log(`[iso] session A: hasA=${aHasA} hasB=${aHasB}`);
console.log(`[iso] session B: hasA=${bHasA} hasB=${bHasB}`);
console.log(`[iso] VERDICT: ${aHasA && bHasB && !aHasB && !bHasA ? "ISOLATED ✅" : "CROSS-TALK ❌"}`);
mgr.killAll();
setTimeout(() => process.exit(0), 300);
