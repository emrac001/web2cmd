/**
 * Verifies the shared-live-session behaviour (requirement #6):
 *  - two clients on the SAME session both receive output (live mirror)
 *  - a late-joining client gets scrollback replay (sees prior output immediately)
 *  - the PTY survives a client disconnect (session stays alive, reattach works)
 *
 *   node scripts/m2-verify.mjs <baseUrl> <password>
 */
const base = process.argv[2] || "http://127.0.0.1:8787";
const password = process.argv[3] || "testpass123";
const wsBase = base.replace(/^http/, "ws");

const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};
const log = (...a) => console.log("[m2]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { token } = await (
  await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })
).json();
if (!token) fail("login failed");

const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };
const session = await (
  await fetch(`${base}/api/sessions`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ cwd: process.cwd(), cols: 100, rows: 30 }),
  })
).json();
log("session", session.id);

function client(name) {
  const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}&session=${session.id}`);
  const c = { ws, name, buf: "", ready: false };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === "output") c.buf += m.data;
    if (m.type === "ready") c.ready = true;
  };
  return c;
}

// 1. two simultaneous clients
const a = client("A");
const b = client("B");
await sleep(1500);
if (!a.ready || !b.ready) fail("clients not ready");

const marker = "MIRROR_" + Date.now();
a.ws.send(JSON.stringify({ type: "input", data: `Write-Output '${marker}'\r` }));
await sleep(2500);
if (!a.buf.includes(marker)) fail("client A did not see its own output");
if (!b.buf.includes(marker)) fail("client B did not mirror client A's output");
log("live mirror ok (both clients saw output from one)");

// 2. late-joining client gets scrollback replay
const c = client("C");
await sleep(1500);
if (!c.buf.includes(marker)) fail("late client C did not receive scrollback replay");
log("scrollback replay ok (late client sees prior output)");

// 3. disconnect a client; session stays alive; reattach works
a.ws.close();
b.ws.close();
c.ws.close();
await sleep(800);
const { sessions } = await (await fetch(`${base}/api/sessions`, { headers: auth })).json();
const still = sessions.find((s) => s.id === session.id);
if (!still || !still.alive) fail("session died after all clients disconnected");
log("session survives disconnect ok");

const d = client("D");
await sleep(1500);
if (!d.buf.includes(marker)) fail("reattached client did not get state back");
log("reattach ok");
d.ws.close();

// cleanup
await fetch(`${base}/api/sessions/${session.id}`, { method: "DELETE", headers: auth });
log("ALL M2 CHECKS PASSED");
process.exit(0);
