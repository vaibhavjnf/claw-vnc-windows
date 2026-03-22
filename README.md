# claw-vnc

> Browser-based Windows remote desktop portal — VNC, terminal, files, mic/audio/camera, per-window AI streaming, and **Ask Claude** vision assistant. Built for Tailscale. Designed like Apple.

---

## What it does

| Feature | Details |
|---------|---------|
| **Desktop** | Full VNC remote desktop with dual-monitor D1/D2 split view |
| **Terminal** | Persistent PowerShell session in the browser |
| **Files** | Browse, download, upload files on the remote machine |
| **Window Stream** | Per-window JPEG stream with live mouse + keyboard control |
| **Ask Claude** | AI vision — ask anything about what's on screen (streams answer live) |
| **Mic relay** | Send browser mic audio into the remote machine |
| **System audio** | Stream remote system audio to the browser |
| **Camera relay** | Send browser camera feed to the remote machine |
| **PWA** | Installable as an app on iOS, Android, and desktop |

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| **Node.js 18+** | https://nodejs.org |
| **TightVNC Server** | https://www.tightvnc.com/download.php — runs on `:5900` |
| **Claude Code CLI** | `npm install -g @anthropic-ai/claude-code` then `claude login` |
| **Tailscale** *(optional)* | https://tailscale.com/download — for secure remote access |

---

## Install

```bash
git clone https://github.com/vaibhavjnf/claw-vnc-windows.git
cd claw-vnc-windows
npm install
```

---

## Configure

Edit **`start.bat`** before first run:

```bat
set CLAW_TOKEN=your_secret_token     ← browser login password
set ANTHROPIC_API_KEY=your_key_here  ← from console.anthropic.com
set BIND_HOST=0.0.0.0                ← 0.0.0.0 for Tailscale/LAN, 127.0.0.1 for local only
```

> **Ask Claude works without an API key** if you've run `claude login` — it uses your Claude Code session.

**Optional overrides:**

```bat
set PORT=8080           ← HTTP port (default 8080)
set VNC_HOST=127.0.0.1  ← VNC host
set VNC_PORT=5900        ← VNC port
set VNC_PASSWORD=secret  ← VNC password if set
```

---

## Run

```bat
start.bat
```

Open in browser:

```
http://localhost:8080/?token=your_secret_token
```

Via Tailscale (from any device on your tailnet):

```
http://<tailscale-ip>:8080/?token=your_secret_token
```

---

## TightVNC Setup

1. Download **TightVNC Server** → https://www.tightvnc.com/download.php
2. Install and set a VNC password when prompted
3. Confirm the service is running: `Services → TightVNC Server → Running`
4. Default port is `:5900` — matches claw-vnc defaults, no config needed

---

## Tailscale Setup

1. Install Tailscale on this machine and your phone/laptop
2. Set `BIND_HOST=0.0.0.0` in `start.bat`
3. Run `tailscale ip` to get your Tailscale IP
4. Access from any Tailscale device — no port forwarding, no public exposure

---

## Ask Claude (AI Vision)

1. Go to the **Windows** tab
2. Click any window to start streaming it
3. Tap the **✦ aurora orb** (bottom-right of the stream canvas)
4. Type your question — Claude sees a live screenshot and streams the answer

Requires either `ANTHROPIC_API_KEY` in `start.bat` **or** `claude login` completed.

---

## Project structure

```
claw-vnc-windows/
├── server.js          ← Express + WebSocket server (VNC proxy, terminal, file API, Ask Claude)
├── start.bat          ← Windows launcher — edit this to configure
├── package.json
└── public/
    ├── index.html     ← Full SPA — Desktop / Terminal / Files / Windows / Ask Claude
    ├── manifest.json  ← PWA manifest
    ├── sw.js          ← Service worker (offline shell)
    └── ...            ← noVNC, xterm.js bundled assets
```

---

## Stack

- **Server** — Node.js, Express, `ws`
- **VNC** — noVNC (WebSocket → TightVNC proxy)
- **Terminal** — `node-pty` + `xterm.js`
- **Window capture** — `node-screenshots` (Rust-based Windows native API)
- **AI** — `claude --print` (Claude Code CLI headless mode, no separate server)
- **Design** — Apple Intelligence aesthetic: iOS dark, frosted glass, aurora gradients, spring animations

---

## License

MIT
