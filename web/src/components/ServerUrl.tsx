import { useState } from "react";

/**
 * Shown when the app is hosted standalone (e.g. GitHub Pages) and doesn't yet know which Web2cmd
 * server to talk to. The user pastes their server's URL (their tunnel or LAN address). Because the
 * client trusts the server *identity* (pinned at pairing), the URL can change freely later — only
 * this field needs updating when the tunnel hands out a new address.
 */
export function ServerUrl({
  current,
  error,
  onSet,
}: {
  current: string;
  error?: string | null;
  onSet: (url: string) => void;
}) {
  const [url, setUrl] = useState(current);
  const valid = /^https?:\/\/.+/i.test(url.trim());

  return (
    <div className="flex h-full items-center justify-center p-6">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSet(url.trim());
        }}
        className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6"
      >
        <h1 className="mb-1 text-xl font-semibold">Connect to your server</h1>
        <p className="mb-4 text-sm text-gray-400">
          Enter the address of your Web2cmd server — your tunnel URL (e.g.
          <span className="text-gray-300"> https://xyz.trycloudflare.com</span>) or LAN address.
        </p>
        <input
          autoFocus
          inputMode="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://your-server…"
          className="mb-3 w-full rounded-lg border border-[var(--border)] bg-[#0b0e14] px-3 py-3 text-base outline-none focus:border-[var(--accent)]"
        />
        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={!valid}
          className="w-full rounded-lg bg-[var(--accent)] px-3 py-3 font-medium text-black disabled:opacity-50"
        >
          Connect
        </button>
      </form>
    </div>
  );
}
