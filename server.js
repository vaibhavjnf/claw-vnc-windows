'use strict';

const crypto    = require('crypto');
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const net       = require('net');
const DES       = require('des.js');
const pty       = require('node-pty');
const fs        = require('fs');
const os        = require('os');
const { spawn, execSync, execFile } = require('child_process');
const path      = require('path');

// ── Platform detection ───────────────────────────────────────────────────────
const IS_WIN = os.platform() === 'win32';

const PORT           = parseInt(process.env.PORT) || 8080;
const VNC_HOST       = process.env.VNC_HOST || '127.0.0.1';
const VNC_PORT       = parseInt(process.env.VNC_PORT) || (IS_WIN ? 5900 : 5901);
const VNC_PASSWORD   = process.env.VNC_PASSWORD || 'vaibhavclaw';
const HOME           = IS_WIN ? (process.env.USERPROFILE || 'C:\\Users') : (process.env.HOME || '/home/claw');

// Bind to loopback only — tailscale serve handles external HTTPS access
const BIND_HOST      = process.env.BIND_HOST || '127.0.0.1';

// ── Authentication token ─────────────────────────────────────────────────────
// Generate a random token on startup, or use env var for persistence across restarts
const AUTH_TOKEN = process.env.CLAW_TOKEN || crypto.randomBytes(24).toString('base64url');

// ── File sandbox root ────────────────────────────────────────────────────────
const FILE_ROOT = path.resolve(process.env.FILE_ROOT || HOME);

// ── Rate limiting ────────────────────────────────────────────────────────────
const rateLimits = new Map(); // ip -> { count, resetAt }
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX    = 300;    // requests per window (generous for normal use)

// Windows audio device names (configurable via env)
const WIN_MIC_OUTPUT_DEVICE  = process.env.WIN_MIC_DEVICE  || 'CABLE Input (VB-Audio Virtual Cable)';
const WIN_AUDIO_INPUT_DEVICE = process.env.WIN_AUDIO_DEVICE || 'Stereo Mix';

// Linux PulseAudio names
const V4L2_DEV       = '/dev/video10';
const MIC_SINK       = 'browser_mic';
const MIC_SOURCE     = 'browser_mic_source';
const SYS_AUDIO_SINK = 'system_audio';

// ── VNC DES password encryption (RFB spec section 6.2.2) ─────────────────────
function vncDesEncrypt(password, challenge) {
  const key = [];
  const pwd = password.padEnd(8, '\x00').slice(0, 8);
  for (let i = 0; i < 8; i++) {
    let b = pwd.charCodeAt(i), r = 0;
    for (let j = 0; j < 8; j++) { r = (r << 1) | (b & 1); b >>= 1; }
    key.push(r);
  }
  const enc = DES.DES.create({ type: 'encrypt', key });
  const r1  = enc.update([...challenge.slice(0, 8)]);
  const r2  = enc.update([...challenge.slice(8, 16)]);
  return Buffer.from([...r1, ...r2]);
}

// ── Tailscale IP detection ────────────────────────────────────────────────────
function getTailscaleIP() {
  try {
    const ifaces = os.networkInterfaces();
    // Look for Tailscale interface (100.x.x.x range)
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const addr of addrs) {
        if (addr.family === 'IPv4' && addr.address.startsWith('100.')) {
          return addr.address;
        }
      }
    }
    // Fallback: try tailscale CLI
    const ip = execSync(IS_WIN ? 'tailscale ip -4' : 'tailscale ip -4', {
      encoding: 'utf8', stdio: ['ignore','pipe','pipe'], timeout: 3000
    }).trim();
    if (ip) return ip;
  } catch {}
  return null;
}

// ── Shell helper ─────────────────────────────────────────────────────────────
function sh(cmd, mergeStderr) {
  try {
    if (mergeStderr) {
      // Merge stderr into stdout so we can capture both
      const result = execSync(cmd, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], shell: true });
      return result.trim();
    }
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  }
  catch (e) {
    // For commands like ffmpeg -list_devices that "fail" but produce useful stderr
    if (mergeStderr && e.stderr) return e.stderr.trim();
    if (mergeStderr && e.stdout) return e.stdout.trim();
    return null;
  }
}

