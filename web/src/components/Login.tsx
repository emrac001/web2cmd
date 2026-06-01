import { useState } from "react";
import { api } from "../lib/api";

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      onAuthed();
    } catch {
      setError("Incorrect password");
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
        <h1 className="mb-1 text-xl font-semibold">Web2cmd</h1>
        <p className="mb-5 text-sm text-gray-400">Sign in to control your laptop's terminal.</p>
        <input
          type="password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className="mb-3 w-full rounded-lg border border-[var(--border)] bg-[#0b0e14] px-3 py-3 text-base outline-none focus:border-[var(--accent)]"
        />
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-lg bg-[var(--accent)] px-3 py-3 font-medium text-black disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
