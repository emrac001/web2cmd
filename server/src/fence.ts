/**
 * Project fence.
 *
 * Keeps a session's shell anchored inside the chosen project folder. The authoritative check
 * lives here on the server; the PowerShell layer (see the generated fence script) consults it
 * before every `cd`/`Set-Location`/`pushd`, and Claude's PreToolUse hook consults the same rule
 * for its tool calls. A path inside the root is always fine; anything outside is denied unless the
 * operator has approved it — once, or permanently ("don't ask again").
 *
 * HONEST CAVEAT — the shell fence is a NUDGE, not a security boundary. It only overrides the
 * cd/Set-Location/pushd aliases, so it stops *accidental* drift out of the project. It does NOT
 * contain a determined user: calling the cmdlet by its module-qualified name, deleting the
 * override function, or simply reading/writing files outside the root with no `cd` at all
 * (Get-Content/Set-Content are unguarded) all escape it. With no OS-level sandbox (a deliberate
 * project choice) the shell cannot be a real jail. The actual boundaries are pairing/auth (who
 * can connect) and the FS API (which IS hard-fenced via resolveInRoot). Verified by adversarial
 * test 2026-06-01. See the threat-model section of the README (Phase 6) for the full picture.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export type GrantMode = "once" | "always";

export interface FenceDenial {
  root: string;
  target: string;
  at: number;
}

/** True if `target` is the root itself or lives somewhere beneath it. */
export function isUnderRoot(root: string, target: string): boolean {
  const r = relative(resolve(root), resolve(target));
  if (r === "") return true;
  return !r.startsWith("..") && !isAbsolute(r) && !r.split(sep).includes("..");
}

function projectKey(root: string): string {
  return createHash("sha1").update(resolve(root).toLowerCase()).digest("hex").slice(0, 16);
}

interface Persisted {
  /** per-project list of permanently-approved absolute paths ("don't ask again") */
  allow: Record<string, string[]>;
}

export class FenceManager {
  /** shared secret the PowerShell fence script uses to authenticate its check calls */
  readonly secret = randomBytes(24).toString("hex");

  private file: string;
  private data: Persisted = { allow: {} };
  private once = new Map<string, Set<string>>(); // projectKey -> one-time-approved abs paths
  private denials: FenceDenial[] = []; // recent denials, newest last (for the client to show)

  constructor(private dataDir: string) {
    this.file = join(dataDir, "fence.json");
    if (existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, "utf8")) as Partial<Persisted>;
        if (parsed.allow) this.data.allow = parsed.allow;
      } catch {
        /* corrupt fence file — start with an empty allowlist */
      }
    }
  }

  private save(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), { encoding: "utf8", mode: 0o600 });
    } catch {
      /* best-effort persistence */
    }
  }

  private allowedPermanently(root: string, target: string): boolean {
    const list = this.data.allow[projectKey(root)] ?? [];
    return list.some((p) => isUnderRoot(p, target));
  }

  /**
   * Decide whether the shell/Claude may operate on `target`. In-root is always allowed; an
   * out-of-root path is allowed only if permanently approved or holding a one-time grant (which
   * is consumed here). Otherwise it's denied and recorded for the operator to review.
   */
  check(root: string, target: string): { allowed: boolean; reason: string } {
    const abs = resolve(target);
    if (isUnderRoot(root, abs)) return { allowed: true, reason: "in-root" };
    if (this.allowedPermanently(root, abs)) return { allowed: true, reason: "allowlisted" };

    const key = projectKey(root);
    const grants = this.once.get(key);
    if (grants) {
      for (const g of grants) {
        if (isUnderRoot(g, abs)) {
          grants.delete(g);
          return { allowed: true, reason: "approved-once" };
        }
      }
    }

    this.denials.push({ root: resolve(root), target: abs, at: Date.now() });
    if (this.denials.length > 25) this.denials.shift();
    return { allowed: false, reason: "blocked" };
  }

  /** Approve an out-of-root path: `once` (single use) or `always` (persisted allowlist). */
  grant(root: string, path: string, mode: GrantMode): void {
    const abs = resolve(path);
    const key = projectKey(root);
    if (mode === "always") {
      const list = (this.data.allow[key] ??= []);
      if (!list.includes(abs)) list.push(abs);
      this.save();
    } else {
      if (!this.once.has(key)) this.once.set(key, new Set());
      this.once.get(key)!.add(abs);
    }
  }

  listDenials(): FenceDenial[] {
    return [...this.denials].reverse(); // newest first
  }

  listAllow(root: string): string[] {
    return [...(this.data.allow[projectKey(root)] ?? [])];
  }
}

