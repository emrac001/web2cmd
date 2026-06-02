import { useState } from "react";
import { api, type ServerInfo } from "../lib/api";

/**
 * Shown the first time a remote client reaches an unpaired server. The user reads the pairing
 * code (and, optionally, verifies the identity fingerprint) off the server's own console, enters
 * it here once, and receives a long-lived device token. We pin the server's fingerprint on
 * success so later visits trust the identity rather than the (rotating) tunnel URL.
 */
export function Pairing({ info, onPaired }: { info: ServerInfo; onPaired: () => void }) {
  const [otp, setOtp] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsPassword = info.authMode === "password";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.pair(otp.trim(), needsPassword ? password : undefined, name.trim() || undefined);
      localStorage.setItem("web2cmd_server_fp", info.identity.fingerprint);
      onPaired();
    } catch (err) {
      setError((err as Error).message || "Pairing failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6"
      >
        <h1 className="mb-1 text-xl font-semibold">Pair this device</h1>
        <p className="mb-4 text-sm text-gray-400">
          Enter the pairing code shown on your computer's terminal.
        </p>

        <input
          inputMode="numeric"
          autoFocus
          value={otp}
          onChange={(e) => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="6-digit code"
          className="mb-3 w-full rounded-lg border border-[var(--border)] bg-[#0b0e14] px-3 py-3 text-center text-2xl tracking-[0.4em] outline-none focus:border-[var(--accent)]"
        />

        {needsPassword && (
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            className="mb-3 w-full rounded-lg border border-[var(--border)] bg-[#0b0e14] px-3 py-3 text-base outline-none focus:border-[var(--accent)]"
          />
        )}

        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Your name (shown when you're typing)"
          className="mb-3 w-full rounded-lg border border-[var(--border)] bg-[#0b0e14] px-3 py-3 text-base outline-none focus:border-[var(--accent)]"
        />

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={busy || otp.length < 6 || (needsPassword && !password)}
          className="w-full rounded-lg bg-[var(--accent)] px-3 py-3 font-medium text-black disabled:opacity-50"
        >
          {busy ? "Pairing…" : "Pair"}
        </button>

        <p className="mt-4 break-all text-center text-[11px] leading-relaxed text-gray-500">
          Server identity
          <br />
          <span className="font-mono text-gray-400">{info.identity.fingerprint}</span>
          <br />
          Confirm this matches the line printed on your computer.
        </p>
      </form>
    </div>
  );
}