// Find executable on Windows (cmd's where) or Linux (which)
function findExe(name) {
  if (IS_WIN) {
    try {
      return execSync(`cmd /c where ${name}`, { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim().split('\n')[0].trim();
    } catch { return null; }
  }
  return sh(`which ${name}`);
}

// ── Virtual Device Setup ─────────────────────────────────────────────────────
function setupAudioLinux() {
  const sinks = sh('pactl list sinks short') || '';

  if (!sinks.includes(SYS_AUDIO_SINK)) {
    const r = sh(`pactl load-module module-null-sink sink_name=${SYS_AUDIO_SINK} rate=44100 channels=2`);
    if (r) console.log(`  System audio sink ready: ${SYS_AUDIO_SINK}`);
    else   console.warn('  System audio sink setup failed');
  } else {
    console.log(`  System audio sink already loaded: ${SYS_AUDIO_SINK}`);
  }
  sh(`pactl set-default-sink ${SYS_AUDIO_SINK}`);

  if (!sinks.includes(MIC_SINK)) {
    const r1 = sh(`pactl load-module module-null-sink sink_name=${MIC_SINK} rate=44100 channels=1`);
    const r2 = sh(
      `pactl load-module module-virtual-source ` +
      `source_name=${MIC_SOURCE} master=${MIC_SINK}.monitor`
    );
    if (r1 && r2) {
      sh(`pactl set-default-source ${MIC_SOURCE}`);
      console.log(`  Virtual mic ready: ${MIC_SINK} -> ${MIC_SOURCE} (default source)`);
    } else {
      console.warn('  Virtual mic setup failed');
    }
  } else {
    console.log(`  Virtual mic already loaded: ${MIC_SINK}`);
  }
}

let winHasFFmpeg = false;
let winHasFFplay = false;
let winAudioDevices = [];

function setupAudioWindows() {
  const ffmpegPath = findExe('ffmpeg');
  const ffplayPath = findExe('ffplay');

  winHasFFmpeg = !!ffmpegPath;
  winHasFFplay = !!ffplayPath;

  if (ffmpegPath) {
    console.log(`  ffmpeg found: ${ffmpegPath}`);
  } else {
    console.warn('  ffmpeg NOT found - system audio capture will not work');
    console.warn('  Install: winget install Gyan.FFmpeg');
  }

  if (ffplayPath) {
    console.log(`  ffplay found: ${ffplayPath}`);
  } else {
    console.warn('  ffplay NOT found - mic relay will not work');
  }

  // List available audio devices via ffmpeg -list_devices (output goes to stderr)
  if (winHasFFmpeg) {
    const devList = sh('ffmpeg -list_devices true -f dshow -i dummy', true);
    if (devList) {
      console.log('\n  Available DirectShow devices:');
      const lines = devList.split('\n');
      let inAudio = false;
      for (const l of lines) {
        if (l.includes('DirectShow audio devices')) inAudio = true;
        if (inAudio) {
          const match = l.match(/"([^"]+)"/);
          if (match && !match[1].includes('@device')) {
            winAudioDevices.push(match[1]);
            console.log(`    [audio] ${match[1]}`);
          }
        }
        if (l.includes('DirectShow video devices')) {
          const vmatch = l.match(/"([^"]+)"/);
          // Not audio, but show video devices too
        }
        // Also extract video device names before audio section
        if (!inAudio) {
          const match = l.match(/"([^"]+)"/);
          if (match && !match[1].includes('@device')) {
            console.log(`    [video] ${match[1]}`);
          }
        }
      }
    }
  }

  console.log(`\n  Mic relay target device: "${WIN_MIC_OUTPUT_DEVICE}"`);
  console.log(`  System audio source:    "${WIN_AUDIO_INPUT_DEVICE}"`);
  console.log('  (Override with WIN_MIC_DEVICE / WIN_AUDIO_DEVICE env vars)');

  if (!winAudioDevices.includes(WIN_AUDIO_INPUT_DEVICE)) {
    console.warn(`\n  WARNING: "${WIN_AUDIO_INPUT_DEVICE}" not found in audio devices.`);
    console.warn('  To enable system audio capture:');
    console.warn('    1. Right-click speaker icon > Sound Settings > More sound settings');
    console.warn('    2. Recording tab > right-click > Show Disabled Devices');
    console.warn('    3. Enable "Stereo Mix"');
    console.warn('    OR install VB-CABLE: https://vb-audio.com/Cable/');
    if (winAudioDevices.length > 0) {
      console.warn(`  Available audio devices: ${winAudioDevices.join(', ')}`);
    }
  }
  console.log('');
}

function setupV4L2() {
  if (IS_WIN) {
    console.log('  Camera: MJPEG preview available at /camera-preview');
    console.log('  (Use OBS to capture MJPEG stream as virtual webcam if needed)');
    return;
  }
  const loaded = sh('lsmod | grep v4l2loopback');
  if (!loaded) {
    const r = sh(
      `sudo modprobe v4l2loopback video_nr=10 ` +
      `card_label="Browser Camera" exclusive_caps=1`
    );
    if (r !== null) console.log(`  v4l2loopback loaded -> ${V4L2_DEV}`);
    else            console.warn(`  v4l2loopback load failed`);
  } else {
    console.log(`  v4l2loopback already loaded -> ${V4L2_DEV}`);
  }
}

console.log(`\n[init] Platform: ${IS_WIN ? 'Windows' : 'Linux'}`);
console.log('[init] Setting up virtual devices...');
if (IS_WIN) setupAudioWindows();
else        setupAudioLinux();
setupV4L2();
console.log('[init] Done\n');

// ── Express + HTTP server ────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// ── Security headers ─────────────────────────────────────────────────────────
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  // No CORS — same-origin only (Tailscale serve proxies same-origin)
  next();
});

// ── Rate limiting middleware (API endpoints only) ────────────────────────────
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress;
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
    rateLimits.set(ip, entry);
  }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: 'rate limit exceeded' });
  }
  next();
}
app.use('/api', rateLimit);

// Clean rate limit map periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimits) {
    if (now > entry.resetAt) rateLimits.delete(ip);
  }
}, RATE_LIMIT_WINDOW);

