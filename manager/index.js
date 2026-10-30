#!/usr/bin/env node
// deepseek-harness management service (admin variant entrypoint)
//
// Responsibilities:
//   1. Serve the admin page (/__admin/) and its API: select/install/switch DSH versions, configure the npm registry;
//   2. Host the DSH process (start/stop/restart/wait for ready);
//   3. Reverse-proxy the DSH Web UI (reuses the old proxy's polyfill / loopback / Origin / Basic Auth / WS logic);
//   4. When DSH is not installed or not running, visiting / redirects automatically to the admin page.
//
// Data persistence conventions:
//   - DSH installs into INSTALL_DIR (a named volume mount is recommended, e.g. dsh-install:/opt/dsh); the installed version and state file live on the volume,
//     so no reinstall is needed after the container is rebuilt and the management service detects and starts DSH automatically on launch;
//   - DSH's own config/sessions still live in ~/.dsh (mounting dsh-data:/root/.dsh is recommended).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const httpProxy = require('http-proxy');
const crypto = require('crypto');
const { serveIndex, injectIntoHead } = require('../proxy/upstream-token.js');
const { attachBodyTransform } = require('../proxy/compression.js');

// ── Ports and environment ────────────────────────────────────────────────
const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const LISTEN_PORT = Number(process.env.PROXY_PORT) || 3080;
const TARGET_ORIGIN = `http://127.0.0.1:${DSH_PORT}`;
const DSH_WEB_LOG = process.env.DSH_WEB_LOG || '/app/.dsh-web.log'; // DSH runtime log written to disk, used for launch-token retrieval

// DSH install directory (should mount a persistent volume dsh-install:/opt/dsh)
const INSTALL_DIR = process.env.DSH_INSTALL_DIR || '/opt/dsh';
const DSH_BIN = path.join(INSTALL_DIR, 'bin', 'dsh');
const DSH_PKG_JSON = path.join(INSTALL_DIR, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
const MANAGER_DIR = path.join(INSTALL_DIR, 'manager');
const STATE_FILE = path.join(MANAGER_DIR, 'state.json');

// npm registry: default value (can be overridden by the NPM_CONFIG_REGISTRY env var at container start) + value saved on the admin page (highest priority)
const DEFAULT_REGISTRY = process.env.NPM_CONFIG_REGISTRY || 'https://registry.npmjs.org/';

// When debugging locally on Windows npm is npm.cmd; inside the Linux container it is npm
const NPM_CMD = process.platform === 'win32' ? 'npm.cmd' : 'npm';

// Basic Auth (same as the old proxy: enabled only when both are set)
const AUTH_USER = process.env.PROXY_USERNAME || '';
const AUTH_PASS = process.env.PROXY_PASSWORD || '';
const AUTH_REALM = 'dsh-admin';
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg', '/favicon.ico']);

// ── State (incl. npm registry config) ──────────────────────────────────────
let state = loadState();
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}
function saveState() {
  try {
    fs.mkdirSync(MANAGER_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error('[manager] Failed to save state:', e.message);
  }
}
function effectiveRegistry() {
  return (state.registry && state.registry.trim()) || DEFAULT_REGISTRY;
}
function registryInfo() {
  return {
    default: DEFAULT_REGISTRY,
    saved: state.registry || null,
    effective: effectiveRegistry(),
  };
}

// ── Basic utilities ──────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
function isDshInstalled() {
  return fs.existsSync(DSH_BIN) && fs.existsSync(DSH_PKG_JSON);
}
function actualVersion() {
  try {
    return JSON.parse(fs.readFileSync(DSH_PKG_JSON, 'utf8')).version || null;
  } catch {
    return null;
  }
}

// ── DSH process management ─────────────────────────────────────────────
let dshProc = null;
let dshReady = false;

function bootDsh() {
  return new Promise(resolve => {
    if (dshProc) return resolve({ ok: true });
    if (!isDshInstalled()) return resolve({ ok: false, reason: 'DSH not installed' });
    dshReady = false;
    const env = {
      ...process.env,
      PATH: `${path.join(INSTALL_DIR, 'bin')}:${process.env.PATH || ''}`,
      NPM_CONFIG_REGISTRY: effectiveRegistry(),
    };
    console.log(`[manager] Starting DSH: ${DSH_BIN} web --port ${DSH_PORT}`);
    const p = spawn(DSH_BIN, ['web', '--port', String(DSH_PORT)], { env, stdio: 'pipe' });
    dshProc = p;
    // DSH runtime log: the same content goes to container output (visible) and to DSH_WEB_LOG on disk (for launch-token retrieval)
    const logStream = fs.createWriteStream(DSH_WEB_LOG, { flags: 'a' });
    p.stdout.on('data', d => { logStream.write(d); process.stdout.write(`[dsh] ${d}`); });
    p.stderr.on('data', d => { logStream.write(d); process.stderr.write(`[dsh] ${d}`); });
    p.on('error', err => {
      console.error('[manager] DSH failed to start:', err.message);
      dshProc = null;
      dshReady = false;
      resolve({ ok: false, reason: err.message });
    });
    p.on('exit', (code, sig) => {
      console.log(`[manager] DSH exited (code=${code}, sig=${sig})`);
      if (dshProc === p) dshProc = null;
      dshReady = false;
      try { logStream.end(); } catch {}
    });
    waitDshReady().then(ok => {
      dshReady = ok;
      console.log(ok ? '[manager] DSH ready' : '[manager] DSH not ready within 120 seconds');
      resolve({ ok });
    });
  });
}

function stopDsh() {
  return new Promise(resolve => {
    const p = dshProc;
    dshProc = null;
    dshReady = false;
    if (!p) return resolve();
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, 10000);
    p.once('exit', () => { clearTimeout(timer); resolve(); });
    try { p.kill('SIGTERM'); } catch { resolve(); }
  });
}

