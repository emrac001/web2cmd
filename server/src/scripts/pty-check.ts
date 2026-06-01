/**
 * Smoke test: confirm node-pty loads (native ConPTY binding) and can spawn pwsh,
 * run a command, and stream output back. Exits non-zero on failure.
 */
import * as pty from "node-pty";

const shell = process.platform === "win32" ? "pwsh.exe" : "bash";

console.log(`[pty-check] node ${process.version} on ${process.platform}/${process.arch}`);
console.log(`[pty-check] spawning ${shell} ...`);

const term = pty.spawn(shell, ["-NoLogo", "-Command", "Write-Output 'PTY_OK'; exit"], {
  name: "xterm-color",
  cols: 80,
  rows: 24,
  cwd: process.cwd(),
  env: process.env as Record<string, string>,
});

let buf = "";
const timer = setTimeout(() => {
  console.error("[pty-check] FAILED: timed out waiting for output");
  term.kill();
  process.exit(1);
}, 15000);

term.onData((d) => {
  buf += d;
  process.stdout.write(d);
});

term.onExit(({ exitCode }) => {
  clearTimeout(timer);
  if (buf.includes("PTY_OK")) {
    console.log(`\n[pty-check] SUCCESS (pwsh exited ${exitCode})`);
    process.exit(0);
  } else {
    console.error(`\n[pty-check] FAILED: expected marker not found (exit ${exitCode})`);
    process.exit(1);
  }
});
