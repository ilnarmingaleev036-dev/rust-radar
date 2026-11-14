'use strict';
/* Отметки радара: на КАЖДОМ обороте луча каждая отметка вспыхивает ровно один раз
 * в новом случайном месте. Каждая отметка — пара элементов, которые работают по очереди:
 * чётные обороты одним, нечётные другим. Так новое место выбирается, пока второй
 * элемент ещё не светится, и ни один проход луча не пропадает.
 * Луч берётся из той же CSS-анимации, что и сам луч, поэтому вспышка совпадает с ним. */
(() => {
  const radar = document.querySelector('.radar');
  if (!radar) return;
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const sweep = radar.querySelector('.r-sweep');
  const originals = Array.from(radar.querySelectorAll('.blip'));
  const clones = originals.map((el) => { const c = el.cloneNode(false); radar.appendChild(c); return c; });
  const PERIOD = 5000;          // мс на оборот, как в CSS
  const SIZE = 380;             // ширина радара, px
  const RING = [56, 118];       // допустимое расстояние от центра, px

  const rnd = (a, b) => a + Math.random() * (b - a);

  // Новое место для элемента s; вспышка — на его ближайшем проходе луча в обороте k.
  function schedule(s, k, now) {
    const theta = rnd(0, 360);
    const r = rnd(RING[0], RING[1]);
    const pct = (r / SIZE) * 100;
    const rad = (theta * Math.PI) / 180;
    s.el.style.left = (50 + pct * Math.sin(rad)).toFixed(2) + '%';
    s.el.style.top = (50 - pct * Math.cos(rad)).toFixed(2) + '%';
    let kk = k;
    while (kk * PERIOD + (theta / 360) * PERIOD <= now) kk += 2;   // только обороты своей очереди
    s.k = kk;
    s.flashAt = kk * PERIOD + (theta / 360) * PERIOD;
  }

  // Элементы: originals — чётные обороты, clones — нечётные.
  const states = [
    ...originals.map((el) => ({ el, par: 0 })),
    ...clones.map((el) => ({ el, par: 1 })),
  ];
  let anim = null;

  function frame() {
    if (!anim) anim = sweep.getAnimations()[0] || null;
    if (anim) {
      const now = Number(anim.currentTime) || 0;
      const cur = Math.floor(now / PERIOD);
      for (const s of states) {
        if (s.flashAt === undefined) {
          let k = cur;
          if (((k % 2) + 2) % 2 !== s.par) k += 1;
          schedule(s, k, now);
        }
        // вспышка и затухание своего оборота закончились: элемент скрыт, выбираем место на свой следующий оборот
        if (now >= s.flashAt + PERIOD) schedule(s, s.k + 2, now);

        const a = now - s.flashAt;
        if (a < 0 || a >= PERIOD) {
          s.el.style.opacity = '0';
        } else {
          const x = a / PERIOD;
          const o = Math.pow(1 - x, 1.6);   // яркая вспышка, плавное затухание до следующего оборота
          s.el.style.opacity = o.toFixed(3);
          s.el.style.transform = `scale(${(0.7 + (1 - x)).toFixed(3)})`;
          s.el.style.boxShadow = `0 0 ${(18 * o + 4).toFixed(1)}px ${(6 * o).toFixed(1)}px rgba(255,120,40,${(0.95 * o).toFixed(3)})`;
        }
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