async function restartDsh() {
  await stopDsh();
  return bootDsh();
}

async function waitDshReady(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!dshProc) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${DSH_PORT}/`);
      if (res.status < 500) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

// ── Install (streaming log → SSE) ────────────────────────────────────
let installing = false;
let installMeta = { running: false, version: null, ok: null, done: false };
const sseClients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch {}
  }
}

// Management log: the same line goes to SSE (frontend) and to container logs (docker logs)
function emitLog(line) {
  broadcast('log', { line });
  process.stdout.write(`[manager-cmd] ${line}\n`);
}

function runCmd(cmd, args, env, onLine) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: 'pipe' });
    } catch (e) { return reject(e); }
    let buf = '';
    const push = chunk => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.trim()) {
          process.stdout.write(`[manager-cmd] ${line}\n`); // also to container log
          onLine(line);
        }
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', reject);
    // Use exit instead of close: npm spawns child processes such as node-gyp/make that may inherit the pipes,
    // so close may never fire after the command actually finishes (the install task would hang in "installing")
    child.on('exit', (code, sig) => {
      if (buf.trim()) {
        process.stdout.write(`[manager-cmd] ${buf.trim()}\n`); // also to container log
        onLine(buf);
      }
      if (code === 0) resolve();
      else reject(new Error(`Command exit code ${code == null ? 'signal ' + sig : code}`));
    });
  });
}

async function installDsh(version, registry) {
  if (installing) return { ok: false, reason: 'An install task is already running' };
  installing = true;
  installMeta = { running: true, version, ok: null, done: false };
  broadcast('start', { version });
  let ok = false;
  try {
    const args = ['install', '-g', '--prefix', INSTALL_DIR, '--no-audit', '--no-fund', `@deepseek-ai/dsh@${version}`];
    emitLog(`> ${NPM_CMD} ${args.join(' ')}`);
    emitLog(`> npm registry: ${registry}`);
    await runCmd(NPM_CMD, args, { ...process.env, NPM_CONFIG_REGISTRY: registry }, line => broadcast('log', { line }));
    if (!isDshInstalled()) throw new Error('Install finished but the dsh executable was not found, please confirm the version exists');
    const ver = actualVersion();
    state.installedVersion = ver;
    state.requestedVersion = version;
    state.installedAt = new Date().toISOString();
    saveState();
    emitLog(`Installed DSH ${ver}`);
    ok = true;
  } catch (e) {
    broadcast('log', { line: `[Error] ${e.message}` });
    ok = false;
  }
  installMeta.ok = ok;
  installMeta.done = true;
  installMeta.running = false; // Reset the installing flag, otherwise the page header would keep showing "Installing"
  installing = false;
  broadcast('done', { ok, version: actualVersion() });
  if (ok) {
    // The old process must be stopped before starting: bootDsh returns immediately if dshProc exists,
    // otherwise the running process would still be the old DSH version
    const r = await restartDsh();
    broadcast('boot', { ok: r.ok, reason: r.reason || '' });
  }
  return { ok };
}

// ── Version list (npm view, cached 5 min) ───────────────────────────
let versionsCache = { key: null, at: 0, data: null };
async function fetchVersions(force = false) {
  const key = effectiveRegistry();
  const now = Date.now();
  if (!force && versionsCache.key === key && now - versionsCache.at < 300000 && versionsCache.data) {
    return versionsCache.data;
  }
  const env = { ...process.env, NPM_CONFIG_REGISTRY: key };
  const out = { distTags: null, list: [], error: null };
  const runView = (arg) => {
    try {
      return spawnSync(NPM_CMD, ['view', '@deepseek-ai/dsh', arg, '--json'], { encoding: 'utf8', env, timeout: 60000 });
    } catch (e) {
      return { status: -1, stdout: '', stderr: e.message };
    }
  };
  const tags = runView('dist-tags');
  if (tags.status === 0) {
    try { out.distTags = JSON.parse(tags.stdout.trim()); } catch { out.distTags = null; }
  } else {
    out.error = String(tags.stderr || tags.stdout || 'npm view dist-tags failed').trim().split('\n').pop();
  }
  const versions = runView('versions');
  if (versions.status === 0) {
    try {
      const arr = JSON.parse(versions.stdout.trim());
      out.list = Array.isArray(arr) ? arr : [];
    } catch { out.list = []; }
  } else if (!out.error) {
    out.error = String(versions.stderr || versions.stdout || 'npm view versions failed').trim().split('\n').pop();
  }
  if (out.list.length || out.distTags) versionsCache = { key, at: now, data: out };
  return out;
}

// ── Basic Auth (same as the old proxy) ────────────────────────────────
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function checkAuth(req) {
  if (!AUTH_USER || !AUTH_PASS) return true;
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  let decoded;
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return false; }
  const i = decoded.indexOf(':');
  if (i === -1) return false;
  return safeEqual(decoded.slice(0, i), AUTH_USER) && safeEqual(decoded.slice(i + 1), AUTH_PASS);
}
function rejectUnauthorized(res) {
  res.writeHead(401, {
    'WWW-Authenticate': `Basic realm="${AUTH_REALM}"`,
    'Content-Type': 'text/plain; charset=utf-8',
  });
  res.end('401 Unauthorized');
}
function rejectUpgrade(socket) {
  socket.end(`HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="${AUTH_REALM}"\r\nConnection: close\r\n\r\n`);
}

// ── Reverse proxy (reuses the old proxy logic) ────────────────────────
// crypto.randomUUID polyfill: LAN IPs are a non-secure context, and the DSH frontend relies on this API to generate rpcId
const POLYFILL = '<script>(function(){try{if(typeof crypto!=="undefined"&&crypto&&typeof crypto.randomUUID!=="function"){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h="";for(var i=0;i<16;i++){h+=b[i].toString(16).padStart(2,"0")}return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}}catch(e){}})();</script>';
const HTML_INJECT = POLYFILL;
// Rewrite isLoopbackHostname to always-true: settings-type features also work over LAN access
const LOOPBACK_JS_NEEDLE = 'isLoopbackHostname(pageLocation.hostname)';
const LOOPBACK_JS_REPLACEMENT = 'true';

const proxy = httpProxy.createProxyServer({ target: TARGET_ORIGIN, ws: true, changeOrigin: true });

proxy.on('proxyRes', (proxyRes, req, res) => {
  const ct = String(proxyRes.headers['content-type'] || '');
  const isHtml = ct.includes('text/html');
  const isJs = ct.includes('javascript');
  if (!isHtml && !isJs) return;

  // Support all compression forms from browser/upstream (gzip / deflate / br, plus uncompressed identity):
  // buffer the whole response body → decompress to plaintext per Content-Encoding → finish the HTML/JS rewrite → recompress
  // with the original encoding and send back. This way the rewrite logic below works no matter whether the upstream compresses or which format it uses.
  // (The previous version stripped Accept-Encoding when forwarding to force plaintext from the upstream; that assumption is no longer relied upon)
  attachBodyTransform(res, proxyRes, plain => {
    const text = plain.toString('utf8');
    if (isHtml) {
      // HTML: inject the polyfill and the "admin" floating button
      return Buffer.from(injectIntoHead(text, HTML_INJECT));
    }
    // JS: rewrite only when the target needle is hit (return null on a miss → pass through unchanged, no pointless recompression)
    if (text.includes(LOOPBACK_JS_NEEDLE)) {
      return Buffer.from(text.split(LOOPBACK_JS_NEEDLE).join(LOOPBACK_JS_REPLACEMENT));
    }
    return null;
  });
});
function alignOrigin(req) {
  if (req.headers.origin) req.headers.origin = TARGET_ORIGIN;
  // Note: no longer stripping Accept-Encoding. Whether the upstream compresses (gzip/deflate/br all fine),
  // the proxyRes compression-compatible pipeline always "decompresses → rewrites → recompresses", preserving the bandwidth benefit.
}

// ── Admin page ───────────────────────────────────────────────
let adminHtmlCache = null;
function serveAdmin(res) {
  if (!adminHtmlCache) adminHtmlCache = fs.readFileSync(path.join(__dirname, 'admin.html'), 'utf8');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(adminHtmlCache);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('JSON parse failed')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, pathname, u) {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (pathname === '/__admin/api/state' && req.method === 'GET') {
      const versions = await fetchVersions(false);
      return send(200, {
        installed: state.installedVersion || null,
        requested: state.requestedVersion || null,
        installedAt: state.installedAt || null,
        running: dshReady,
        actual: actualVersion(),
        install: installMeta,
        registry: registryInfo(),
        versions,
      });
    }
    if (pathname === '/__admin/api/versions' && req.method === 'GET') {
      const force = u.searchParams.get('refresh') === '1';
      return send(200, await fetchVersions(force));
    }
    if (pathname === '/__admin/api/registry' && req.method === 'POST') {
      const body = await readJsonBody(req);
      let v = String(body.registry || '').trim();
      if (v === '') {
        delete state.registry;
      } else {
        if (!/^https?:\/\//i.test(v)) return send(400, { ok: false, error: 'Must be an address starting with http:// or https://' });
        v = v.replace(/\/+$/, '');
        state.registry = v;
      }
      saveState();
      return send(200, { ok: true, registry: registryInfo() });
    }
    if (pathname === '/__admin/api/install' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const version = String(body.version || '').trim();
      if (!version) return send(400, { ok: false, error: 'Missing version number' });
      if (installing) return send(409, { ok: false, error: 'An install task is already running' });
      installDsh(version, effectiveRegistry()); // runs asynchronously, progress goes through SSE
      return send(200, { ok: true, started: true, version });
    }
    if (pathname === '/__admin/api/restart' && req.method === 'POST') {
      const r = await restartDsh();
      return send(200, { ok: r.ok, reason: r.reason || '' });
    }
    if (pathname === '/__admin/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      sseClients.add(res);
      res.on('close', () => sseClients.delete(res));
      return;
    }
    return send(404, { ok: false, error: 'Endpoint not found' });
  } catch (e) {
    return send(500, { ok: false, error: e.message });
  }
}

// ── HTTP server ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? '/', 'http://admin');
  const pathname = u.pathname;
  if (!PUBLIC_PATHS.has(pathname) && !checkAuth(req)) return rejectUnauthorized(res);

  if (pathname === '/__admin' || pathname === '/__admin/') return serveAdmin(res);
  if (pathname.startsWith('/__admin/api/')) return handleApi(req, res, pathname, u);

  // All other paths: reverse-proxy when DSH is ready, otherwise redirect to the admin page
  if (dshReady) {
    // Root GET goes through serveIndex: when the upstream (e.g. official 0.1.2+) returns 401, resend once carrying the launch token
    if (req.method === 'GET' && pathname === '/') {
      const handled = await serveIndex(req, res, { origin: TARGET_ORIGIN, transformHtml: html => injectIntoHead(html, HTML_INJECT) });
      if (handled) return;
    }
    alignOrigin(req);
    return proxy.web(req, res);
  }
  res.writeHead(302, { Location: '/__admin/' });
  res.end();
});

server.on('upgrade', (req, socket, head) => {
  if (!checkAuth(req)) return rejectUpgrade(socket);
  if (!dshReady) {
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    return;
  }
  alignOrigin(req);
  proxy.ws(req, socket, head);
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`[manager] Management service started, listening on 0.0.0.0:${LISTEN_PORT}`);
  console.log(`[manager] Admin page: http://<host>:${LISTEN_PORT}/__admin/ (visiting / redirects automatically when DSH is not installed)`);
  console.log(`[manager] npm registry: default ${DEFAULT_REGISTRY}${state.registry ? `, configured on the page as ${state.registry}` : ''}`);
  if (isDshInstalled()) {
    // When the image has DSH preinstalled / the volume already has DSH, sync the version into state so the page "current version" displays correctly
    if (!state.installedVersion) {
      state.installedVersion = actualVersion();
      state.requestedVersion = state.installedVersion;
      saveState();
    }
    bootDsh().then(r => console.log(r.ok ? `[manager] DSH ${actualVersion()} is ready` : `[manager] DSH failed to start: ${r.reason}`));
  } else {
    console.log('[manager] No installed DSH detected, open the admin page to select a version to install');
  }
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
async function shutdown() {
  console.log('[manager] Received shutdown signal, stopping DSH ...');
  await stopDsh();
  process.exit(0);
}