/**
 * Generate the PowerShell fence script. Dot-sourced at shell startup, it overrides the
 * directory-changing commands so each one resolves its target and asks the server (over
 * localhost, authenticated by the fence secret) before moving. On a refusal it stays put and
 * prints how to approve; if the server is unreachable it fails safe (in-root only).
 */
export function fenceScript(): string {
  return String.raw`# Web2cmd project fence — auto-generated. Overrides cd/Set-Location/pushd.
# Dot-sourced into the interactive session, so state lives in $global: and functions are global.
$global:W2CUrl = $env:WEB2CMD_FENCE_URL
$global:W2CSecret = $env:WEB2CMD_FENCE_SECRET
try { $global:W2CRoot = (Resolve-Path -LiteralPath $env:WEB2CMD_FENCE_ROOT -ErrorAction Stop).Path }
catch { $global:W2CRoot = $env:WEB2CMD_FENCE_ROOT }

function W2C-Resolve([string]$target) {
  if ([string]::IsNullOrEmpty($target) -or $target -eq '~') { $target = $HOME }
  try { return (Resolve-Path -LiteralPath $target -ErrorAction Stop).Path }
  catch { return [System.IO.Path]::GetFullPath([System.IO.Path]::Combine((Get-Location).Path, $target)) }
}

function W2C-Check([string]$abs) {
  try {
    $body = @{ root = $global:W2CRoot; target = $abs; secret = $global:W2CSecret } | ConvertTo-Json -Compress
    $r = Invoke-RestMethod -Uri "$global:W2CUrl/api/fence/check" -Method Post -Body $body -ContentType 'application/json' -TimeoutSec 5
    return [bool]$r.allowed
  } catch {
    # Server unreachable: fail safe — permit only paths under the project root.
    $rootL = $global:W2CRoot.ToLowerInvariant()
    return ($abs.ToLowerInvariant() + [IO.Path]::DirectorySeparatorChar).StartsWith($rootL)
  }
}

function W2C-Guarded([string]$Path, [string]$verb) {
  $abs = W2C-Resolve $Path
  if (W2C-Check $abs) {
    & "Microsoft.PowerShell.Management\$verb" -LiteralPath $abs
  } else {
    Write-Host "web2cmd: blocked leaving the project root -> $abs" -ForegroundColor Yellow
    Write-Host "         approve it in the app (Fence), then run the command again." -ForegroundColor DarkGray
  }
}

function Set-Location { param([Parameter(Position = 0)][string]$Path) W2C-Guarded $Path 'Set-Location' }
function Push-Location { param([Parameter(Position = 0)][string]$Path) W2C-Guarded $Path 'Push-Location' }
Set-Alias -Name cd -Value Set-Location -Option AllScope -Force -Scope Global
Set-Alias -Name sl -Value Set-Location -Option AllScope -Force -Scope Global
Set-Alias -Name chdir -Value Set-Location -Option AllScope -Force -Scope Global
Set-Alias -Name pushd -Value Push-Location -Option AllScope -Force -Scope Global
`;
}

/** Write the fence script into the data dir and return its absolute path. */
export function writeFenceScript(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "fence.ps1");
  writeFileSync(path, fenceScript(), { encoding: "utf8" });
  return path;
}

/**
 * Install the Claude PreToolUse fence hook into a project's .claude/settings.json, merging with
 * any existing config and skipping if our hook is already present. Returns whether it changed
 * anything plus the settings path. Opt-in — never called automatically.
 */
export function installClaudeHook(
  root: string,
  hookScriptPath: string,
): { installed: boolean; alreadyPresent: boolean; settingsPath: string } {
  const dir = join(resolve(root), ".claude");
  const settingsPath = join(dir, "settings.json");
  const command = `node "${hookScriptPath}" "${resolve(root)}"`;

  let settings: any = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8")) || {};
    } catch {
      throw new Error("existing .claude/settings.json is not valid JSON; refusing to overwrite");
    }
  }

  settings.hooks ??= {};
  settings.hooks.PreToolUse ??= [];
  const groups: any[] = settings.hooks.PreToolUse;

  const already = groups.some((g) =>
    (g?.hooks ?? []).some((h: any) => typeof h?.command === "string" && h.command.includes("fence-hook.mjs")),
  );
  if (already) return { installed: false, alreadyPresent: true, settingsPath };

  groups.push({ matcher: "*", hooks: [{ type: "command", command }] });
  mkdirSync(dir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: "utf8" });
  return { installed: true, alreadyPresent: false, settingsPath };
}
