'use strict';
/**
 * RUSTRADAR — мониторинг Rust-серверов. Без внешних зависимостей (Node 18+).
 * Источник данных: Steam Web API (IGameServersService/GetServerList).
 * Запуск: STEAM_API_KEY=xxxx node server.js
 * Переменные окружения: STEAM_API_KEY (обязательно), PORT, HOST, TRUST_PROXY=1
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const STEAM_KEY = process.env.STEAM_API_KEY || '';
const STEAM_URL = process.env.STEAM_API_URL ||
  'https://api.steampowered.com/IGameServersService/GetServerList/v1/';
const PUBLIC_DIR = path.join(__dirname, 'public');

const CACHE_TTL = 60 * 1000;          // список обновляется раз в 60 сек
const RATE_LIMIT = 60;                // запросов к API в минуту с одного IP
const RATE_WINDOW = 60 * 1000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
};

/* ---------- rate limit ---------- */
const hits = new Map();
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) return String(xf).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
function limited(ip) {
  const now = Date.now();
  let e = hits.get(ip);
  if (!e || now > e.reset) { e = { count: 0, reset: now + RATE_WINDOW }; hits.set(ip, e); }
  e.count++;
  return e.count > RATE_LIMIT;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, RATE_WINDOW).unref();

/* ---------- Steam: загрузка и кэш общего списка ---------- */
const snapshots = new Map();   // ключ региона -> { t, list }
const inflights = new Map();

// Коды регионов Steam: 0 US East, 1 US West, 2 Юж. Америка, 3 Европа, 4 Азия, 5 Океания, 6 Ближний Восток, 7 Африка
const REGIONS = {
  eu: [3],
  na: [0, 1],
  sa: [2],
  as: [4, 6],
  oc: [5],
  af: [7],
};

function parseTags(gametype) {
  const t = {};
  for (const part of String(gametype || '').split(',')) {
    const m = /^(mp|cp|qp|born)(\d+)$/.exec(part);
    if (m) t[m[1]] = Number(m[2]);
  }
  return t;
}

function mapServer(s) {
  const tags = parseTags(s.gametype);
  const born = tags.born && tags.born > 1e9 && tags.born < 4e9 ? tags.born : 0;
  const addr = String(s.addr || '');
  const ip = addr.split(':')[0];
  const port = Number(s.gameport) || Number(addr.split(':')[1]) || 0;
  return {
    id: String(s.steamid || addr),
    name: String(s.name || 'Unknown').slice(0, 160),
    players: Number(s.players) | 0,
    maxPlayers: Number(s.max_players) || tags.mp || 0,
    ip,
    port,
    country: '',
    rank: 0,
    lastWipe: born ? new Date(born * 1000).toISOString() : null,
    map: s.map ? String(s.map).slice(0, 60) : null,
    type: /(^|,)pve(,|$)/.test(String(s.gametype || '')) ? 'PvE' : null,
    queue: tags.qp | 0,
  };
}

async function fetchCode(code) {
  let filter = '\\appid\\252490\\empty\\1';
  if (code !== null) filter += '\\region\\' + code;
  const u = new URL(STEAM_URL);
  u.searchParams.set('key', STEAM_KEY);
  u.searchParams.set('filter', filter);
  u.searchParams.set('limit', '20000');
  const r = await fetch(u, {
    headers: { Accept: 'application/json', 'User-Agent': 'RustRadar/1.0' },
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) throw new Error('steam http ' + r.status);
  const body = await r.json();
  const raw = (body && body.response && body.response.servers) || [];
  return raw.map(mapServer).filter((s) => s.ip && s.port);
}

async function fetchCodes(codes) {
  const lists = await Promise.all(codes.map(fetchCode));
  const seen = new Set();
  const out = [];
  for (const list of lists) for (const s of list) {
    if (!seen.has(s.id)) { seen.add(s.id); out.push(s); }
  }
  return out;
}

async function getSnapshot(region) {
  const key = region || 'all';
  const snap = snapshots.get(key);
  if (snap && Date.now() - snap.t < CACHE_TTL) return snap;
  if (!inflights.has(key)) {
    const codes = region ? REGIONS[region] : [null];
    inflights.set(key, fetchCodes(codes)
      .then((list) => { const s = { t: Date.now(), list }; snapshots.set(key, s); return s; })
      .finally(() => inflights.delete(key)));
  }
  try { return await inflights.get(key); }
  catch (e) {
    console.error('[steam error]', new Date().toISOString(), key, e && e.message,
      e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : '');
    if (snap) return snap;   // отдаём старые данные, если есть
    throw e;
  }
}

async function handleServers(req, res, url) {
  const ip = clientIp(req);
  if (limited(ip)) return json(res, 429, { error: 'Too many requests' }, { 'Retry-After': '60' });

  if (!STEAM_KEY && !process.env.STEAM_API_URL) {
    return json(res, 503, { error: 'STEAM_API_KEY is not configured' });
  }

  const q = (url.searchParams.get('q') || '').slice(0, 64).toLowerCase();
  let size = parseInt(url.searchParams.get('size') || '100', 10);
  if (!Number.isFinite(size)) size = 100;
  size = Math.min(Math.max(size, 1), 100);
  const wipeDays = { 7: 7, 14: 14, 30: 30 }[url.searchParams.get('wipe')] || 0;
  const regionRaw = url.searchParams.get('region');
  const region = Object.prototype.hasOwnProperty.call(REGIONS, regionRaw) ? regionRaw : '';
  const onlineRaw = url.searchParams.get('online');
  const online = ['small', 'mid', 'high'].includes(onlineRaw) ? onlineRaw : '';

  try {
    const snap = await getSnapshot(region);
    let list = snap.list.filter((s) => s.players > 0 || s.maxPlayers > 0);
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q));
    if (wipeDays) {
      const limit = Date.now() - wipeDays * 86400000;
      list = list.filter((s) => s.lastWipe && new Date(s.lastWipe).getTime() >= limit);
    }
    if (online === 'small') list = list.filter((s) => s.players < 200);
    else if (online === 'mid') list = list.filter((s) => s.players >= 200 && s.players < 600);
    else if (online === 'high') list = list.filter((s) => s.players >= 600);
    list = list.slice().sort((a, b) => b.players - a.players).slice(0, size);
    return json(res, 200, { updated: snap.t, total: snap.list.length, servers: list });
  } catch (e) {
    return json(res, 502, { error: 'Upstream unavailable', detail: String((e && e.message) || e).slice(0, 120) });
  }
}

/* ---------- helpers ---------- */
function json(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extra,
  });
  res.end(body);
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { decoded = ''; }
  if (!decoded || decoded.includes('\0')) return notFound(res);

  const file = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res); // защита от ../

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'Content-Length': st.size,
      ...SECURITY_HEADERS,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
  res.end('404 Not Found');
}

/* ---------- server ---------- */
const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
    return res.end();
  }
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return notFound(res); }

  if (url.pathname === '/api/servers') return handleServers(req, res, url);
  if (url.pathname === '/healthz') return json(res, 200, { ok: true });
  serveStatic(req, res, url.pathname);
});

server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50;

server.listen(PORT, HOST, () => console.log(`RUSTRADAR: http://${HOST}:${PORT}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
