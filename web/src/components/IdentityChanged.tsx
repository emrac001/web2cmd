import { type ServerInfo } from "../lib/api";

/**
 * Hard stop shown when the server's identity fingerprint no longer matches the one this client
 * pinned at pairing. Either the server's keypair legitimately changed (e.g. data dir reset) or
 * something is impersonating it. We refuse to proceed silently; the user must consciously reset
 * the pin and re-pair.
 */
export function IdentityChanged({
  info,
  pinned,
  onReset,
}: {
  info: ServerInfo;
  pinned: string;
  onReset: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-sm rounded-xl border border-red-500/60 bg-[var(--panel)] p-6">
        <h1 className="mb-2 text-xl font-semibold text-red-400">⚠ Server identity changed</h1>
        <p className="mb-4 text-sm text-gray-300">
          This server's identity does not match the one you previously trusted. If you did not
          just reset or reinstall the server, <strong>do not continue</strong> — someone may be
          impersonating it.
        </p>
        <div className="mb-4 space-y-2 text-[11px]">
          <div>
            <div className="text-gray-500">Previously trusted</div>
            <div className="break-all font-mono text-gray-400">{pinned}</div>
          </div>
          <div>
            <div className="text-gray-500">Now claiming</div>
            <div className="break-all font-mono text-yellow-400">{info.identity.fingerprint}</div>
          </div>
        </div>
        <button
          onClick={onReset}
          className="w-full rounded-lg border border-red-500/60 px-3 py-3 text-sm font-medium text-red-300"
        >
          I trust this — reset and re-pair
        </button>
      </div>
    </div>
  );
}
