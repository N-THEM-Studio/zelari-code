# Zelari Companion (Android)

Thin Android client for **[zelari-code serve](../../docs/decisions/0015-companion-host-serve.md)** — same chat flow as Zelari Desktop, over **Tailscale** (or LAN).

The agent still runs on your PC (repo, tools, API keys). The phone only streams UI.

```
Phone (this app)  --Tailscale-->  PC: zelari-code serve  -->  headless agent
```

## Features (MVP)

- **Scan QR** from Zelari Desktop (URL + token in one step)
- Connect with host URL + bearer token
- Project picker (host allowlist)
- Mode: kraken / council / zelari (`agent` accepted as alias)
- Phase: plan / build
- Multi-turn chat + SSE event stream
- Cancel active run
- Credentials stored in DataStore

## Prerequisites

| Piece | Notes |
|-------|--------|
| PC | `zelari-code` **≥ 1.25** (`serve` subcommand), Tailscale up |
| Phone | Same Tailscale tailnet |
| Android Studio | Ladybug+ / SDK 35, JDK 17+ |

## 1. Start the host on the PC

```bash
# From monorepo (or global install after build:cli)
npm run build:cli

# Use your Tailscale IPv4 (from `tailscale ip -4`)
zelari-code serve --bind 100.x.y.z --port 7421 --project Z:\path\to\repo
```

On first start, the token is printed and saved to:

`~/.zelari-code/companion.token`

Verify from the PC:

```bash
curl http://100.x.y.z:7421/health
curl -H "Authorization: Bearer <token>" http://100.x.y.z:7421/v1/projects
```

## 2. Build / run the app

### Android Studio

1. **Open** folder `apps/companion-android`
2. Let Gradle sync
3. Run on device/emulator (API 26+)

### CLI

```bash
cd apps/companion-android

# Once: generate wrapper if missing
# (Android Studio creates it on first open; or use the script below)

set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
set ANDROID_HOME=C:\dev\Android_Studio   # or your SDK path

.\gradlew.bat assembleDebug
```

APK:

`app/build/outputs/apk/debug/app-debug.apk`

Install:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

## 3. Pair from Zelari Desktop (recommended)

1. PC: **Settings → Connections → Mobile connection**
2. Bind **phone / Tailscale / LAN** (`0.0.0.0`), start serve
3. Phone + PC on the **same Tailscale tailnet**
4. In the app tap **Scan QR from Desktop**

Manual fallback:

1. **Host URL** — the **Phone URL** shown in Desktop (`http://100.x.y.z:7421`), never `127.0.0.1`
2. **Token** — contents of `companion.token`
3. **Connect**
4. Pick project → mode/phase → send prompts

## Security notes

- Prefer **Tailscale bind** (`100.x`), not `0.0.0.0` on the public internet
- Token is a secret — don’t commit it
- Cleartext HTTP is allowed for tailnet IPs (see `network_security_config.xml`)

## API used

| Method | Path |
|--------|------|
| GET | `/health` |
| GET | `/v1/projects` |
| POST | `/v1/runs` |
| GET | `/v1/runs/:id/events` (SSE) |
| POST | `/v1/runs/:id/cancel` |

## Roadmap

- Skills picker / @path remote
- Push notification when run completes
- Play Store packaging

## License

Apache-2.0 — same monorepo as zelari-code.
