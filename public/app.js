'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const el = { q: $('q'), wipe: $('wipe'), sort: $('sort'),
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
  async function load() {
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    const p = new URLSearchParams({ size: '100' });
    if (el.q.value.trim()) p.set('q', el.q.value.trim());
    if (el.wipe.value !== '0') p.set('wipe', el.wipe.value);
    if (el.sort.value !== 'all') p.set('online', el.sort.value);

    if (!servers.length) skeleton();
    try {
      const r = await fetch('/api/servers?' + p, { signal: ctrl.signal });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      servers = Array.isArray(data.servers) ? data.servers : [];
      updatedAt = data.updated || Date.now();
      el.notice.hidden = true;
    } catch (e) {
      if (e.name === 'AbortError') return;
      el.notice.hidden = false;
      el.notice.textContent = 'Не удалось получить данные. Показываю последние известные, повторю попытку автоматически.';
    }
    render();
  }

  function skeleton() {
    el.list.replaceChildren(...Array.from({ length: 8 }, () => h('div', 'skel')));
  }

  /* ---------- фильтры ---------- */
  function visible() {
    let a = servers.slice();
    if (el.favOnly.checked) a = a.filter((s) => favs.has(s.id));
    a.sort((x, y) => y.players - x.players);
    return a;
  }

  /* ---------- рендер ---------- */
  function card(s, i) {
    const c = h('article', 'card');
    c.style.animationDelay = Math.min(i, 12) * 25 + 'ms';

    c.append(h('div', 'rank', String(i + 1)));

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
      saveFavs(); render();
    });
    acts.append(play, star);
    c.append(acts);
    return c;
  }

  function render() {
    const a = visible();
    el.list.replaceChildren(...a.slice(0, 100).map(card));
    el.empty.hidden = a.length > 0;

    $('st-players').textContent = nf.format(servers.reduce((n, s) => n + s.players, 0));
    $('st-servers').textContent = nf.format(servers.length);
    $('st-wipe').textContent = nf.format(servers.filter((s) => ageDays(s.lastWipe) < 1).length);
    const top = servers.slice().sort((x, y) => y.players - x.players)[0];
    $('st-top').textContent = top ? `${top.name} · ${top.players}` : '—';
    tick();
  }

  function tick() {
    if (!updatedAt) return;
    const s = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
    el.updated.textContent = s < 5 ? 'обновлено только что' : `обновлено ${s} сек назад`;
  }

  /* ---------- события ---------- */
  let deb;
  el.q.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(load, 400); });
  el.sort.addEventListener('change', load);
  el.wipe.addEventListener('change', load);
  el.favOnly.addEventListener('change', render);

  setInterval(tick, 1000);
  setInterval(() => { if (el.auto.checked && !document.hidden) load(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && el.auto.checked) load(); });

  load();
})();
