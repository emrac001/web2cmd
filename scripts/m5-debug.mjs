import { SessionManager } from "../server/dist/sessions.js";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mgr = new SessionManager();
let fired = 0;
mgr.setWaitingHandler((_i, snip) => {
  fired++;
  console.log("[debug] HANDLER FIRED:", JSON.stringify(snip));
});
const info = mgr.create({ cwd: process.cwd(), cols: 100, rows: 30 });
const s = mgr.get(info.id);

let raw = "";
s.attach({ id: "dbg", cols: 100, rows: 30, send: (d) => (raw += d) });

await sleep(2200);
raw = "";
s.write("Write-Output 'Do you want to proceed?'\r");
await sleep(3800);

// replicate stripAnsi to see what the matcher sees
const ANSI_RE = new RegExp(
  "\\u001b\\[[0-9;?]*[ -/]*[@-~]|\\u001b\\][\\s\\S]*?(?:\\u0007|\\u001b\\\\)|\\u001b[@-Z\\\\-_]",
  "g",
);
const CTRL_RE = new RegExp("[\\u0000-\\u0009\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g");
const stripped = raw.replace(ANSI_RE, "").replace(CTRL_RE, " ");
console.log("[debug] fired count:", fired);
console.log("[debug] stripped tail (last 300):", JSON.stringify(stripped.slice(-300)));
console.log("[debug] contains 'do you want to ':", /do you want to /i.test(stripped));
mgr.killAll();
await sleep(300);
process.exit(0);
