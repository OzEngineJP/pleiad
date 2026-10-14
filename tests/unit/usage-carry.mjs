import assert from 'node:assert/strict';
import { N } from '../lib/dom-stub.mjs';
import { carryQuota, createUsageSource, setupUsage } from '../../web/usage.mjs';
import { chipState, quotaOf } from '../../web/header-usage.mjs';

export const name = 'usage-carry';
export const title = '使用量: 取れなかった行は前回の枠を引き継ぐ・設定の「使用量」は取り直しの間も前の表示を残す';
export default async function(t) {
  const future = new Date(Date.now() + 3600_000).toISOString();
  const win = (label, used) => ({ label, usedPercent: used, remainingPercent: 100 - used, resetsAt: future });
  const week = win('週次（7日間）', 48), five = win('5時間', 20);
  const first = { plan: 'max', windows: [], accounts: [
    { label: 'ログイン中のアカウント', plan: 'max', windows: [week, five], message: null },
    { label: '仕事', accountId: 'work', plan: 'pro', windows: [five], message: null },
    { label: '個人', accountId: 'home', windows: [], needsUsageLogin: true, message: '認可してください' },
  ] };

  // ログイン中の行が失敗（windows: []・message だけ）、登録した行は reauth、未認可の行は今までどおり
  const failed = { plan: null, windows: [], accounts: [
    { label: 'ログイン中のアカウント', windows: [], message: '取得に失敗: タイムアウト' },
    { label: '仕事', accountId: 'work', windows: [], reauth: true, message: '認可をやり直してください' },
    { label: '個人', accountId: 'home', windows: [], needsUsageLogin: true, message: '認可してください' },
  ] };
  const carried = carryQuota(failed, first);
  assert.deepEqual(carried.accounts[0].windows, [week, five], 'ログイン中の行の前回の枠を出す');
  assert.equal(carried.accounts[0].message, '取得に失敗: タイムアウト', '失敗の文言は残す');
  assert.equal(carried.accounts[0].plan, 'max');
  assert.deepEqual(carried.accounts[1].windows, [five]);
  assert.equal(carried.accounts[1].reauth, true, 'reauth の印と文言（やり直しのボタンの元）は残す');
  assert.equal(carried.accounts[1].message, '認可をやり直してください');
  assert.deepEqual(carried.accounts[2].windows, [], '使用量の認可が済んでいない行は引き継がない');
  assert.equal(carried.accounts[2].needsUsageLogin, true);
  assert.equal(carried.accounts[0].dim, undefined, '薄くしない');
  // 札: ログイン中のアカウントを使う会話は枠を出し続ける（今までは chipState が null で札が消えた）
  assert.equal(chipState(quotaOf(failed, '')), null);
  assert.equal(chipState(quotaOf(carried, '')).kind, 'value');
  assert.equal(chipState(quotaOf(carried, '')).used, 48);
  assert.equal(chipState(quotaOf(carried, 'work')).kind, 'value');
  assert.equal(chipState(quotaOf(carried, 'home')).kind, 'auth');
  t.ok('失敗した行（ログイン中・reauth）は前回の枠を引き継ぎ、未認可の行は引き継がない', true);

  // 取れた行は新しい値のまま。行は accountId で突き合わせる（並びが変わっても取り違えない）
  const fresh = { windows: [], accounts: [
    { label: '仕事', accountId: 'work', windows: [win('5時間', 70)], message: null },
    { label: 'ログイン中のアカウント', windows: [], message: 'x' },
  ] };
  const mixed = carryQuota(fresh, first);
  assert.equal(mixed.accounts[0].windows[0].usedPercent, 70);
  assert.deepEqual(mixed.accounts[1].windows, [week, five]);
  // 前回に無い行・前回も空の行は空のまま。前回が無ければ素通し
  assert.deepEqual(carryQuota({ windows: [], accounts: [{ label: '新規', accountId: 'new', windows: [] }] }, first).accounts[0].windows, []);
  assert.equal(carryQuota(failed, null), failed);
  assert.equal(carryQuota(null, first), null);
  // アカウントを登録していないエージェント（Codex など）: 枠が空で返ったら前回の枠。登録の有無が変わったときは引き継がない
  const codex = { plan: 'plus', windows: [win('5時間', 30)] };
  assert.deepEqual(carryQuota({ plan: null, windows: [] }, codex).windows, codex.windows);
  assert.equal(carryQuota({ plan: null, windows: [] }, codex).plan, 'plus');
  assert.deepEqual(carryQuota({ windows: [], needsUsageLogin: true }, codex).windows, []);
  assert.deepEqual(carryQuota({ windows: [] }, first).windows, []);
  t.ok('accountId で突き合わせ、取れた行は新しい値のまま。登録の無いエージェントも同じ', true);

  // 共通の口（createUsageSource）で引き継ぎ、札・一覧・設定の「使用量」へ同じ値を配る。失敗が続いても枠は残る
  const replies = [{ label: 'Claude', quota: first, local: {} }, { label: 'Claude', quota: failed, local: {} }, { label: 'Claude', quota: failed, local: {} }];
  const source = createUsageSource(async () => replies.shift());
  const heard = [];
  source.onResult((backend, result) => heard.push(result));
  await source.load('claude');
  const second = await source.load('claude');
  assert.deepEqual(second.quota.accounts[0].windows, [week, five]);
  assert.equal((await source.load('claude')).quota.accounts[1].windows.length, 1, '失敗が続いても前回の枠のまま');
  assert.deepEqual(heard[1].quota.accounts[0].windows, [week, five], 'onResult にも引き継いだ値を配る');
  assert.equal(failed.accounts[0].windows.length, 0, '受け取った結果は書き換えない');
  t.ok('createUsageSource が引き継ぎ、onResult と load の両方に同じ値を返す', true);

  // 設定の「使用量」: 取り直しの間も前の表示を残し、取れてから差し替える
  const els = new Map();
  const $ = id => els.get(id) ?? (els.set(id, new N('div')), els.get(id));
  $('usagePanel').hidden = false;
  const handlers = {};
  const savedWindow = globalThis.window;
  globalThis.window = { addEventListener: (type, fn) => { handlers[type] = fn; } };
  try {
    let release, calls = 0, mode = 'ok';
    const result = used => ({ label: 'Codex', quota: { plan: 'plus', windows: [win('5時間', used)], checkedAt: new Date().toISOString() },
      local: { error: 'なし' } });
    const cmd = () => { calls++; return new Promise((resolve, reject) => { release = () => mode === 'ok' ? resolve(result(40 + calls)) : reject(new Error('down')); }); };
    setupUsage({ $, cmd, getBackends: () => [{ id: 'codex', label: 'Codex' }], page: () => {}, isOpen: () => true });
    const tick = () => new Promise(resolve => setImmediate(resolve));
    const root = $('usageCards');
    const text = () => root.shown;

    $('usageTab').onclick(); await tick();
    assert.match(text(), /取得中/, '初回だけ「取得中…」');
    release(); await tick(); await tick();
    const card = root.children[0];
    assert.match(text(), /41/);
    assert.equal(root.querySelectorAll('.usage-window').length, 1);

    $('refreshUsage').onclick(); await tick();
    assert.equal(root.children[0], card, '同じカードのまま');
    assert.equal(root.querySelectorAll('.usage-window').length, 1, '取り直しの間も前の表示を残す');
    assert.doesNotMatch(text(), /取得中/);
    release(); await tick(); await tick();
    assert.match(text(), /42/, '取れたら差し替える');
    assert.equal(root.children.length, 1);

    mode = 'fail';
    $('refreshUsage').onclick(); await tick();
    release(); await tick(); await tick();
    assert.equal(root.querySelectorAll('.usage-window').length, 1, '取れなかったときも前の表示を残す');
    assert.match(text(), /42/);
    assert.equal($('refreshUsage').disabled, false);
    handlers.pagehide?.();
    t.ok('設定の「使用量」は取り直しの間も前の表示を残し、取れてから差し替える（失敗でも残す）', true);
  } finally { globalThis.window = savedWindow; if (savedWindow === undefined) delete globalThis.window; }
}
