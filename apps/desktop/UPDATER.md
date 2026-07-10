# Desktop auto-update (maintainers)

## How it works

1. CI builds installers with `createUpdaterArtifacts: true` and signs them with minisign.
2. `tauri-action` uploads installers + `latest.json` (+ `.sig` files) to the GitHub Release.
3. The app polls  
   `https://github.com/N-THEM-Studio/zelari-code/releases/latest/download/latest.json`
4. Settings → **App updates** (or launch check) downloads and installs, then relaunches.

## One-time: signing keys

Already generated once for this repo (public key is in `src-tauri/tauri.conf.json`).

If you need to **rotate** keys:

```bash
cd apps/desktop
npx tauri signer generate -w keys/zelari.key --ci -f
```

1. Copy the **public** key into `tauri.conf.json` → `plugins.updater.pubkey`
2. Set GitHub secret **`TAURI_SIGNING_PRIVATE_KEY`** to the full contents of `keys/zelari.key`
3. Optional: **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`** if you used a password
4. **Never commit** `keys/zelari.key`

> If you lose the private key, clients that only trust the old pubkey cannot verify new updates until users reinstall once with a build that embeds a new pubkey.

## Local signed build

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat apps/desktop/keys/zelari.key)"
# PowerShell: $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content -Raw apps/desktop/keys/zelari.key
cd apps/desktop && npm run tauri:build
```