// ── Token authentication ────────────────────────────────────────────────────
// Login page served without auth; everything else requires ?token= or cookie
app.get('/login', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html><head><title>claw - login</title>
<style>body{background:#0d0d0f;color:#d0d0d8;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
form{background:#161618;padding:2em;border-radius:8px;border:1px solid #2a2a2e}
input{background:#0d0d0f;color:#d0d0d8;border:1px solid #2a2a2e;padding:8px 12px;border-radius:4px;font-family:inherit;width:260px}
button{background:#448aff;color:#fff;border:none;padding:8px 20px;border-radius:4px;cursor:pointer;margin-top:8px}
.err{color:#ff5252;margin-top:8px;display:none}</style></head>
<body><form method="POST" action="/login"><h3>claw.vnc</h3><br>
<input name="token" type="password" placeholder="Access token" autofocus><br>
<button type="submit">Enter</button>
<div class="err" id="e">Invalid token</div>
</form>
<script>if(location.search.includes('fail'))document.getElementById('e').style.display='block'</script>
</body></html>`);
});

app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const input = req.body.token || '';
  // Hash both to ensure equal length for timingSafeEqual
  const inputHash  = crypto.createHash('sha256').update(input).digest();
  const tokenHash  = crypto.createHash('sha256').update(AUTH_TOKEN).digest();
  if (input && crypto.timingSafeEqual(inputHash, tokenHash)) {
    res.setHeader('Set-Cookie', `claw_token=${AUTH_TOKEN}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=86400`);
    return res.redirect('/');
  }
  res.redirect('/login?fail=1');
});

function parseCookies(str) {
  const cookies = {};
  if (!str) return cookies;
  str.split(';').forEach(c => {
    const [k, ...v] = c.split('=');
    cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

function checkAuth(req, res, next) {
  // Allow login page and health check
  if (req.path === '/login' || req.path === '/health') return next();
  // Check query param — also set cookie so WebSocket upgrades inherit auth
  if (req.query.token === AUTH_TOKEN) {
    res.setHeader('Set-Cookie', `claw_token=${AUTH_TOKEN}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=86400`);
    return next();
  }
  // Check cookie
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.claw_token === AUTH_TOKEN) return next();
  // Check Authorization header
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ') && auth.slice(7) === AUTH_TOKEN) return next();
  // Redirect to login for page requests, 401 for API
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'unauthorized' });
  return res.redirect('/login');
}

app.use(checkAuth);

app.use(express.static(path.join(__dirname, 'public')));

app.use('/xterm', express.static(path.join(__dirname, 'node_modules/@xterm/xterm')));
app.use('/xterm-fit', express.static(path.join(__dirname, 'node_modules/@xterm/addon-fit')));
app.use('/xterm-weblinks', express.static(path.join(__dirname, 'node_modules/@xterm/addon-web-links')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', platform: IS_WIN ? 'windows' : 'linux', uptime: process.uptime() });
});

// ── File Browser API (sandboxed to FILE_ROOT) ───────────────────────────────

// Blocked file patterns (case-insensitive)
const BLOCKED_PATTERNS = [
  /\.env$/i, /\.pem$/i, /\.key$/i, /id_rsa/i, /id_ed25519/i,
  /credentials/i, /api_key/i, /\.kube[\\/]config$/i,
  /\.git[\\/]config$/i, /\.npmrc$/i, /\.pypirc$/i,
];

function sandboxPath(reqPath) {
  const absPath = path.resolve(reqPath || FILE_ROOT);
  const normalRoot = IS_WIN ? FILE_ROOT.toLowerCase() : FILE_ROOT;
  const normalAbs  = IS_WIN ? absPath.toLowerCase() : absPath;
  if (!normalAbs.startsWith(normalRoot) && normalAbs !== normalRoot) {
    return null; // outside sandbox
  }
  return absPath;
}

function isBlockedFile(filePath) {
  const base = path.basename(filePath);
  return BLOCKED_PATTERNS.some(p => p.test(base) || p.test(filePath));
}

app.get('/api/files', (req, res) => {
  const absPath = sandboxPath(req.query.path);
  if (!absPath) return res.status(403).json({ error: 'access denied: outside allowed directory' });
  try {
    const entries = fs.readdirSync(absPath, { withFileTypes: true });
    const items = entries
      .filter(e => !e.name.startsWith('.') || e.name === '..')  // hide dotfiles
      .map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file',
        path: path.join(absPath, e.name),
      })).sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });
    const parent = path.dirname(absPath);
    const safeParent = sandboxPath(parent) ? parent : FILE_ROOT;
    res.json({ path: absPath, parent: safeParent, items });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/files/download', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const absPath = sandboxPath(filePath);
  if (!absPath) return res.status(403).json({ error: 'access denied' });
  if (isBlockedFile(absPath)) return res.status(403).json({ error: 'access denied: sensitive file' });
  try {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) return res.status(400).json({ error: 'cannot download directory' });
    res.download(absPath);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

app.get('/api/files/read', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const absPath = sandboxPath(filePath);
  if (!absPath) return res.status(403).json({ error: 'access denied' });
  if (isBlockedFile(absPath)) return res.status(403).json({ error: 'access denied: sensitive file' });
  try {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) return res.status(400).json({ error: 'is directory' });
    if (stat.size > 2 * 1024 * 1024) return res.status(400).json({ error: 'file too large (>2MB)' });
    const content = fs.readFileSync(absPath, 'utf8');
    res.json({ path: absPath, size: stat.size, content });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/files/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const absPath = sandboxPath(filePath);
  if (!absPath) return res.status(403).json({ error: 'access denied' });
  // Block uploading executable files
  const ext = path.extname(absPath).toLowerCase();
  const blockedExts = ['.exe', '.bat', '.cmd', '.ps1', '.vbs', '.msi', '.dll', '.sys', '.sh'];
  if (blockedExts.includes(ext)) return res.status(403).json({ error: 'executable upload blocked' });
  try {
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, req.body);
    res.json({ ok: true, path: absPath, size: req.body.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/files', (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path required' });
  const absPath = sandboxPath(filePath);
  if (!absPath) return res.status(403).json({ error: 'access denied' });
  // Prevent deleting FILE_ROOT itself
  if (path.resolve(absPath) === FILE_ROOT) return res.status(403).json({ error: 'cannot delete root' });
  try {
    const stat = fs.statSync(absPath);
    if (stat.isDirectory()) fs.rmSync(absPath, { recursive: true });
    else fs.unlinkSync(absPath);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── VNC WebSocket proxy (auth-terminating) ──────────────────────────────────
const vncWss = new WebSocket.Server({ noServer: true });

vncWss.on('connection', (ws) => {
  console.log('[vnc] browser connected');

  const tcp = net.createConnection(VNC_PORT, VNC_HOST);
  let tcpBuf   = Buffer.alloc(0);
  let wsBuf    = Buffer.alloc(0);
  let phase    = 'srv_version';
  let wsPhase  = 'ws_version';
  let dead     = false;

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  function cleanup(reason) {
    if (dead) return;
    dead = true;
    console.log(`[vnc] closed -- ${reason}`);
    try { ws.close(); }    catch (_) {}
    try { tcp.destroy(); } catch (_) {}
  }

  function wsSend(buf) {
    if (!dead && ws.readyState === WebSocket.OPEN) ws.send(buf);
  }

  function processTcp() {
    while (true) {
      if (phase === 'srv_version') {
        if (tcpBuf.length < 12) break;
        tcp.write(Buffer.from('RFB 003.008\n'));
        tcpBuf = tcpBuf.slice(12);
        phase  = 'srv_sectypes';

      } else if (phase === 'srv_sectypes') {
        if (tcpBuf.length < 1) break;
        const n = tcpBuf[0];
        if (tcpBuf.length < 1 + n) break;
        const types = [...tcpBuf.slice(1, 1 + n)];
        tcpBuf = tcpBuf.slice(1 + n);
        console.log('[vnc] server security types:', types);
        if (types.includes(2)) {
          tcp.write(Buffer.from([2]));
          phase = 'srv_challenge';
        } else if (types.includes(1)) {
          tcp.write(Buffer.from([1]));
          phase = 'srv_authresult'; // RFB 3.8: server sends SecurityResult even for None
        } else {
          cleanup(`no supported security type in [${types}]`); return;
        }

      } else if (phase === 'srv_challenge') {
        if (tcpBuf.length < 16) break;
        const challenge = tcpBuf.slice(0, 16);
        tcpBuf = tcpBuf.slice(16);
        tcp.write(vncDesEncrypt(VNC_PASSWORD, challenge));
        phase = 'srv_authresult';

      } else if (phase === 'srv_authresult') {
        if (tcpBuf.length < 4) break;
        const result = tcpBuf.readUInt32BE(0);
        tcpBuf = tcpBuf.slice(4);
        if (result !== 0) {
          cleanup(`VNC auth failed (result=${result})`); return;
        }
        console.log('[vnc] authenticated');
        phase = 'srv_authok';
        sendNoAuthToNoVNC();

      } else if (phase === 'proxy') {
        if (tcpBuf.length === 0) break;
        wsSend(tcpBuf);
        tcpBuf = Buffer.alloc(0);
        break;
      } else {
        break;
      }
    }
  }

  function sendNoAuthToNoVNC() {
    wsSend(Buffer.from('RFB 003.008\n'));
    wsSend(Buffer.from([1, 1]));
    wsPhase = 'ws_version';
    processWs();
  }

  function processWs() {
    while (true) {
      if (wsPhase === 'ws_version') {
        if (wsBuf.length < 12) break;
        wsBuf   = wsBuf.slice(12);
        wsPhase = 'ws_secselect';

      } else if (wsPhase === 'ws_secselect') {
        if (wsBuf.length < 1) break;
        wsBuf   = wsBuf.slice(1);
        wsPhase = 'ws_secresult';
        wsSend(Buffer.from([0, 0, 0, 0]));

      } else if (wsPhase === 'ws_secresult') {
        if (wsBuf.length < 1) break;
        const clientInit = wsBuf.slice(0, 1);
        wsBuf   = wsBuf.slice(1);
        wsPhase = 'proxy';
        phase   = 'proxy';
        tcp.write(clientInit);
        if (wsBuf.length > 0) { tcp.write(wsBuf); wsBuf = Buffer.alloc(0); }
        if (tcpBuf.length > 0) { wsSend(tcpBuf); tcpBuf = Buffer.alloc(0); }
        break;
      } else {
        break;
      }
    }
  }

  tcp.on('connect', () => console.log(`[vnc] TCP :${VNC_PORT} connected`));
  tcp.on('data', (d) => { tcpBuf = Buffer.concat([tcpBuf, d]); processTcp(); });
  tcp.on('close', () => cleanup('VNC server closed'));
  tcp.on('error', (e) => cleanup(`TCP error: ${e.message}`));

  ws.on('message', (d) => {
    if (wsPhase === 'proxy') {
      tcp.write(d);
    } else {
      wsBuf = Buffer.concat([wsBuf, Buffer.isBuffer(d) ? d : Buffer.from(d)]);
      processWs();
    }
  });
  ws.on('close', () => cleanup('browser disconnected'));
  ws.on('error', (e) => cleanup(`WS error: ${e.message}`));
});

// ── Microphone: browser -> virtual audio source ──────────────────────────────
const audioInWss = new WebSocket.Server({ noServer: true });

audioInWss.on('connection', (ws) => {
  console.log('[mic] browser connected');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let audioProc;

  if (IS_WIN) {
    if (!winHasFFplay) {
      console.warn('[mic] ffplay not available, mic relay disabled');
      ws.send(JSON.stringify({ error: 'ffplay not installed on server' }));
      ws.close();
      return;
    }
    // Windows: ffplay plays incoming PCM to the default audio output device.
    // If VB-CABLE is set as default playback, apps recording from "CABLE Output" hear the mic.
    // Otherwise the mic audio just plays through speakers (still useful for testing).
    audioProc = spawn('ffplay', [
      '-nodisp',
      '-autoexit',
      '-f', 's16le',
      '-ar', '16000',
      '-ch_layout', 'mono',
      '-i', 'pipe:0',
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
  } else {
    const sinkName = sh(`pactl list sinks short | grep -w ${MIC_SINK}`) ? MIC_SINK : 'auto_null';
    audioProc = spawn('pacat', [
      '--playback',
      `--device=${sinkName}`,
      '--rate=16000',
      '--channels=1',
      '--format=s16le',
      '--latency-msec=10',
      '--process-time-msec=5',
    ]);
  }

  audioProc.on('error', (e) => console.error('[mic] audio process error:', e.message));
  if (audioProc.stderr) {
    audioProc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.error('[mic] stderr:', s);
    });
  }

  ws.on('message', (data) => {
    if (audioProc && audioProc.stdin && !audioProc.stdin.destroyed) audioProc.stdin.write(data);
  });

  ws.on('close', () => {
    console.log('[mic] browser disconnected');
    if (audioProc) {
      if (audioProc.stdin) audioProc.stdin.end();
      audioProc.kill();
    }
  });
});

// ── System audio -> browser ──────────────────────────────────────────────────
const audioOutWss = new WebSocket.Server({ noServer: true });

audioOutWss.on('connection', (ws) => {
  console.log('[audio-out] browser connected');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let audioProc;

  if (IS_WIN) {
    if (!winHasFFmpeg) {
      console.warn('[audio-out] ffmpeg not available, system audio disabled');
      ws.send(JSON.stringify({ error: 'ffmpeg not installed on server' }));
      ws.close();
      return;
    }
    // Windows: capture from DirectShow audio device
    // "Stereo Mix" captures all system audio (must be enabled in Sound settings)
    // Or use the real mic as a fallback for testing
    const audioDevice = winAudioDevices.includes(WIN_AUDIO_INPUT_DEVICE)
      ? WIN_AUDIO_INPUT_DEVICE
      : (winAudioDevices[0] || WIN_AUDIO_INPUT_DEVICE);

    if (audioDevice !== WIN_AUDIO_INPUT_DEVICE) {
      console.log(`[audio-out] "${WIN_AUDIO_INPUT_DEVICE}" not found, using "${audioDevice}"`);
    }

    audioProc = spawn('ffmpeg', [
      '-f', 'dshow',
      '-i', `audio=${audioDevice}`,
      '-f', 's16le',
      '-ar', '44100',
      '-ch_layout', 'stereo',
      'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    const monitorDevice = `${SYS_AUDIO_SINK}.monitor`;
    audioProc = spawn('pacat', [
      '--record',
      `--device=${monitorDevice}`,
      '--rate=44100',
      '--channels=2',
      '--format=s16le',
      '--latency-msec=10',
      '--process-time-msec=5',
    ]);
  }

  if (audioProc.stdout) {
    audioProc.stdout.on('data', (d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    });
  }
  audioProc.on('error', (e) => console.error('[audio-out] process error:', e.message));
  if (audioProc.stderr) {
    audioProc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s && !s.includes('Stream mapping') && !s.includes('Output #')) {
        console.error('[audio-out] stderr:', s);
      }
    });
  }

  ws.on('close', () => {
    console.log('[audio-out] browser disconnected');
    audioProc.kill();
  });
});

// ── Camera: browser JPEG frames -> virtual webcam / MJPEG preview ────────────
const cameraWss = new WebSocket.Server({ noServer: true });

let ffmpegProc   = null;
let cameraActive = false;
let mjpegClients = new Set();

function startFFmpeg() {
  if (ffmpegProc) return;

  if (IS_WIN) {
    // Windows: No v4l2loopback, but we still provide MJPEG preview
    // If user has a virtual webcam driver (e.g., OBS Virtual Camera),
    // they can capture from the MJPEG stream at /camera-preview
    // We also try to pipe to ffmpeg in case they have a virtual cam driver
    ffmpegProc = spawn('ffmpeg', [
      '-loglevel', 'warning',
      '-f',         'image2pipe',
      '-framerate', '15',
      '-i',         'pipe:0',
      '-vf',        'scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2',
      '-pix_fmt',   'yuv420p',
      '-f',         'rawvideo',
      '-y',         'NUL',
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
  } else {
    ffmpegProc = spawn('ffmpeg', [
      '-loglevel', 'warning',
      '-f',         'image2pipe',
      '-framerate', '15',
      '-i',         'pipe:0',
      '-vf',        'scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2',
      '-pix_fmt',   'yuv420p',
      '-f',         'v4l2',
      V4L2_DEV,
    ]);
  }

  if (ffmpegProc.stderr) {
    ffmpegProc.stderr.on('data', (d) => {
      const s = d.toString().trim();
      if (s) console.error('[cam] ffmpeg:', s);
    });
  }
  ffmpegProc.on('close', (code) => {
    console.log(`[cam] ffmpeg exited (${code})`);
    ffmpegProc = null;
    cameraActive = false;
  });
  ffmpegProc.on('error', (e) => {
    console.error('[cam] ffmpeg spawn error:', e.message);
    ffmpegProc = null;
    cameraActive = false;
  });

  cameraActive = true;
  console.log(`[cam] ffmpeg streaming${IS_WIN ? ' (MJPEG preview only)' : ` -> ${V4L2_DEV}`}`);
}

function stopFFmpeg() {
  if (!ffmpegProc) return;
  if (ffmpegProc.stdin) ffmpegProc.stdin.end();
  ffmpegProc.kill();
  ffmpegProc   = null;
  cameraActive = false;
  console.log('[cam] ffmpeg stopped');
}

cameraWss.on('connection', (ws) => {
  console.log('[cam] browser connected');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  startFFmpeg();

  ws.on('message', (data) => {
    if (ffmpegProc && ffmpegProc.stdin && !ffmpegProc.stdin.destroyed) {
      ffmpegProc.stdin.write(data);
    }
    // Always serve MJPEG preview to connected HTTP clients
    for (const res of mjpegClients) {
      try {
        res.write('--frame\r\nContent-Type: image/jpeg\r\n\r\n');
        res.write(data);
        res.write('\r\n');
      } catch (e) { mjpegClients.delete(res); }
    }
  });

  ws.on('close', () => {
    console.log('[cam] browser disconnected');
    if (cameraWss.clients.size === 0) stopFFmpeg();
  });

  ws.on('error', (e) => console.error('[cam] ws error:', e.message));
});

app.get('/camera-preview', (req, res) => {
  res.setHeader('Content-Type', 'multipart/x-mixed-replace; boundary=frame');
  res.setHeader('Cache-Control', 'no-cache');
  mjpegClients.add(res);
  req.on('close', () => mjpegClients.delete(res));
});

// ── Window capture & control (Windows-only) ──────────────────────────────────
let psCtrlProc = null;

function ensureControlProcess() {
  if (psCtrlProc && !psCtrlProc.killed) return psCtrlProc;
  // Persistent PowerShell that reads pipe-delimited control commands from stdin
  const initScript = [
    'Add-Type -TypeDefinition @\'',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class WinCtrl {',
    '  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);',
    '  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, IntPtr e);',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '  public const uint LD=2,LU=4,RD=8,RU=16,SCROLL=0x0800;',
    '}',
    '\'@ -ErrorAction SilentlyContinue',
    '$sh = New-Object -ComObject WScript.Shell',
    'while($line = [Console]::ReadLine()) {',
    '  $p = $line -split "\\|"',
    '  try {',
    '    switch($p[0]) {',
    '      "FOCUS"  { [WinCtrl]::SetForegroundWindow([IntPtr][long]$p[1]) }',
    '      "MOVE"   { [WinCtrl]::SetCursorPos([int]$p[1],[int]$p[2]) }',
    '      "LDOWN"  { [WinCtrl]::SetCursorPos([int]$p[1],[int]$p[2]); [WinCtrl]::mouse_event([WinCtrl]::LD,0,0,0,[IntPtr]::Zero) }',
    '      "LUP"    { [WinCtrl]::SetCursorPos([int]$p[1],[int]$p[2]); [WinCtrl]::mouse_event([WinCtrl]::LU,0,0,0,[IntPtr]::Zero) }',
    '      "RDOWN"  { [WinCtrl]::SetCursorPos([int]$p[1],[int]$p[2]); [WinCtrl]::mouse_event([WinCtrl]::RD,0,0,0,[IntPtr]::Zero) }',
    '      "RUP"    { [WinCtrl]::SetCursorPos([int]$p[1],[int]$p[2]); [WinCtrl]::mouse_event([WinCtrl]::RU,0,0,0,[IntPtr]::Zero) }',
    '      "SCROLL" { [WinCtrl]::SetCursorPos([int]$p[1],[int]$p[2]); [WinCtrl]::mouse_event([WinCtrl]::SCROLL,0,0,[uint][int]$p[3],[IntPtr]::Zero) }',
    '      "KEYS"   { $sh.SendKeys($p[1]) }',
    '    }',
    '  } catch {}',
    '}',
  ].join('\n');
  psCtrlProc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', initScript], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  psCtrlProc.on('close', () => { psCtrlProc = null; });
  psCtrlProc.on('error', () => { psCtrlProc = null; });
  return psCtrlProc;
}

function sendCtrl(cmd) {
  if (!IS_WIN) return;
  const ps = ensureControlProcess();
  if (ps?.stdin?.writable) ps.stdin.write(cmd + '\n');
}

// ── /api/windows — list capturable windows ───────────────────────────────────
app.get('/api/windows', (req, res) => {
  try {
    const { Window } = require('node-screenshots');
    const windows = Window.all()
      .filter(w => w.title()?.trim() && !w.isMinimized())
      .map(w => ({
        id:      w.id(),
        title:   w.title(),
        appName: w.appName(),
        x: w.x(), y: w.y(), width: w.width(), height: w.height(),
      }));
    res.json(windows);
  } catch (e) {
    console.error('[win] enumerate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /window-stream WebSocket — stream & control a specific window ─────────────
const windowStreamWss = new WebSocket.Server({ noServer: true });

windowStreamWss.on('connection', (ws) => {
  console.log('[win-stream] browser connected');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let streaming = false;
  let winPos    = null; // { x, y, width, height } cached for coord translation

  ws.on('message', async (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (!streaming && msg.id !== undefined) {
      // First message — begin stream loop
      streaming = true;
      const targetId = msg.id;
      if (IS_WIN) sendCtrl(`FOCUS|${targetId}`);

      ;(async () => {
        const { Window } = require('node-screenshots');
        while (streaming && ws.readyState === 1) {
          try {
            const w = Window.all().find(ww => ww.id() === targetId);
            if (!w) { ws.send(JSON.stringify({ error: 'window_not_found' })); break; }
            winPos = { x: w.x(), y: w.y(), width: w.width(), height: w.height() };
            const image = await w.captureImage();
            const jpeg  = image.toJpegSync();
            if (ws.readyState === 1) ws.send(jpeg);
          } catch (e) {
            console.error('[win-stream] capture error:', e.message);
            break;
          }
          await new Promise(r => setTimeout(r, 66)); // ~15 fps
        }
        streaming = false;
      })();
      return;
    }

    // Control events
    if (!winPos || !IS_WIN) return;
    const sx = winPos.x + Math.round(msg.x ?? 0);
    const sy = winPos.y + Math.round(msg.y ?? 0);
    switch (msg.type) {
      case 'mouse_move':  sendCtrl(`MOVE|${sx}|${sy}`); break;
      case 'mouse_down':  sendCtrl(`${msg.button === 'right' ? 'RDOWN' : 'LDOWN'}|${sx}|${sy}`); break;
      case 'mouse_up':    sendCtrl(`${msg.button === 'right' ? 'RUP'   : 'LUP'  }|${sx}|${sy}`); break;
      case 'scroll':      sendCtrl(`SCROLL|${sx}|${sy}|${Math.round((msg.delta ?? 1) * 120)}`); break;
      case 'key':         if (msg.keys) sendCtrl(`KEYS|${msg.keys}`); break;
    }
  });

  ws.on('close', () => {
    streaming = false;
    console.log('[win-stream] browser disconnected');
  });
  ws.on('error', (e) => console.error('[win-stream] ws error:', e.message));
});

// ── Direct TCP VNC proxy on :5900 (full-colour, 32bpp forced) ────────────────
const VNC_PROXY_PORT = IS_WIN ? 5950 : 5900;  // Avoid conflict with VNC server on Windows

function makeTcpVncProxy(clientSock) {
  console.log('[vnc-tcp] client connected');

  const tcp      = net.createConnection(VNC_PORT, VNC_HOST);
  let tcpBuf     = Buffer.alloc(0);
  let clientBuf  = Buffer.alloc(0);
  let phase      = 'srv_version';
  let cPhase     = 'c_version';
  let dead       = false;

  function cleanup(reason) {
    if (dead) return; dead = true;
    console.log(`[vnc-tcp] closed -- ${reason}`);
    try { clientSock.destroy(); } catch (_) {}
    try { tcp.destroy(); }        catch (_) {}
  }

  function toClient(buf) {
    if (!dead) { try { clientSock.write(buf); } catch (e) { cleanup(`write error: ${e.message}`); } }
  }

  function processTcp() {
    while (true) {
      if (phase === 'srv_version') {
        if (tcpBuf.length < 12) break;
        tcp.write(Buffer.from('RFB 003.008\n'));
        tcpBuf = tcpBuf.slice(12); phase = 'srv_sectypes';

      } else if (phase === 'srv_sectypes') {
        if (tcpBuf.length < 1) break;
        const n = tcpBuf[0];
        if (tcpBuf.length < 1 + n) break;
        const types = [...tcpBuf.slice(1, 1 + n)];
        tcpBuf = tcpBuf.slice(1 + n);
        if (types.includes(2)) { tcp.write(Buffer.from([2])); phase = 'srv_challenge'; }
        else if (types.includes(1)) { tcp.write(Buffer.from([1])); phase = 'srv_authresult'; }
        else { cleanup(`no supported security type [${types}]`); return; }

      } else if (phase === 'srv_challenge') {
        if (tcpBuf.length < 16) break;
        tcp.write(vncDesEncrypt(VNC_PASSWORD, tcpBuf.slice(0, 16)));
        tcpBuf = tcpBuf.slice(16); phase = 'srv_authresult';

      } else if (phase === 'srv_authresult') {
        if (tcpBuf.length < 4) break;
        const result = tcpBuf.readUInt32BE(0); tcpBuf = tcpBuf.slice(4);
        if (result !== 0) { cleanup(`VNC auth failed (result=${result})`); return; }
        console.log('[vnc-tcp] authenticated');
        phase = 'srv_authok'; sendHandshakeToClient();

      } else if (phase === 'proxy') {
        if (tcpBuf.length === 0) break;
        toClient(tcpBuf); tcpBuf = Buffer.alloc(0); break;
      } else { break; }
    }
  }

  function sendHandshakeToClient() {
    toClient(Buffer.from('RFB 003.008\n'));
    toClient(Buffer.from([1, 1]));
    cPhase = 'c_version';
    processClient();
  }

  function forcePixelFormat(msg) {
    const bpp = msg[4];
    if (bpp >= 24) return msg;
    const out = Buffer.from(msg);
    out[4]  = 32;  out[5]  = 24;  out[6]  = 0;  out[7]  = 1;
    out.writeUInt16BE(255, 8);  out.writeUInt16BE(255, 10);  out.writeUInt16BE(255, 12);
    out[14] = 16; out[15] = 8; out[16] = 0;
    out[17] = out[18] = out[19] = 0;
    console.log(`[vnc-tcp] SetPixelFormat ${bpp}bpp -> forced 32bpp`);
    return out;
  }

  function drainClientProxy() {
    while (clientBuf.length > 0) {
      const t = clientBuf[0];
      if (t === 0) {
        if (clientBuf.length < 20) break;
        tcp.write(forcePixelFormat(clientBuf.slice(0, 20)));
        clientBuf = clientBuf.slice(20);
      } else if (t === 2) {
        if (clientBuf.length < 4) break;
        const len = 4 + 4 * clientBuf.readUInt16BE(2);
        if (clientBuf.length < len) break;
        tcp.write(clientBuf.slice(0, len)); clientBuf = clientBuf.slice(len);
      } else if (t === 3) {
        if (clientBuf.length < 10) break;
        tcp.write(clientBuf.slice(0, 10)); clientBuf = clientBuf.slice(10);
      } else if (t === 4) {
        if (clientBuf.length < 8) break;
        tcp.write(clientBuf.slice(0, 8)); clientBuf = clientBuf.slice(8);
      } else if (t === 5) {
        if (clientBuf.length < 6) break;
        tcp.write(clientBuf.slice(0, 6)); clientBuf = clientBuf.slice(6);
      } else if (t === 6) {
        if (clientBuf.length < 8) break;
        const len = 8 + clientBuf.readUInt32BE(4);
        if (clientBuf.length < len) break;
        tcp.write(clientBuf.slice(0, len)); clientBuf = clientBuf.slice(len);
      } else {
        tcp.write(clientBuf); clientBuf = Buffer.alloc(0); break;
      }
    }
  }

  function processClient() {
    while (true) {
      if (cPhase === 'c_version') {
        if (clientBuf.length < 12) break;
        clientBuf = clientBuf.slice(12); cPhase = 'c_secselect';
      } else if (cPhase === 'c_secselect') {
        if (clientBuf.length < 1) break;
        clientBuf = clientBuf.slice(1); cPhase = 'c_secresult';
        toClient(Buffer.from([0, 0, 0, 0]));
      } else if (cPhase === 'c_secresult') {
        if (clientBuf.length < 1) break;
        tcp.write(clientBuf.slice(0, 1));
        clientBuf = clientBuf.slice(1);
        cPhase = 'proxy'; phase = 'proxy';
        drainClientProxy();
        if (tcpBuf.length > 0) { toClient(tcpBuf); tcpBuf = Buffer.alloc(0); }
        break;
      } else { break; }
    }
  }

  tcp.on('connect', () => console.log(`[vnc-tcp] upstream :${VNC_PORT} connected`));
  tcp.on('data',  (d) => { tcpBuf = Buffer.concat([tcpBuf, d]); processTcp(); });
  tcp.on('close', () => cleanup('upstream closed'));
  tcp.on('error', (e) => cleanup(`upstream error: ${e.message}`));

  clientSock.on('data', (d) => {
    if (cPhase === 'proxy') { clientBuf = Buffer.concat([clientBuf, d]); drainClientProxy(); }
    else { clientBuf = Buffer.concat([clientBuf, d]); processClient(); }
  });
  clientSock.on('close', () => cleanup('client disconnected'));
  clientSock.on('error', (e) => cleanup(`client error: ${e.message}`));
}

net.createServer((sock) => {
  sock.on('error', () => {}); // prevent unhandled socket errors from crashing
  makeTcpVncProxy(sock);
}).listen(VNC_PROXY_PORT, BIND_HOST, () => {
  console.log(`[vnc-tcp] full-colour proxy -> :${VNC_PROXY_PORT}`);
});

// ── Terminal WebSocket (persistent shell via node-pty) ────────────────────────
const termWss = new WebSocket.Server({ noServer: true });

let persistentPty = null;
let ptyBuffer = '';
const PTY_BUFFER_MAX = 50000;

function getOrCreatePty() {
  if (persistentPty && !persistentPty.killed) return persistentPty;

  const shell = IS_WIN ? 'powershell.exe' : '/bin/zsh';
  const shellArgs = IS_WIN ? ['-NoLogo'] : [];

  persistentPty = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols: 120,
    rows: 40,
    cwd: HOME,
    env: IS_WIN ? {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } : {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      DISPLAY: ':1',
    },
  });

  persistentPty.killed = false;
  ptyBuffer = '';

  persistentPty.onData((data) => {
    ptyBuffer += data;
    if (ptyBuffer.length > PTY_BUFFER_MAX) {
      ptyBuffer = ptyBuffer.slice(-PTY_BUFFER_MAX);
    }
    termWss.clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });
  });

  persistentPty.onExit(() => {
    console.log('[term] shell exited -- will respawn on next connect');
    persistentPty.killed = true;
    persistentPty = null;
  });

  console.log(`[term] spawned persistent ${IS_WIN ? 'PowerShell' : 'zsh'} (pid ${persistentPty.pid})`);
  return persistentPty;
}

termWss.on('connection', (ws) => {
  console.log('[term] browser connected');
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const shell = getOrCreatePty();

  if (ptyBuffer.length > 0) ws.send(ptyBuffer);

  ws.on('message', (msg) => {
    const str = msg.toString();
    if (str.startsWith('{')) {
      try {
        const cmd = JSON.parse(str);
        if (cmd.type === 'resize' && cmd.cols && cmd.rows) {
          shell.resize(cmd.cols, cmd.rows);
          return;
        }
      } catch (_) {}
    }
    shell.write(str);
  });

  ws.on('close', () => console.log('[term] browser disconnected'));
  ws.on('error', (e) => console.error('[term] ws error:', e.message));
});

// ── WebSocket keepalive ping/pong ────────────────────────────────────────────
const wsKeepalive = setInterval(() => {
  for (const wss of [vncWss, audioInWss, audioOutWss, cameraWss, termWss, windowStreamWss]) {
    wss.clients.forEach((ws) => {
      if (ws.isAlive === false) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }
}, 30000);

// ── WebSocket routing ────────────────────────────────────────────────────────
const wsRoutes = {
  '/websockify':    vncWss,
  '/audio-in':      audioInWss,
  '/audio-out':     audioOutWss,
  '/camera':        cameraWss,
  '/terminal':      termWss,
  '/window-stream': windowStreamWss,
};

server.on('upgrade', (req, socket, head) => {
  // Authenticate WebSocket upgrade via cookie or query param
  const url = new URL(req.url, `http://${req.headers.host}`);
  const tokenParam = url.searchParams.get('token');
  const cookies = parseCookies(req.headers.cookie);
  const authenticated = (tokenParam === AUTH_TOKEN) || (cookies.claw_token === AUTH_TOKEN);
  if (!authenticated) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const wss = wsRoutes[url.pathname];
  if (wss) wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  else     socket.destroy();
});

// ── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, BIND_HOST, () => {
  console.log(`claw.vnc  ->  http://${BIND_HOST}:${PORT}`);
  console.log(`\n[Auth] Access token: ${AUTH_TOKEN}`);
  console.log(`[Auth] Login URL:    http://localhost:${PORT}/login`);
  console.log(`[Auth] Direct URL:   http://localhost:${PORT}/?token=${AUTH_TOKEN}`);
  console.log(`[Auth] Set CLAW_TOKEN env var for a persistent token across restarts\n`);
  console.log(`Camera preview:  http://localhost:${PORT}/camera-preview`);
  if (IS_WIN) {
    console.log(`\n[Windows Setup Guide]`);
    console.log(`  VNC:   Install TightVNC Server (https://www.tightvnc.com/) - runs on :${VNC_PORT}`);
    console.log(`  Mic:   Install VB-CABLE (https://vb-audio.com/Cable/) for virtual audio routing`);
    console.log(`  Audio: Enable "Stereo Mix" in Sound Settings > Recording Devices`);
    console.log(`         Or set WIN_AUDIO_DEVICE env var to your audio capture device name`);
    console.log(`  Cam:   Camera preview at /camera-preview; use OBS Virtual Camera to expose as webcam`);
    console.log(`  ffmpeg: Required for audio features (https://ffmpeg.org/download.html)\n`);
  }
});

// ── Cleanup on exit ──────────────────────────────────────────────────────────
function shutdown() {
  clearInterval(wsKeepalive);
  for (const wss of [vncWss, audioInWss, audioOutWss, cameraWss, termWss, windowStreamWss]) {
    wss.clients.forEach((ws) => ws.close());
  }
  stopFFmpeg();
  if (persistentPty && !persistentPty.killed) persistentPty.kill();
  if (psCtrlProc && !psCtrlProc.killed) psCtrlProc.kill();
  server.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
