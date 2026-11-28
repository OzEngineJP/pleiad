function rgb(value) {
  if (value === 'transparent') return [0, 0, 0, 0];
  if (/^#[\da-f]{6}$/i.test(value)) {
    return [1, 3, 5].map(start => parseInt(value.slice(start, start + 2), 16));
  }
  return value.match(/^rgba?\((.*)\)$/)?.[1].split(',').map(Number);
}

export function blendTitleBarColor(base, backdrops) {
  const channels = rgb(base);
  if (!channels) return base;
  const result = backdrops.reduce((color, [r, g, b, opacity = 1]) =>
    [r, g, b].map((channel, index) => channel * opacity + color[index] * (1 - opacity)), channels);
  return '#' + result.slice(0, 3).map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('');
}

export function watchModalTitleBar({ document, window, bar, send }) {
  const root = document.documentElement;
  root.setAttribute('data-modal-title-bar', '');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const dialogs = new Set();
  const fading = new Set();
  const pending = new Map();
  const installed = new WeakSet();
  const removed = new window.MutationObserver(() => {
    for (const dialog of dialogs) {
      if (dialog.isConnected) continue;
      dialogs.delete(dialog);
      fading.delete(dialog);
      pending.get(dialog)?.abort();
      refresh();
    }
    if (!dialogs.size) removed.disconnect();
  });
  let frame = 0;
  let until = 0;
  let sent = '';

  // Read the browser's interpolated colors, including the backdrop's current
  // alpha. The Windows caption and the renderer then use the same frame.
  const colors = document.createElement('span');
  colors.setAttribute('aria-hidden', 'true');
  colors.className = 'modal-title-colors';
  bar.append(colors);
  const duration = () => parseFloat(window.getComputedStyle(root).getPropertyValue('--dur')) || 0;
  function update(now) {
    frame = 0;
    for (const dialog of dialogs) {
      if (dialog.matches(':modal')) continue;
      dialogs.delete(dialog);
      fading.delete(dialog);
    }
    if (!dialogs.size) removed.disconnect();
    colors.classList.toggle('animate', dialogs.size > 0);
    const backdrops = [...dialogs].map(dialog => rgb(window.getComputedStyle(dialog, '::backdrop').backgroundColor)).filter(Boolean);
    const css = window.getComputedStyle(colors);
    const result = {
      color: blendTitleBarColor(css.backgroundColor, backdrops),
      symbolColor: blendTitleBarColor(css.color, backdrops),
    };
    const key = JSON.stringify(result);
    if (key !== sent) { sent = key; send(result); }
    if (now < until || fading.size) frame = window.requestAnimationFrame(update);
  }
  function refresh() {
    until = window.performance.now() + duration() + 34;
    if (!frame) frame = window.requestAnimationFrame(update);
  }

  function prepare(dialog) {
    if (installed.has(dialog)) return;
    installed.add(dialog);
    const close = dialog.close.bind(dialog);
    const showModal = dialog.showModal.bind(dialog);
    dialog.showModal = () => {
      pending.get(dialog)?.abort();
      showModal();
    };
    dialog.close = (...args) => {
      if (!dialog.matches(':modal')) return close(...args);
      if (pending.has(dialog)) return;
      const ms = duration();
      if (!ms) return close(...args);
      dialog.toggleAttribute('data-veil-closing', true);
      const clear = () => {
        window.clearTimeout(timer);
        dialog.removeEventListener('transitionend', ended);
        pending.delete(dialog);
        dialog.removeAttribute('data-veil-closing');
        refresh();
      };
      const finish = () => { close(...args); clear(); };
      const ended = event => {
        if (event.target === dialog && event.pseudoElement === '::backdrop' && event.propertyName === 'background-color') finish();
      };
      dialog.addEventListener('transitionend', ended);
      const timer = window.setTimeout(finish, ms + 34);
      pending.set(dialog, { abort: clear, finish });
      refresh();
    };
  }

  document.addEventListener('beforetoggle', event => {
    const dialog = event.target;
    if (dialog.localName !== 'dialog' || event.defaultPrevented) return;
    if (event.newState === 'open') {
      prepare(dialog);
      dialogs.add(dialog);
      if (dialogs.size === 1) removed.observe(document.body, { childList: true, subtree: true });
    } else {
      dialogs.delete(dialog);
      fading.delete(dialog);
      if (!dialogs.size) removed.disconnect();
    }
    refresh();
  }, true);
  function backdropTransition(event) {
    if (event.pseudoElement !== '::backdrop' || event.propertyName !== 'background-color') return;
    if (event.type === 'transitionrun' && dialogs.has(event.target)) fading.add(event.target);
    else fading.delete(event.target);
    refresh();
  }
  for (const type of ['transitionrun', 'transitionend', 'transitioncancel']) {
    document.addEventListener(type, backdropTransition, true);
  }
  document.addEventListener('cancel', event => {
    const dialog = event.target;
    if (!dialogs.has(dialog)) return;
    // Run after the dialog's own cancel handler. Some dialogs veto Escape.
    dialog.addEventListener('cancel', cancel => {
      if (cancel.defaultPrevented) return;
      cancel.preventDefault();
      dialog.close();
    }, { once: true });
  }, true);
  document.addEventListener('submit', event => {
    const form = event.target;
    const dialog = form.closest('dialog:modal');
    const method = event.submitter?.getAttribute('formmethod') ?? form.method;
    if (event.defaultPrevented || !dialogs.has(dialog) || method.toLowerCase() !== 'dialog') return;
    event.preventDefault();
    dialog.close(event.submitter?.value ?? '');
  });
  const watch = new window.MutationObserver(refresh);
  watch.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });
  watch.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', refresh);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh);
  motion.addEventListener('change', () => {
    if (motion.matches) for (const { finish } of pending.values()) finish();
    refresh();
  });
  refresh();
}
