# Code-signing `web2cmd.exe`

Releases are signed with **[SignPath](https://signpath.io)**, which offers **free certified code
signing for open-source projects**. The release workflow signs automatically *once you've done the
one-time setup below*; until then it ships the `.exe` **unsigned** (which still works — Windows
SmartScreen just warns about an unknown publisher).

> Why a real cert: a signature only clears Windows' "unknown publisher" warning if it chains to a
> CA Windows trusts. SignPath's OSS program provides exactly that, at no cost.

## One-time setup

1. **Apply for the SignPath open-source program** at <https://signpath.org> (the free OSS plan).
   Approval is manual and can take a few days. You'll get a SignPath **organization**.

2. **Install the SignPath GitHub App** on the `web2cmd` repo (SignPath → Connectors → GitHub).
   This lets SignPath pull the build artifact and verify it came from this repo's CI.

3. In SignPath, create:
   - a **Project** with slug **`web2cmd`**,
   - an **Artifact configuration** for a single Windows executable (PE / Authenticode),
   - a **Signing policy** with slug **`release-signing`**, bound to the OSS code-signing
     certificate SignPath issues you.

   > The slugs **`web2cmd`** and **`release-signing`** must match
   > `.github/workflows/release.yml`. If you name them differently, edit `project-slug` /
   > `signing-policy-slug` there.

4. Create a **CI API token** (SignPath → Settings → API tokens) and add two **GitHub repo
   secrets** (Settings → Secrets and variables → Actions):
   - `SIGNPATH_API_TOKEN` — the API token
   - `SIGNPATH_ORGANIZATION_ID` — your SignPath organization ID

## Cutting a signed release

```bash
git tag v0.2.0 && git push --tags
```

The workflow then: builds `web2cmd.exe` → uploads it → submits it to SignPath → waits for the
signed result → attaches the **signed** binary to the GitHub Release. The release notes show
`(signed)` vs `(UNSIGNED)` so you can tell at a glance.

## Notes

- **Local builds** (`pnpm build:exe`) are **not** signed — SignPath signs in CI only. That's fine
  for development.
- Signing also **fixes the "signature seems corrupted" warning** from `postject`: re-signing the
  binary after the SEA blob is injected replaces Node's now-invalid signature with a valid one.
- Reputation: even correctly signed, a brand-new publisher may see SmartScreen caution until the
  binary builds download reputation. This fades with downloads over time.
