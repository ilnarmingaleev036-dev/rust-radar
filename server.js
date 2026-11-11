'use strict';
/**
 * RUSTRADAR — мониторинг Rust-серверов. Без внешних зависимостей (Node 18+).
 * Запуск: node server.js
 * Переменные окружения: PORT, HOST, TRUST_PROXY=1 (если за nginx/Cloudflare)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const CACHE_TTL = 60 * 1000;          // данные кэшируются на 60 сек
const CACHE_MAX = 200;
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

/* ---------- cache ---------- */
const cache = new Map();
function cacheGet(key) {
  const e = cache.get(key);
  if (e && Date.now() - e.t < CACHE_TTL) return e.v;
  return null;
}
function cacheSet(key, v) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { t: Date.now(), v });
}

/* ---------- API ---------- */
const SORTS = new Set(['-players', 'players', 'rank', '-rank', '-details.rust_last_wipe']);

function buildUpstream(params) {
  const q = (params.get('q') || '').slice(0, 64);
  const country = (params.get('country') || '').toUpperCase();
  const sort = params.get('sort') || '-players';
  let size = parseInt(params.get('size') || '100', 10);
  if (!Number.isFinite(size)) size = 100;
  size = Math.min(Math.max(size, 1), 100);

  if (country && !/^[A-Z]{2}$/.test(country)) throw new Error('bad country');
  if (!SORTS.has(sort)) throw new Error('bad sort');

  const u = new URL('https://api.battlemetrics.com/servers');
  u.searchParams.set('filter[game]', 'rust');
  u.searchParams.set('filter[status]', 'online');
  u.searchParams.set('sort', sort);
  u.searchParams.set('page[size]', String(size));
  if (q) u.searchParams.set('filter[search]', q);
  if (country) u.searchParams.set('filter[countries]', country);
  return u;
}

function mapServer(item) {
  const a = item.attributes || {};
  const d = a.details || {};
  return {
    id: String(item.id),
    name: String(a.name || 'Unknown').slice(0, 160),
    players: a.players | 0,
    maxPlayers: a.maxPlayers | 0,
    ip: String(a.ip || ''),
    port: a.port | 0,
    country: String(a.country || '').slice(0, 2),
    rank: a.rank | 0,
    lastWipe: d.rust_last_wipe || null,
    map: d.map ? String(d.map).slice(0, 60) : null,
    type: d.rust_type ? String(d.rust_type).slice(0, 30) : null,
    queue: (d.rust_queued_players | 0) || 0,
  };
}

async function handleServers(req, res, url) {
  const ip = clientIp(req);
  if (limited(ip)) return json(res, 429, { error: 'Too many requests' }, { 'Retry-After': '60' });

  let upstream;
  try { upstream = buildUpstream(url.searchParams); }
  catch { return json(res, 400, { error: 'Bad request' }); }

  const key = upstream.toString();
  const cached = cacheGet(key);
  if (cached) return json(res, 200, cached, { 'X-Cache': 'HIT' });

  try {
    const r = await fetch(upstream, {
      headers: { Accept: 'application/json', 'User-Agent': 'RustRadar/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('upstream ' + r.status);
    const body = await r.json();
    const out = { updated: Date.now(), servers: (body.data || []).map(mapServer) };
    cacheSet(key, out);
    return json(res, 200, out, { 'X-Cache': 'MISS' });
  } catch (e) {
    const stale = cache.get(key);
    if (stale) return json(res, 200, stale.v, { 'X-Cache': 'STALE' });
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
