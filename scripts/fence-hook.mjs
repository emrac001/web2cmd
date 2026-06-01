#!/usr/bin/env node
/**
 * Web2cmd Claude PreToolUse fence hook.
 *
 * Installed into a project's .claude/settings.json, this runs before each of Claude's tool calls
 * and blocks ones that would operate outside the project root — the same rule the shell fence and
 * FS API enforce, applied to Claude. It reads the hook payload as JSON on stdin; to block, it
 * writes a reason to stderr and exits 2 (Claude shows the reason and skips the tool). Exit 0 = allow.
 *
 * Usage (configured by the installer):  node fence-hook.mjs <project-root>
 *
 * Scope: blocks file tools (Write/Edit/MultiEdit/Read/NotebookEdit) whose path leaves the root,
 * and Bash commands that `cd`/`pushd`/`Set-Location`/`chdir` out of the root. It does NOT parse
 * arbitrary shell redirection — like the rest of the fence, it's a soft guard, not a jail.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] || process.cwd());

function underRoot(target) {
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const r = relative(root, abs);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r) && !r.split(sep).includes(".."));
}

function block(reason) {
  process.stderr.write(`web2cmd fence: ${reason}`);
  process.exit(2);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let payload = {};
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    process.exit(0); // can't parse — don't get in the way
  }
  const tool = payload.tool_name || "";
  const input = payload.tool_input || {};

  // Structured file tools carry an explicit path.
  const pathField = input.file_path ?? input.notebook_path ?? input.path;
  if (pathField && typeof pathField === "string" && !underRoot(pathField)) {
    block(`'${tool}' targets a path outside the project root: ${pathField}`);
  }

  // Bash: catch directory changes that escape the root.
  if (tool === "Bash" && typeof input.command === "string") {
    const re = /(?:^|[;&|]|\b)\s*(?:cd|pushd|chdir|Set-Location|sl)\s+(?:-LiteralPath\s+|-Path\s+)?["']?([^"';&|\n]+)/gi;
    let m;
    while ((m = re.exec(input.command))) {
      const target = m[1].trim();
      if (target === "-" || target.startsWith("$")) continue; // `cd -` / variables — can't resolve statically
      if (!underRoot(target)) {
        block(`Bash command changes directory outside the project root: ${target}`);
      }
    }
  }

  process.exit(0);
});
