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

const CACHE_TTL = Number(process.env.CACHE_TTL_MS) || 60 * 1000;   // список обновляется раз в 60 сек
const STALE_MAX = 5 * 60 * 1000;      // данные старше 5 минут ждут свежие, а не отдаются сразу
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

if (TRUST_PROXY) SECURITY_HEADERS['Content-Security-Policy'] += '; upgrade-insecure-requests';

/* ---------- IP клиента и лимиты ---------- */
const TRUST_HOPS = Math.max(1, Number(process.env.TRUST_PROXY_HOPS) || 1);
function clientIp(req) {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (xf) {
      // Берём адрес, дописанный нашим доверенным прокси (с конца списка),
      // а не первое значение: его клиент может подделать.
      const parts = String(xf).split(',').map((x) => x.trim()).filter(Boolean);
      if (parts.length) return parts[Math.max(0, parts.length - TRUST_HOPS)].slice(0, 64);
    }
  }
  return req.socket.remoteAddress || 'unknown';
}
function makeLimiter(limit) {
  const map = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of map) if (now > v.reset) map.delete(k);
  }, RATE_WINDOW).unref();
  return (ip) => {
    const now = Date.now();
    let e = map.get(ip);
    if (!e || now > e.reset) {
      if (!e && map.size >= 20000) return true;   // защита памяти от переполнения
      e = { count: 0, reset: now + RATE_WINDOW };
      map.set(ip, e);
    }
    e.count++;
    return e.count > limit;
  };
}
const limited = makeLimiter(RATE_LIMIT);   // для /api/servers
const limitedAll = makeLimiter(300);       // для всех запросов

/* ---------- Steam: загрузка и кэш общего списка ---------- */
const redact = (v) => {
  const t = String(v == null ? '' : v);
  return STEAM_KEY ? t.split(STEAM_KEY).join('***') : t;
};

const history = [];   // суточная история общего онлайна: [время, игроки], шаг 5 мин
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
    wipeTs: born ? born * 1000 : 0,
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

const logErr = (key) => (e) => console.error('[steam error]', new Date().toISOString(), key, redact(e && e.message),
  redact(e && e.cause ? String(e.cause.code || e.cause.message || e.cause) : ''));

function refresh(key) {
  if (!inflights.has(key)) {
    const codes = key === 'all' ? [null] : REGIONS[key];
    inflights.set(key, fetchCodes(codes)
      .then((list) => {
        const s = { t: Date.now(), list };
        snapshots.set(key, s);
        if (key === 'all') {
          history.push([s.t, list.reduce((n, x) => n + x.players, 0)]);
          if (history.length > 288) history.shift();
        }
        return s;
      })
      .finally(() => inflights.delete(key)));
  }
  return inflights.get(key);
}

// Отдаём то, что есть, сразу, а свежее подтягиваем в фоне: пользователь не ждёт Steam.
async function getSnapshot(region) {
  const key = region || 'all';
  const snap = snapshots.get(key);
  const age = snap ? Date.now() - snap.t : Infinity;
  if (snap && age < CACHE_TTL) return snap;
  if (snap && age < STALE_MAX) { refresh(key).catch(logErr(key)); return snap; }
  try { return await refresh(key); }
  catch (e) { logErr(key)(e); if (snap) return snap; throw e; }
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
  const idsRaw = url.searchParams.get('ids');
  const ids = idsRaw === null ? null : new Set(
    idsRaw.split(',').slice(0, 50).filter((x) => /^[\w.:-]{1,64}$/.test(x)));
  const onlineRaw = url.searchParams.get('online');
  const online = ['small', 'mid', 'high'].includes(onlineRaw) ? onlineRaw : '';

  try {
    const snap = await getSnapshot(region);
    let list = snap.list.filter((s) => s.players > 0 || s.maxPlayers > 0);
    if (ids) list = list.filter((s) => ids.has(s.id));
    if (q) list = list.filter((s) => s.name.toLowerCase().includes(q));
    if (wipeDays) {
      const limit = Date.now() - wipeDays * 86400000;
      list = list.filter((s) => s.wipeTs && s.wipeTs >= limit);
    }
    if (online === 'small') list = list.filter((s) => s.players < 200);
    else if (online === 'mid') list = list.filter((s) => s.players >= 200 && s.players < 600);
    else if (online === 'high') list = list.filter((s) => s.players >= 600);
    list = list.slice().sort((a, b) => b.players - a.players);
    const day = Date.now() - 86400000;
    let players = 0, wipes24 = 0;
    for (const s of list) { players += s.players; if (s.wipeTs >= day) wipes24++; }
    const stats = {
      servers: list.length, players, wipes24,
      top: list[0] ? { name: list[0].name, players: list[0].players } : null,
    };
    return json(res, 200, { updated: snap.t, total: snap.list.length, stats, history, servers: list.slice(0, size) });
  } catch (e) {
    return json(res, 502, { error: 'Upstream unavailable' });
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
  if (decoded.split('/').some((seg) => seg.startsWith('.'))) return notFound(res);   // скрытые файлы

  const file = path.normalize(path.join(PUBLIC_DIR, decoded));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return notFound(res); // защита от ../

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return notFound(res);
    const ext = path.extname(file).toLowerCase();
    if (!MIME[ext]) return notFound(res);   // отдаём только известные типы файлов
    res.writeHead(200, {
      'Content-Type': MIME[ext],
      'Cache-Control': (ext === '.html' || ext === '.css' || ext === '.js') ? 'no-cache' : 'public, max-age=3600',
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
const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', ...SECURITY_HEADERS });
    return res.end();
  }
  if (!req.url || req.url.length > 2048) {
    res.writeHead(414, SECURITY_HEADERS);
    return res.end();
  }
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { return notFound(res); }

  if (url.pathname === '/healthz') return json(res, 200, { ok: true });

  // За прокси хостинга: http -> https
  if (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'http') {
    const host = String(req.headers.host || '');
    if (!/^[A-Za-z0-9.:-]{1,255}$/.test(host)) return notFound(res);
    res.writeHead(301, { Location: 'https://' + host + req.url, ...SECURITY_HEADERS });
    return res.end();
  }

  if (limitedAll(clientIp(req))) {
    res.writeHead(429, { 'Retry-After': '60', ...SECURITY_HEADERS });
    return res.end();
  }

  if (url.pathname === '/api/servers') return handleServers(req, res, url);
  serveStatic(req, res, url.pathname);
});

server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.keepAliveTimeout = 5000;
server.maxHeadersCount = 50;
server.maxRequestsPerSocket = 100;

server.listen(PORT, HOST, () => {
  console.log(`RUSTRADAR: http://${HOST}:${PORT}`);
  if (STEAM_KEY || process.env.STEAM_API_URL) {
    refresh('all').catch(logErr('all'));   // прогрев кэша
    setInterval(() => refresh('all').catch(logErr('all')), 5 * 60 * 1000).unref();   // история каждые 5 мин
  }
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('unhandledRejection', (e) => console.error('[unhandled]', redact(e && e.message)));
process.on('uncaughtException', (e) => { console.error('[uncaught]', redact(e && e.message)); process.exit(1); });
