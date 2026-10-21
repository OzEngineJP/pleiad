// 殻のホスト一覧（mobile/www/app.js）を DOM とネイティブの代役で動かし、読み直し（refresh）で一覧と上の 1 行が出ることを見る
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const name = 'mobile-host-list';
export const title = '殻のホスト一覧: 読み直しで一覧と上の 1 行（届かない・中継が無い）が出る（DOM とネイティブの代役）';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE = fs.readFileSync(path.join(ROOT, 'mobile/www/app.js'), 'utf8');

function element(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), hidden: false, textContent: '', className: '', innerHTML: '', href: '', value: '',
    children: [], style: {}, dataset: {}, attrs: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute(k, v) { el.attrs[k] = v; },
    getAttribute: k => el.attrs[k] ?? null,
    append(...nodes) { el.children.push(...nodes); },
    replaceChildren(...nodes) { el.children = [...nodes]; },
    addEventListener() {}, removeEventListener() {}, remove() {}, focus() {}, select() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
  return el;
}

async function run(list) {
  const nodes = new Map();
  const toasts = [];
  const document = {
    hidden: false,
    documentElement: element('html'),
    body: element('body'),
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement: element,
    createTextNode: text => ({ textContent: text }),
    addEventListener() {}, querySelectorAll: () => [],
  };
  const Remote = {
    list: async () => list,
    addListener() {}, info: async () => ({ encrypted: true }), takePairLink: async () => ({ payload: null }),
    notifyState: async () => ({}),
  };
  const window = {
    shellI18n: { t: k => k, apply() {}, ago: () => '' },
    Capacitor: { Plugins: { PleiadRemote: Remote } },
    scrollY: 0, addEventListener() {},
  };
  const timers = [];
  vm.runInNewContext(CODE, {
    window, document, console, Date, Map, Promise,
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; }, clearTimeout() {},
  });
  // refresh().then(takeLink) が終わるまで回す
  for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r));
  const toast = nodes.get('toast');
  if (toast && !toast.hidden && toast.textContent) toasts.push(toast.textContent);
  return { hosts: nodes.get('hosts'), banner: nodes.get('hostBanner'), toasts };
}

export default async function (t) {
  const own = { hostId: 'h1', hostName: 'desk', via: 'own', state: 'closed' };
  const plus = { hostId: 'h2', hostName: 'laptop', via: 'plus', state: 'connected', online: true };

  let r = await run({ hosts: [own, plus], plusError: null });
  t.ok('読み直しで失敗の札を出さない', r.toasts.length === 0, r.toasts.join(' / '));
  t.ok('読み直しで 2 台が一覧に出る', r.hosts?.children.length === 2 && r.hosts.hidden === false, String(r.hosts?.children.length));
  t.ok('失敗が無ければ上の 1 行は隠れる', r.banner?.hidden === true && r.banner.textContent === '');

  r = await run({ hosts: [plus], plusError: 'no-relay' });
  t.ok('中継が無いとき: 上の 1 行に出て、一覧も出る', r.banner?.hidden === false && r.banner.textContent === 'plus.noRelay' && r.hosts?.children.length === 1 && r.toasts.length === 0, r.toasts.join(' / '));

  r = await run({ hosts: [], plusError: 'offline' });
  t.ok('届かないとき: 上の 1 行に出る', r.banner?.hidden === false && r.banner.textContent === 'plus.unreachable' && r.toasts.length === 0, r.toasts.join(' / '));
}
