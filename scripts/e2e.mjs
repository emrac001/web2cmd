/**
 * End-to-end smoke test against a running Web2cmd server.
 * Uses Node 24 global fetch + WebSocket. Exits non-zero on any failure.
 *
 *   node scripts/e2e.mjs <baseUrl> <password>
 */
const base = process.argv[2] || "http://127.0.0.1:8787";
const password = process.argv[3] || "testpass123";
const wsBase = base.replace(/^http/, "ws");

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

const log = (...a) => console.log("[e2e]", ...a);

// 1. health
let r = await fetch(`${base}/api/health`);
if (!r.ok) fail("health not ok");
log("health ok");

// 2. unauthorized create should 401
r = await fetch(`${base}/api/sessions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
if (r.status !== 401) fail(`expected 401 without token, got ${r.status}`);
log("auth gate ok (401 without token)");

// 3. login
r = await fetch(`${base}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ password }),
});
if (!r.ok) fail("login failed");
const { token } = await r.json();
if (!token) fail("no token returned");
log("login ok");

const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

// 4. create session in repo root
const cwd = process.cwd();
r = await fetch(`${base}/api/sessions`, { method: "POST", headers: auth, body: JSON.stringify({ cwd, cols: 100, rows: 30 }) });
if (!r.ok) fail(`create session failed: ${r.status}`);
const session = await r.json();
log("session created", session.id);

// 5. WS connect with bad token rejected
const badWs = new WebSocket(`${wsBase}/ws?token=bad&session=${session.id}`);
const badResult = await new Promise((res) => {
  badWs.onopen = () => res("open");
  badWs.onerror = () => res("error");
  badWs.onclose = () => res("close");
});
if (badResult === "open") fail("WS accepted a bad token");
log("WS rejected bad token ok");

// 6. WS connect properly, run a command, expect output
const ws = new WebSocket(`${wsBase}/ws?token=${encodeURIComponent(token)}&session=${session.id}`);
let buf = "";
const got = await new Promise((res) => {
  const timer = setTimeout(() => res(false), 12000);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "output") {
      buf += msg.data;
      if (buf.includes("E2E_MARKER_OK")) {
        clearTimeout(timer);
        res(true);
      }
    }
    if (msg.type === "ready") {
      // give the shell a moment to show a prompt, then run a command
      setTimeout(() => ws.send(JSON.stringify({ type: "input", data: "Write-Output 'E2E_MARKER_OK'\r" })), 800);
    }
  };
  ws.onerror = () => res(false);
});
if (!got) fail("did not observe command output over WS");
log("WS terminal I/O ok (saw command output)");
ws.close();

// 7. resize + sessions list reflects a client
r = await fetch(`${base}/api/sessions`, { headers: auth });
const { sessions } = await r.json();
if (!sessions.find((s) => s.id === session.id)) fail("session missing from list");
log("session list ok");

// 8. filesystem: write + read back within project root
const rel = ".web2cmd_e2e_test.txt";
const content = "hello-" + Date.now();
r = await fetch(`${base}/api/fs/write`, { method: "POST", headers: auth, body: JSON.stringify({ root: cwd, path: rel, content }) });
if (!r.ok) fail("fs write failed");
r = await fetch(`${base}/api/fs/read?root=${encodeURIComponent(cwd)}&path=${encodeURIComponent(rel)}`, { headers: auth });
const read = await r.json();
if (read.content !== content) fail("fs read mismatch");
log("fs read/write ok");

// 9. path traversal rejected
r = await fetch(`${base}/api/fs/read?root=${encodeURIComponent(cwd)}&path=${encodeURIComponent("../../etc/hosts")}`, { headers: auth });
if (r.ok) fail("path traversal was NOT rejected");
log("path traversal rejected ok");

// cleanup session + test file
await fetch(`${base}/api/sessions/${session.id}`, { method: "DELETE", headers: auth });
await fetch(`${base}/api/fs/write`, { method: "POST", headers: auth, body: JSON.stringify({ root: cwd, path: rel, content: "" }) });

log("ALL CHECKS PASSED");
process.exit(0);
