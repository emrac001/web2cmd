/**
 * Unit test for the "Claude is waiting" detector. Spawns real pwsh sessions via the compiled
 * SessionManager, waits for the shell prompt and past the detector's startup grace, prints
 * prompt-like text, and asserts:
 *   - ordinary output does NOT trigger waiting
 *   - a confirmation-style prompt triggers waiting exactly once
 *   - detection re-arms after the user responds
 *
 *   node scripts/m5-detect.mjs
 */
import { SessionManager } from "../server/dist/sessions.js";

const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};
const log = (...a) => console.log("[m5-detect]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTLE = 3800; // > idle window (1200ms), lets detection fire after output stops

const fired = new Map(); // sessionId -> { count, snippet }
const mgr = new SessionManager();
mgr.setWaitingHandler((info, snippet) => {
  const f = fired.get(info.id) || { count: 0, snippet: "" };
  f.count++;
  f.snippet = snippet;
  fired.set(info.id, f);
});

function makeSession() {
  const info = mgr.create({ cwd: process.cwd(), cols: 100, rows: 30 });
  const s = mgr.get(info.id);
  const cap = { buf: "" };
  s.attach({ id: "cap", cols: 100, rows: 30, send: (d) => (cap.buf += d) });
  return { info, s, cap };
}

// wait for the pwsh prompt, then settle past the detector's 1500ms startup grace
async function waitForPrompt(cap, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (cap.buf.includes("Web2cmd>")) {
      await sleep(1700);
      return true;
    }
    await sleep(150);
  }
  return false;
}

// Case 1: ordinary output should NOT trigger waiting.
{
  const { info, s, cap } = makeSession();
  if (!(await waitForPrompt(cap))) fail("shell never became ready (case 1)");
  s.write("Write-Output 'just some normal output here'\r");
  await sleep(SETTLE);
  if (fired.get(info.id))
    fail(`waiting fired on ordinary output: ${JSON.stringify(fired.get(info.id))}`);
  log("ordinary output did not trigger waiting ok");
}

// Case 2 + 3: a confirmation-style prompt triggers waiting once; re-arms after input.
{
  const { info, s, cap } = makeSession();
  if (!(await waitForPrompt(cap))) fail("shell never became ready (case 2)");
  s.write("Write-Output 'Do you want to proceed?'\r");
  await sleep(SETTLE);
  const f = fired.get(info.id);
  if (!f || f.count < 1) fail("waiting did not fire on a prompt-like screen");
  if (f.count > 1) fail(`waiting fired ${f.count} times (should latch to once)`);
  if (!/proceed|do you want/i.test(f.snippet)) fail(`unexpected snippet: ${JSON.stringify(f.snippet)}`);
  log(`prompt triggered waiting once ok (snippet: ${JSON.stringify(f.snippet)})`);

  s.write("\r"); // user "responds" -> re-arm
  await sleep(600);
  s.write("Write-Output 'Do you want to proceed?'\r");
  await sleep(SETTLE);
  if ((fired.get(info.id)?.count ?? 0) < 2) fail("waiting did not re-arm after user input");
  log("re-arms after user responds ok");
}

mgr.killAll();
log("ALL M5 DETECTION CHECKS PASSED");
setTimeout(() => process.exit(0), 300);
