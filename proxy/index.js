const http = require('http');
const httpProxy = require('http-proxy');
const crypto = require('crypto');
const { serveIndex, injectIntoHead } = require('./upstream-token.js');
const { attachBodyTransform } = require('./compression.js');

// Source port (the port DSH listens on, default 3079) and proxy port (the port the proxy listens on externally, default 3080).
// They must be different (a single port can only be listened on by one process); both can be overridden via environment variables:
//   DSH_PORT=source port (DSH)   PROXY_PORT=proxy port (external)
const DSH_PORT = Number(process.env.DSH_PORT) || 3079;
const LISTEN_PORT = Number(process.env.PROXY_PORT) || 3080;
const TARGET_ORIGIN = `http://127.0.0.1:${DSH_PORT}`;
const AUTH_REALM = 'dsh-proxy';

// Basic Auth: username/password are set via environment variables.
// Auth is enabled only when both are set; if either is unset, requests pass through entirely (no auth required).
const AUTH_USER = process.env.PROXY_USERNAME || '';
const AUTH_PASS = process.env.PROXY_PASSWORD || '';

// Public static asset whitelist: contains only non-sensitive data such as the app name/icons (PWA manifest, site icons).
// When the browser fetches <link rel="manifest"> (the tag does not carry crossorigin="use-credentials")
// it does not send Basic Auth credentials; if these paths also required auth, the console would
// constantly report /manifest.webmanifest 401. So authentication is skipped for whitelisted paths; pages, APIs, and WS still all require auth.
const PUBLIC_PATHS = new Set(['/manifest.webmanifest', '/favicon.svg', '/favicon.ico']);

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function checkAuth(req) {
  if (!AUTH_USER || !AUTH_PASS) return true; // not configured -> no auth required
  const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
  if (!m) return false;
  let decoded;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
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

const proxy = httpProxy.createProxyServer({
  target: TARGET_ORIGIN,
  ws: true,
  changeOrigin: true,
});

// error fallback: when the upstream (DSH) is unreachable/crashes, http-proxy with no error listener throws an
// uncaught exception, killing the whole proxy process. Here all forwarding errors are handled uniformly: HTTP requests get a 502,
// WS upgrades have their socket destroyed directly, and the error is printed for troubleshooting (DSH going offline no longer shows up as a process crash).
proxy.on('error', (err, req, res) => {
  console.error(`[proxy] error forwarding to upstream ${TARGET_ORIGIN}: ${err.code || err.message}`, err.stack || '');
  if (res && res.writeHead) {
    // Normal HTTP connection: return 502 whenever possible; if the response has already been written, just end it
    if (res.headersSent) {
      res.end();
    } else {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('502 Bad Gateway: upstream DSH is unreachable or has exited');
    }
  } else if (res && res.destroy) {
    // WS upgrade: res is actually the underlying socket, with no writeHead; destroy it directly
    res.destroy();
  }
});

// Core fix: crypto.randomUUID polyfill.
// The DSH frontend uses crypto.randomUUID() to generate rpcId, but that API is only available in secure
// contexts such as https/localhost; when accessed via a LAN IP the page is a non-secure context and randomUUID
// does not exist -> RPC requests cannot be sent -> the realtime channel (WS) fails to be established.
// When forwarding HTML, the proxy injects a compatible implementation based on getRandomValues (that API works on non-secure origins).
const POLYFILL = '<script>(function(){try{if(typeof crypto!=="undefined"&&crypto&&typeof crypto.randomUUID!=="function"){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h="";for(var i=0;i<16;i++){h+=b[i].toString(16).padStart(2,"0")}return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}}}catch(e){}})();</script>';

// The DSH frontend uses connection.isLoopback to decide whether settings-related features are available (plugin config cards, settings file buttons, etc.):
// it is true only when accessed via a loopback address such as localhost/127.0.0.1; with hostname/LAN access these features are hidden.
// This proxy is the only entry point for external access, and the browser always connects from a non-loopback address, so
// the `isLoopbackHostname(pageLocation.hostname)` check is rewritten to always be true, letting LAN access use the settings features too.
const LOOPBACK_JS_NEEDLE = 'isLoopbackHostname(pageLocation.hostname)';
const LOOPBACK_JS_REPLACEMENT = 'true';

proxy.on('proxyRes', (proxyRes, req, res) => {
  const ct = String(proxyRes.headers['content-type'] || '');
  const isHtml = ct.includes('text/html');
  const isJs = ct.includes('javascript');
  if (!isHtml && !isJs) return;

  // Handle every compression form from browsers/upstreams (gzip / deflate / br, plus uncompressed identity):
  // buffer the whole response body -> decompress to plaintext per Content-Encoding -> finish the HTML/JS rewrites -> recompress
  // with the original encoding. This way, regardless of whether the upstream compresses and in which format, the rewrite logic below still works.
  // (The previous approach stripped Accept-Encoding when forwarding to force the upstream to return plaintext; that assumption is no longer relied on here)
  attachBodyTransform(res, proxyRes, plain => {
    const text = plain.toString('utf8');
    if (isHtml) {
      // HTML: inject the crypto.randomUUID polyfill
      return Buffer.from(injectIntoHead(text, POLYFILL));
    }
    // JS: rewrite only when the target check string is hit (no hit returns null -> pass through as-is, no pointless recompression)
    if (text.includes(LOOPBACK_JS_NEEDLE)) {
      return Buffer.from(text.split(LOOPBACK_JS_NEEDLE).join(LOOPBACK_JS_REPLACEMENT));
    }
    return null;
  });
});

// changeOrigin rewrites the Host header to the target address, so the Origin sent by the browser must be aligned accordingly,
// otherwise DSH's /api same-origin check (Origin must equal the Host it sees) will reject the request (403),
// and WS handshakes go through the same check.
// Note: Accept-Encoding is no longer stripped. Whether or not the upstream compresses (gzip/deflate/br all fine),
// the compression-compatible pipeline in proxyRes will "decompress -> rewrite -> recompress", preserving the bandwidth benefit.
function alignOrigin(req) {
  if (req.headers.origin) req.headers.origin = TARGET_ORIGIN;
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', 'http://proxy').pathname;
  if (!PUBLIC_PATHS.has(pathname) && !checkAuth(req)) {
    rejectUnauthorized(res);
    return;
  }
  // A GET to the root path goes through serveIndex: if the upstream (e.g. official 0.1.2+) returns 401, resend once carrying the launch token
  // to obtain a session cookie; if it returns false (abnormal), fall back to the plain reverse proxy.
  if (req.method === 'GET' && pathname === '/') {
    serveIndex(req, res, { origin: TARGET_ORIGIN, transformHtml: html => injectIntoHead(html, POLYFILL) })
      .then((handled) => {
        if (handled) return;
        alignOrigin(req);
        proxy.web(req, res);
      });
    return;
  }
  alignOrigin(req);
  proxy.web(req, res);
});

server.on('upgrade', (req, socket, head) => {
  if (!checkAuth(req)) {
    rejectUpgrade(socket);
    return;
  }
  alignOrigin(req);
  proxy.ws(req, socket, head);
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`Proxy started, listening on 0.0.0.0:${LISTEN_PORT}, forwarding to ${TARGET_ORIGIN}${AUTH_USER && AUTH_PASS ? ' (Basic Auth enabled)' : ' (auth disabled)'}`);
});
