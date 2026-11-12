'use strict';
/* Красивые выпадающие списки поверх обычных <select>.
 * Настоящий <select> остаётся в странице (скрытый) и по-прежнему хранит значение,
 * поэтому остальной код работает как раньше. Если скрипт не загрузится,
 * пользователь увидит обычный список браузера. */
(() => {
  const NS = 'http://www.w3.org/2000/svg';

  function icon(cls, d, w) {
    const s = document.createElementNS(NS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', '16');
    s.setAttribute('height', '16');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', cls);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', w || '2.4');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    s.append(p);
    return s;
  }
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };

  let uid = 0;
  const all = [];

  function enhance(sel) {
    const id = 'dd' + ++uid;
    const wrap = el('div', 'dd');
    const btn = el('button', 'dd-btn');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', id);
    const label = el('span', 'dd-label');
    btn.append(label, icon('dd-chev', 'M6 9l6 6 6-6'));

    const backdrop = el('div', 'dd-backdrop');
    const list = el('ul', 'dd-list');
    list.id = id;
    list.tabIndex = -1;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', sel.getAttribute('aria-label') || '');

    const items = Array.from(sel.options).map((o, i) => {
      const li = el('li', 'dd-opt');
      li.id = id + '-' + i;
      li.setAttribute('role', 'option');
      const t = el('span', 'dd-text');
      t.textContent = o.textContent;
      li.append(t, icon('dd-check', 'M5 12.5l4.5 4.5L19 7.5'));
      li.addEventListener('click', () => { choose(i); close(true); });
      li.addEventListener('pointermove', () => highlight(i));
      list.append(li);
      return li;
    });

    sel.parentNode.insertBefore(wrap, sel);
    wrap.append(btn, backdrop, list, sel);
    sel.classList.add('dd-native');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');

    let hl = sel.selectedIndex;

    function paint() {
      const cur = sel.selectedIndex;
      label.textContent = sel.options[cur].textContent;
      items.forEach((li, i) => li.setAttribute('aria-selected', i === cur ? 'true' : 'false'));
      wrap.classList.toggle('active', cur !== 0);   // выбран не пункт по умолчанию
    }
    function highlight(i) {
      hl = Math.max(0, Math.min(items.length - 1, i));
      items.forEach((li, k) => li.classList.toggle('hl', k === hl));
      list.setAttribute('aria-activedescendant', items[hl].id);
      items[hl].scrollIntoView({ block: 'nearest' });
    }
    function choose(i) {
      if (i !== sel.selectedIndex) {
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
      paint();
    }
    function openList() {
      all.forEach((d) => d !== api && d.close());
      list.classList.remove('right');
      wrap.classList.add('open');
      btn.setAttribute('aria-expanded', 'true');
      const r = list.getBoundingClientRect();
      if (r.right > window.innerWidth - 8) list.classList.add('right');
      highlight(sel.selectedIndex);
      list.focus({ preventScroll: true });
    }
    function close(refocus) {
      if (!wrap.classList.contains('open')) return;
      wrap.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
      if (refocus) btn.focus({ preventScroll: true });
    }

    btn.addEventListener('click', () => (wrap.classList.contains('open') ? close(true) : openList()));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openList(); }
    });
    backdrop.addEventListener('click', () => close(true));
    list.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); highlight(hl + 1); break;
        case 'ArrowUp': e.preventDefault(); highlight(hl - 1); break;
        case 'Home': e.preventDefault(); highlight(0); break;
        case 'End': e.preventDefault(); highlight(items.length - 1); break;
        case 'Enter':
        case ' ': e.preventDefault(); choose(hl); close(true); break;
        case 'Escape': e.preventDefault(); close(true); break;
        case 'Tab': close(false); break;
        default:
      }
    });
    sel.addEventListener('change', paint);

    const api = { close: () => close(false), contains: (n) => wrap.contains(n) };
    all.push(api);
    paint();
  }

  document.addEventListener('pointerdown', (e) => {
    all.forEach((d) => { if (!d.contains(e.target)) d.close(); });
  });

  // Если стили не подгрузились (старый кэш), оставляем обычные списки браузера
  const probe = el('div', 'dd-native');
  document.body.append(probe);
  const cssOk = getComputedStyle(probe).position === 'absolute';
  probe.remove();
  if (!cssOk) return;

  document.querySelectorAll('select[data-dd]').forEach(enhance);
})();
