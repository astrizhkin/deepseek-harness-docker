// Upstream auto-authorization (forward compatible with the launch-token mechanism of official DSH 0.1.2+).
//
// Design goal: the token is handled entirely by this image; once LAN users pass Basic Auth, no extra action is required.
// Key point: never inject the token on every forwarded request - the official model is "exchange a launch token for a browser session cookie";
// if every request carried the token, the upstream would issue a brand-new identity for each request, causing identity mix-ups.
const fs = require('fs');

const LOG_FILE = process.env.DSH_WEB_LOG || '/app/.dsh-web.log';
const TOKEN_FILE_AUTO = process.env.DSH_TOKEN_FILE_AUTO || '/app/.dsh-launch-token';
// Official DSH 0.1.2+ passes the launch token via "?token=" on the home-page URL (see the address format printed
// by "dsh web"), and exchanges it for a session cookie; putting the token in a request header is not accepted, so it is appended as a query here.
const TOKEN_QUERY_KEY = process.env.DSH_TOKEN_QUERY_KEY || 'token';

const HARD_TOKEN = process.env.DSH_TOKEN || '';
const HARD_TOKEN_FILE = process.env.DSH_TOKEN_FILE || '';

let PATTERN = null;
if (process.env.DSH_LAUNCH_TOKEN_PATTERN) {
  try { PATTERN = new RegExp(process.env.DSH_LAUNCH_TOKEN_PATTERN); } catch {}
}
const DEFAULT_TOKEN_RE = /(?:[?&,]|^)token[=:]\s*["']?([A-Za-z0-9._~-]{16,})/i;

let state = { token: '', source: null, scanning: false, attempts: 0, done: false };
const SCAN_INTERVAL = 2000;
const MAX_SCAN_ATTEMPTS = 30;

function readTail(p, maxBytes) {
  try {
    const st = fs.statSync(p);
    if (!st.size) return '';
    const start = Math.max(0, st.size - maxBytes);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

// Return the [last] match of regex in the text (the log may contain old tokens printed by several launches;
// the newer the print, the further back it appears, so the last one is the current token); return null when there is no match.
function lastMatch(text, regex) {
  let re;
  try {
    re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  } catch {
    return null;
  }
  let last = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    last = m;
    if (m[0] === '') re.lastIndex += 1;
  }
  return last;
}

// Token masking: keep only the first and last 4 characters and fill the middle with *, handy for log debugging without leaking the full token
function maskToken(t) {
  const s = String(t || '');
  if (s.length <= 8) return s ? s.slice(0, 1) + '****' : '(empty)';
  return s.slice(0, 4) + '****' + s.slice(-4);
}

// Extract the latest (trailing) launch token from log text
function extractFromText(text) {
  if (PATTERN) {
    const m = lastMatch(text, PATTERN);
    if (m) return (m[1] !== undefined ? m[1] : m[0]).trim();
  }
  const m = lastMatch(text, DEFAULT_TOKEN_RE);
  return m ? m[1] : null;
}

// One salvage pass: read the tail of the DSH log to extract the token; on a hit, persist it to TOKEN_FILE_AUTO
function scanOnce() {
  const token = extractFromText(readTail(LOG_FILE, 512 * 1024));
  if (token) {
    const t = token.trim();
    try { fs.writeFileSync(TOKEN_FILE_AUTO, t); } catch {}
    state.token = t;
    state.source = 'auto';
    state.done = true;
    console.log(`[upstream-token] automatically captured the DSH launch token (length ${t.length}), used only to exchange for a session when the root path returns 401`);
    return t;
  }
  return null;
}

function readHardToken() {
  if (HARD_TOKEN) return HARD_TOKEN;
  if (HARD_TOKEN_FILE) {
    try { return fs.readFileSync(HARD_TOKEN_FILE, 'utf8').trim(); } catch {}
  }
  return '';
}

// Make sure a token is available: manual first, then automatic salvage (starting a periodic poll when needed)
function ensureToken() {
  if (state.done && state.token) return state.token;
  const hard = readHardToken();
  if (hard) {
    state.token = hard;
    state.source = 'manual';
    state.done = true;
    return hard;
  }
  const fromLog = scanOnce();
  if (fromLog) return fromLog;
  if (state.scanning) return state.token;
  if (state.attempts >= MAX_SCAN_ATTEMPTS) {
    state.done = true;
    return '';
  }
  state.scanning = true;
  const timer = setInterval(() => {
    const t = scanOnce();
    state.attempts += 1;
    if (t || state.attempts >= MAX_SCAN_ATTEMPTS) {
      clearInterval(timer);
      state.scanning = false;
      state.done = true;
    }
  }, SCAN_INTERVAL);
  timer.unref();
  return state.token;
}

// Version probe: for diagnostics and later per-version fine-tuning; usually not needed
const VERSION_PATHS = [
  process.env.DSH_VERSION,
  '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json',
  '/opt/dsh/lib/node_modules/@deepseek-ai/dsh/package.json',
];
function detectDshVersion() {
  for (const p of VERSION_PATHS) {
    if (!p) continue;
    if (String(p).includes('package.json')) {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')).version || null; } catch {}
    } else {
      return p;
    }
  }
  return null;
}

// ── Root-path authorization bootstrap (401 -> resend with token -> pass through set-cookie) ─────
const FORWARD_HEADERS = [
  'accept', 'accept-language', 'user-agent', 'cookie', 'referer',
  'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
];
function pickIndexHeaders(req, dropCookie) {
  const src = req.headers || {};
  const out = { accept: '*/*', 'accept-encoding': 'identity' };
  for (let i = 0; i < FORWARD_HEADERS.length; i++) {
    const n = FORWARD_HEADERS[i];
    // A token exchange = obtaining a brand-new session; if the browser sends an old cookie (an expired/invalid session),
    // the upstream fails cookie validation and answers 401 directly, so the resend would never succeed. Hence it is stripped when resending.
    if (dropCookie && n === 'cookie') continue;
    if (src[n]) out[n] = src[n];
  }
  return out;
}

async function fetchRaw(origin, headers, path) {
  const url = path && path !== '/' ? origin + path : origin + '/';
  const res = await fetch(url, { method: 'GET', headers, redirect: 'manual' });
  const getSetCache = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  return {
    status: res.status,
    headers: res.headers,
    setCookies: Array.isArray(getSetCache) ? getSetCache : [],
    body: await res.text(),
  };
}

// Inject a script snippet into the HTML content, right after the first <head> (or at the very beginning if there is none).
function injectIntoHead(content, snippet) {
  const i = content.toLowerCase().indexOf('<head');
  if (i !== -1) {
    const e = content.indexOf('>', i);
    return e !== -1 ? content.slice(0, e + 1) + snippet + content.slice(e + 1) : snippet + content;
  }
  return snippet + content;
}

// Pass the upstream response through to the browser as a whole (keep set-cookie so the browser can establish a session; html is rewritten by injection).
function sendRaw(r, res, transformHtml) {
  const hs = {};
  for (const [k, v] of r.headers) {
    const lk = k.toLowerCase();
    if (['content-length', 'content-encoding', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'set-cookie'].includes(lk)) continue;
    hs[k] = v;
  }
  hs['Cache-Control'] = hs['Cache-Control'] || 'no-store';
  if (r.setCookies.length) hs['Set-Cookie'] = r.setCookies;

  let body = r.body;
  const ct = String(r.headers.get ? r.headers.get('content-type') : '').toLowerCase();
  if (ct.includes('text/html') && transformHtml) body = transformHtml(body);
  // For 3xx / empty-body responses (such as a 303 redirect) do not set Content-Type, to avoid misleading the browser into treating it as HTML
  if (body && body.length) {
    hs['Content-Type'] = ct || 'text/html; charset=utf-8';
  }

  res.writeHead(r.status, hs);
  res.end(body);
  return true;
}

// Handle a GET on the root path: normally just forward it; when the upstream answers 401, resend once carrying the launch token,
// and pass the set-cookie returned by the upstream (retry) through to the browser, after which the browser authenticates with that cookie automatically.
// Return true when the response has been taken over; return false when something went wrong and the caller should fall back to the plain reverse proxy.
async function serveIndex(req, res, ctx) {
  const origin = ctx.origin;
  const transformHtml = ctx.transformHtml;
  const reqUrl = req.url || '/';
  let first;
  try {
    first = await fetchRaw(origin, pickIndexHeaders(req), reqUrl);
  } catch {
    return false;
  }
  if (first.status === 401) {
    const token = ensureToken();
    if (token) {
      console.log(`[upstream-token] first root-path request returned 401, trying a resend carrying the launch token (${maskToken(token)}) to exchange for a session cookie`);
      // Official format: append the launch token to the query of the root-path URL to exchange for an upstream session cookie
      const sep = reqUrl.includes('?') ? '&' : '?';
      const authUrl = `${reqUrl}${sep}${TOKEN_QUERY_KEY}=${encodeURIComponent(token)}`;
      let retry;
      // The resend is "exchanging for a brand-new session", so the browser's old cookie must be stripped, otherwise the upstream may answer 401 directly because of the invalid cookie
      try { retry = await fetchRaw(origin, pickIndexHeaders(req, true), authUrl); } catch { retry = null; }
      if (retry) {
        const sc = retry.setCookies.length;
        console.log(`[upstream-token] resend carrying the token -> upstream returned ${retry.status}, issuing ${sc} session cookie(s)`);
        if (retry.status === 401) {
          console.log(`[upstream-token] automatic login failed: resending with the launch token (${maskToken(token)}) still returned 401 (the token may have expired or been invalidated, or this upstream version does not support the query-token method)`);
        } else if (retry.status >= 300 && retry.status < 400) {
          const loc = String(retry.headers.get ? retry.headers.get('location') : retry.headers.location || '');
          console.log(`[upstream-token] automatic login succeeded: upstream ${retry.status} redirected to "${loc || '/'}", issuing ${sc} session cookie(s); after pass-through the browser follows the redirect and carries the cookie automatically`);
        }
        return sendRaw(retry, res, transformHtml);
      }
      console.log('[upstream-token] resend carrying the token failed (network error or no upstream response), falling back to passing through the first 401');
    } else {
      console.log('[upstream-token] no launch token obtained, skipping the resend and passing through the first 401');
    }
  } else if (first.status !== 200) {
    console.log(`[upstream-token] first root-path request returned ${first.status} (not 401), passing it through directly`);
  }
  return sendRaw(first, res, transformHtml);
}

module.exports = { serveIndex, ensureToken, injectIntoHead, detectDshVersion };