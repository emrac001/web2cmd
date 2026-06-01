/**
 * Verifies the push REST API + PWA static assets against a running server.
 *   node scripts/m5-push.mjs <baseUrl> <password>
 */
const base = process.argv[2] || "http://127.0.0.1:8787";
const password = process.argv[3] || "testpass123";
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};
const log = (...a) => console.log("[m5-push]", ...a);

const { token } = await (
  await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })
).json();
if (!token) fail("login failed");
const auth = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

// 1. VAPID public key
const key = await (await fetch(`${base}/api/push/key`, { headers: auth })).json();
if (!key.publicKey || key.publicKey.length < 80) fail(`bad VAPID key: ${JSON.stringify(key)}`);
log(`VAPID key ok (${key.publicKey.length} chars)`);

// 2. push key requires auth
const noauth = await fetch(`${base}/api/push/key`);
if (noauth.status !== 401) fail(`push/key not protected (got ${noauth.status})`);
log("push endpoints require auth ok");

// 3. subscribe (fake but well-formed subscription)
const sub = {
  endpoint: "https://example.com/web2cmd-test-endpoint",
  keys: { p256dh: "BJ" + "A".repeat(85), auth: "A".repeat(22) },
};
let r = await (
  await fetch(`${base}/api/push/subscribe`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ subscription: sub }),
  })
).json();
if (!r.ok || r.count < 1) fail(`subscribe failed: ${JSON.stringify(r)}`);
log(`subscribe ok (count=${r.count})`);

// 4. test send returns a shape (delivery to the fake endpoint will fail; that's fine)
r = await (
  await fetch(`${base}/api/push/test`, { method: "POST", headers: auth, body: "{}" })
).json();
if (typeof r.sent !== "number" || typeof r.pruned !== "number")
  fail(`unexpected test result: ${JSON.stringify(r)}`);
log(`push/test ok (sent=${r.sent} pruned=${r.pruned})`);

// 5. unsubscribe
r = await (
  await fetch(`${base}/api/push/unsubscribe`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ endpoint: sub.endpoint }),
  })
).json();
if (!r.ok) fail("unsubscribe failed");
log(`unsubscribe ok (count=${r.count})`);

// 6. PWA static assets served
for (const [path, must] of [
  ["/sw.js", "addEventListener"],
  ["/manifest.webmanifest", "Web2cmd"],
  ["/icon.svg", "<svg"],
]) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  if (!res.ok || !text.includes(must)) fail(`asset ${path} missing or wrong (status ${res.status})`);
  log(`asset ${path} served ok`);
}

log("ALL M5 PUSH CHECKS PASSED");
process.exit(0);
