'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const el = { q: $('q'), region: $('region'), wipe: $('wipe'), sort: $('sort'),
    favOnly: $('favOnly'), auto: $('auto'), list: $('list'), empty: $('empty'),
    notice: $('notice'), updated: $('updated'), toast: $('toast') };

  let servers = [];
  let updatedAt = 0;
  let favs = new Set();
  try { favs = new Set(JSON.parse(localStorage.getItem('rr_favs') || '[]')); } catch {}

  const saveFavs = () => { try { localStorage.setItem('rr_favs', JSON.stringify([...favs])); } catch {} };
  const nf = new Intl.NumberFormat('ru-RU');

  /* ---------- утилиты ---------- */
  function h(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;   // только textContent: имена серверов приходят от игроков
    return n;
  }
  function ageDays(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity; }
  function ago(iso) {
    if (!iso) return 'вайп неизвестен';
    const m = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
    if (m < 60) return `вайп ${m} мин назад`;
    const hh = Math.floor(m / 60);
    if (hh < 24) return `вайп ${hh} ч назад`;
    const d = Math.floor(hh / 24);
    return `вайп ${d} дн назад`;
  }
  function flag(cc) {
    if (!/^[A-Za-z]{2}$/.test(cc || '')) return '🌐';
    return String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0)));
  }
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.toast.classList.remove('show'), 1800);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Скопировано: ' + text); }
    catch { toast('Не удалось скопировать'); }
  }

  /* ---------- загрузка ---------- */
  let ctrl;
  let loadedQuery = null;
  let loadedOnce = false;
  let failed = false;
  let stats = null;

  function buildQuery() {
    const p = new URLSearchParams({ size: '100' });
    if (el.favOnly.checked) p.set('ids', [...favs].slice(0, 50).join(','));   // избранные ищем среди ВСЕХ серверов
    if (el.q.value.trim()) p.set('q', el.q.value.trim());
    if (el.region.value) p.set('region', el.region.value);
    if (el.wipe.value !== '0') p.set('wipe', el.wipe.value);
    if (el.sort.value !== 'all') p.set('online', el.sort.value);
    return p.toString();
  }

  async function load(animate) {
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();

    if (el.favOnly.checked && !favs.size) {   // в избранном пусто: сервер не нужен
      servers = []; stats = null; failed = false; loadedOnce = true; loadedQuery = null;
      el.notice.hidden = true;
      return render(animate);
    }

    const query = buildQuery();
    if (!loadedOnce) skeleton();
    try {
      const r = await fetch('/api/servers?' + query, { signal: ctrl.signal });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      servers = Array.isArray(data.servers) ? data.servers : [];
      stats = data.stats || null;
      drawSpark(data.history);
      updatedAt = data.updated || Date.now();
      loadedQuery = query;
      failed = false;
      el.notice.hidden = true;
    } catch (e) {
      if (e.name === 'AbortError') return;
      failed = true;
      if (loadedQuery !== query) { servers = []; stats = null; }   // не показываем список от других фильтров
      el.notice.hidden = false;
      el.notice.textContent = 'Не удалось получить данные. Повторю попытку автоматически.';
    }
    loadedOnce = true;
    render(animate);
  }

  function skeleton() {
    el.list.replaceChildren(...Array.from({ length: 8 }, () => h('div', 'skel')));
  }

  function visible() {
    return el.favOnly.checked ? servers.filter((s) => favs.has(s.id)) : servers;
  }

  /* ---------- плавный подсчёт чисел ---------- */
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const shown = {};
  function setNum(id, v) {
    const e = $(id);
    const from = shown[id] == null ? 0 : shown[id];
    shown[id] = v;
    cancelAnimationFrame(e._raf);
    if (reduceMotion || from === v) { e.textContent = nf.format(v); return; }
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 650);
      e.textContent = nf.format(Math.round(from + (v - from) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) e._raf = requestAnimationFrame(step);
    };
    e._raf = requestAnimationFrame(step);
  }

  /* ---------- график онлайна за сутки ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  let sparkKey = '';
  function drawSpark(hist) {
    const wrap = $('spark-wrap');
    if (!Array.isArray(hist) || hist.length < 2) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const last = hist[hist.length - 1];
    $('spark-now').textContent = nf.format(last[1]) + ' игроков сейчас';
    const key = hist.length + ':' + last[0];
    if (key === sparkKey) return;
    sparkKey = key;
    const W = 600, H = 80, P = 6;
    const vals = hist.map((p) => p[1]);
    const max = Math.max(...vals, 1), min = Math.min(...vals);
    const range = max - min || 1;
    const pts = hist.map((p, i) => [
      P + (i / (hist.length - 1)) * (W - 2 * P),
      H - P - ((p[1] - min) / range) * (H - 2 * P),
    ]);
    const line = pts.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join(' ');
    const svg = $('spark');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const mk = (d, cls) => {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cls);
      return path;
    };
    svg.replaceChildren(
      mk(line + ` L${(W - P).toFixed(1)} ${H - P} L${P} ${H - P} Z`, 'sp-area'),
      mk(line, 'sp-line'),
    );
  }

  /* ---------- рендер ---------- */
  function card(s, i, animate) {
    const c = h('article', animate ? 'card anim' : 'card');
    if (animate) c.style.animationDelay = Math.min(i, 12) * 25 + 'ms';

    c.append(h('div', i < 3 ? 'rank r' + (i + 1) : 'rank', String(i + 1)));

    const info = h('div', 'info');
    info.append(h('div', 'name', s.name));
    const meta = h('div', 'meta');
    if (s.country) meta.append(h('span', 'tag', `${flag(s.country)} ${s.country}`));
    const d = ageDays(s.lastWipe);
    if (d < 1) meta.append(h('span', 'tag new', 'ВАЙП СЕГОДНЯ'));
    else meta.append(h('span', d < 3 ? 'tag fresh' : 'tag', ago(s.lastWipe)));
    if (s.map) meta.append(h('span', 'tag', s.map));
    if (s.type) meta.append(h('span', 'tag', s.type));
    if (s.queue > 0) meta.append(h('span', 'tag q', `очередь ${s.queue}`));
    info.append(meta);
    c.append(info);

    const pop = h('div', 'pop');
    const t = h('div', 'pop-t');
    const b = h('b', null, nf.format(s.players));
    t.append(b, h('span', null, '/ ' + nf.format(s.maxPlayers)));
    const bar = h('div', 'bar'); const fill = h('i');
    fill.style.width = Math.min(100, Math.round((s.players / (s.maxPlayers || 1)) * 100)) + '%';
    bar.append(fill); pop.append(t, bar);
    c.append(pop);

    const acts = h('div', 'acts');
    const addr = `${s.ip}:${s.port}`;
    const play = h('button', 'btn main', 'Подключиться');
    play.type = 'button';
    play.title = 'Скопировать команду client.connect';
    play.addEventListener('click', () => copy(`client.connect ${addr}`));
    const star = h('button', 'btn star' + (favs.has(s.id) ? ' on' : ''), '★');
    star.type = 'button';
    star.setAttribute('aria-label', 'В избранное');
    star.addEventListener('click', () => {
      favs.has(s.id) ? favs.delete(s.id) : favs.add(s.id);
      saveFavs();
      star.classList.toggle('on', favs.has(s.id));
      if (el.favOnly.checked) render(false);   // убрать из «Избранных» без перерисовки остального
    });
    acts.append(play, star);
    c.append(acts);
    return c;
  }

  function emptyText() {
    if (el.favOnly.checked && !favs.size) return 'В избранном пока пусто. Нажми ★ у сервера.';
    if (failed && !servers.length) return 'Данные пока недоступны, повторяю попытку…';
    return 'Ничего не найдено. Попробуй изменить фильтры.';
  }

  function render(animate) {
    const a = visible();
    el.list.replaceChildren(...a.slice(0, 100).map((s, i) => card(s, i, animate)));
    el.empty.hidden = a.length > 0;
    el.empty.textContent = emptyText();

    const st = stats && !el.favOnly.checked ? stats : {
      servers: a.length,
      players: a.reduce((n, s) => n + s.players, 0),
      wipes24: a.filter((s) => ageDays(s.lastWipe) < 1).length,
      top: a[0] ? { name: a[0].name, players: a[0].players } : null,
    };
    setNum('st-players', st.players);
    setNum('st-servers', st.servers);
    setNum('st-wipe', st.wipes24);
    $('st-top').textContent = st.top ? `${st.top.name} · ${nf.format(st.top.players)}` : '—';
    tick();
  }

  /* ---------- таймер до форс-вайпа: первый четверг месяца, 19:00 UTC ---------- */
  function firstThursday(y, m) {
    const d = new Date(Date.UTC(y, m, 1, 19));
    d.setUTCDate(1 + ((4 - d.getUTCDay() + 7) % 7));
    return d;
  }
  function nextForceWipe(now) {
    const n = new Date(now);
    let w = firstThursday(n.getUTCFullYear(), n.getUTCMonth());
    if (w.getTime() <= now) w = firstThursday(n.getUTCFullYear(), n.getUTCMonth() + 1);
    return w;
  }
  function wipeText(now) {
    const w = nextForceWipe(now);
    let m = Math.max(0, Math.floor((w.getTime() - now) / 60000));
    const d = Math.floor(m / 1440); m -= d * 1440;
    const hh = Math.floor(m / 60); m -= hh * 60;
    const left = d > 0 ? `${d} дн ${hh} ч` : hh > 0 ? `${hh} ч ${m} мин` : `${m} мин`;
    const when = w.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    return `Форс-вайп Rust через ${left} · ${when} по твоему времени`;
  }

  let lastUpd = '';
  let lastWipeTxt = '';
  function tick() {
    if (updatedAt) {
      const s = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
      const t = s < 5 ? 'обновлено только что' : `обновлено ${s} сек назад`;
      if (t !== lastUpd) { lastUpd = t; el.updated.textContent = t; }
    }
    const w = wipeText(Date.now());
    if (w !== lastWipeTxt) { lastWipeTxt = w; $('wipe-txt').textContent = w; }
  }

  /* ---------- подсветка карточки под курсором и кнопка «Наверх» ---------- */
  let spot = 0;
  el.list.addEventListener('pointermove', (e) => {
    const c = e.target.closest ? e.target.closest('.card') : null;
    if (!c || spot) return;
    const x = e.clientX, y = e.clientY;
    spot = requestAnimationFrame(() => {
      spot = 0;
      const r = c.getBoundingClientRect();
      c.style.setProperty('--mx', (x - r.left) + 'px');
      c.style.setProperty('--my', (y - r.top) + 'px');
    });
  });
  const up = $('up');
  window.addEventListener('scroll', () => { up.hidden = window.scrollY < 500; }, { passive: true });
  up.addEventListener('click', () => window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' }));

  /* ---------- события ---------- */
  let deb;
  el.q.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(() => load(true), 400); });
  el.sort.addEventListener('change', () => load(true));
  el.region.addEventListener('change', () => load(true));
  el.wipe.addEventListener('change', () => load(true));
  el.favOnly.addEventListener('change', () => load(true));

  setInterval(tick, 1000);
  setInterval(() => { if (el.auto.checked && !document.hidden) load(false); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && el.auto.checked) load(false); });

  tick();
  load(true);
})();
