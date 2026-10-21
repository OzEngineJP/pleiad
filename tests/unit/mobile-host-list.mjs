// 殻のホスト一覧（mobile/www/app.js）を DOM とネイティブの代役で動かし、読み直し（refresh）で一覧と上の 1 行が出ることを見る
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

export const name = 'mobile-host-list';
export const title = '殻のホスト一覧: 読み直しで一覧と上の 1 行（届かない・中継が無い）が出る・両方で組んだホストは 1 行で、開く経路を状態の行に出して渡す（DOM とネイティブの代役）';

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
    getBoundingClientRect: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  };
  return el;
}

async function run(list, calls = []) {
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
    open: async a => { calls.push(['open', a]); },
    rename: async a => { calls.push(['rename', a]); },
    remove: async a => { calls.push(['remove', a]); },
  };
  const window = {
    shellI18n: { t: k => k, apply() {}, ago: () => '' },
    Capacitor: { Plugins: { PleiadRemote: Remote } },
    scrollY: 0, innerWidth: 400, addEventListener() {},
    prompt: () => 'new name', confirm: () => true,
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
  return { hosts: nodes.get('hosts'), banner: nodes.get('hostBanner'), toasts, body: document.body };
}

// 行の部品: [開くボタン [名前, 状態の行 [点, 文字]], …ボタン]
const rowText = row => row.children[0].children[1].children[1].textContent;
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };
async function menu(r, row) {
  row.children[1].onclick({ stopPropagation() {} });
  return r.body.children.at(-1).children.map(b => b.textContent);
}
async function pick(r, label) {
  r.body.children.at(-1).children.find(b => b.textContent === label).onclick();
  await settle();
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

  // 自分の中継と Pleiad Plus の両方で組んだホスト（both）は 1 行。via はタップで開く経路（PC が Plus でオンラインなら Plus）
  const bothPlus = { hostId: 'h3', hostName: 'studio', via: 'plus', both: true, state: 'closed', online: true, lastConnectedAt: 1 };
  const bothOwn = { hostId: 'h4', hostName: 'office', via: 'own', both: true, state: 'connected', lastConnectedAt: 1 };
  const bothOwnClosed = { ...bothOwn, hostId: 'h5', hostName: 'den', state: 'closed' };
  let calls = [];
  r = await run({ hosts: [bothPlus, bothOwn, bothOwnClosed, plus, own], plusError: null }, calls);
  const rows = Object.fromEntries(r.hosts.children.map(row => [row.children[0].children[0].textContent, row]));
  t.ok('両方で組んだホストも 1 台 1 行', r.hosts.children.length === 5, String(r.hosts.children.length));
  t.ok('Plus で開く行: 「オンライン · Pleiad Plus」（使った日は出さない）', rowText(rows.studio) === 'plus.online · hosts.route.plus', rowText(rows.studio));
  t.ok('自分の中継で開く行: 「オンライン · 自分の中継サーバー」', rowText(rows.office) === 'state.connected · hosts.route.own', rowText(rows.office));
  t.ok('自分の中継でまだつないでいない行: 使った日だけ', rowText(rows.den) === 'hosts.lastUsed', rowText(rows.den));
  t.ok('片方だけのホストは経路を出さない', rowText(rows.laptop) === 'plus.online · hosts.lastUsed' || rowText(rows.laptop) === 'plus.online · hosts.neverUsed', rowText(rows.laptop));

  rows.studio.children[0].onclick(); await settle();
  rows.office.children[0].onclick(); await settle();
  t.ok('タップで行の経路を渡す', JSON.stringify(calls.filter(c => c[0] === 'open').map(c => c[1].via)) === '["plus","own"]', JSON.stringify(calls));

  calls.length = 0;
  t.ok('両方で組んだ行の操作に「削除」がある', (await menu(r, rows.studio)).includes('hosts.remove'));
  await pick(r, 'hosts.rename');
  t.ok('両方で組んだ行の名前は両方の記録に付ける（via: both）', calls[0]?.[0] === 'rename' && calls[0][1].via === 'both', JSON.stringify(calls));
  calls.length = 0;
  await menu(r, rows.studio);
  await pick(r, 'hosts.remove');
  t.ok('削除は自分の中継の組み合わせを消す', calls[0]?.[0] === 'remove' && calls[0][1].via === 'own', JSON.stringify(calls));
  t.ok('Plus だけの行には「削除」が無い', !(await menu(r, rows.laptop)).includes('hosts.remove'));
}
