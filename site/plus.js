const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 言語の切り替え: 外を押すか Esc で閉じる（main.js と同じ）
const langMenu = $('.lang');
if (langMenu) {
  document.addEventListener('click', (e) => { if (langMenu.open && !langMenu.contains(e.target)) langMenu.open = false; });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !langMenu.open) return;
    langMenu.open = false;
    $('summary', langMenu).focus();
  });
}

// 出現（main.js と同じしくみ。見えたら .in を付けて enter を投げる）
$$('.s-copy, .s-vis > *, .p-end > *').forEach((el) => el.setAttribute('data-reveal', ''));
const io = new IntersectionObserver((entries) => {
  entries.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add('in');
    io.unobserve(e.target);
    e.target.dispatchEvent(new CustomEvent('enter'));
  });
}, { threshold: 0.3 });
$$('[data-reveal]').forEach((el) => io.observe(el));

// 任せる: 使用量が満ちてから決まる（トップと同じ動き）
const deleg = $('.v-deleg');
deleg.addEventListener('enter', async () => {
  await wait(reduce ? 0 : 1400);
  deleg.classList.add('is-decided');
});

// カルーセル。自動では送らず、矢印・下の名前・横のスワイプで送る
function initCar(root) {
  const track = $('.car-track', root);
  const slides = [...track.children];
  const tabs = $$('.car-tab', root);
  const prev = $('.car-btn.prev', root), next = $('.car-btn.next', root);
  const live = $('.sr', root);
  let cur = -1;
  const left = (i) => slides[i].offsetLeft - slides[0].offsetLeft;
  const paint = (i, say) => {
    if (i === cur) return;
    cur = i;
    tabs.forEach((t, k) => t.setAttribute('aria-current', String(k === i)));
    if (prev) prev.disabled = i === 0;
    if (next) next.disabled = i === slides.length - 1;
    if (say) live.textContent = slides[i].getAttribute('aria-label');
  };
  const go = (i, smooth = true) => {
    i = Math.max(0, Math.min(slides.length - 1, i));
    track.scrollTo({ left: left(i), behavior: smooth ? 'smooth' : 'instant' });
    paint(i, smooth);
  };
  let raf = 0;
  track.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const max = track.scrollWidth - track.clientWidth;
      let best = 0;
      if (track.scrollLeft >= max - 2) best = slides.length - 1;
      else slides.forEach((_, k) => { if (Math.abs(left(k) - track.scrollLeft) < Math.abs(left(best) - track.scrollLeft)) best = k; });
      paint(best, false);
    });
  }, { passive: true });
  $$('.car-btn', root).forEach((b) => b.addEventListener('click', () => go(cur + Number(b.dataset.dir))));
  tabs.forEach((t) => {
    t.addEventListener('click', () => go(Number(t.dataset.go)));
    t.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      go(cur + d);
      tabs[cur].focus();
    });
  });
  paint(0, false);
  // /plus/#<slide id> で開いたとき、そのスライドへ送る
  const at = slides.findIndex((s) => s.id && s.id === location.hash.slice(1));
  if (at > 0) go(at, false);
}
const car = $('.car');
if (car) initCar(car);
