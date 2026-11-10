// 更新の前の保存（web/client.mjs が setupUpdates へ渡す flush を、最小の DOM と偽の保存で流す）。
//   - 前に失敗した設定・モードの保存（拒否のまま残った約束）があっても、更新の保存は止まらない:
//     失敗の知らせは入力欄の上や会話に出て送信を止める役目。ここで止めると「再起動して更新」がその理由で進まなかった（0.42.5-beta.7 で修正）
//   - 走っている設定・モードの保存は終わるまで待つ
//   - 下書きの保存（saveDraft・persistDraft・draftWrites）が失敗したときは、書きかけを失うおそれがあるので更新を止める
import fs from 'node:fs/promises';
import vm from 'node:vm';

export const name = 'update-flush';
export const title = '更新の前の保存: 前に失敗した設定・モードの保存で止まらない・走っている保存は待つ・下書きの失敗は止める';

const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
const gate = () => { const g = {}; g.promise = new Promise((res, rej) => { g.resolve = res; g.reject = rej; }); return g; };
// 拒否のまま残った保存の約束（client.mjs の settingsWrite・modeWrite と同じ。失敗は別の受け手が知らせ済み）
const rejected = (message) => { const p = Promise.reject(new Error(message)); p.catch(() => {}); return p; };
const throws = async (promise) => { try { await promise; return null; } catch (e) { return e.message; } };

export default async function (t) {
  const source = (await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const anchor = source.indexOf('flush: async () => {');
  if (anchor < 0) throw new Error('client.mjs に更新の flush が無い');
  const end = source.indexOf('} });', anchor);
  if (end < 0) throw new Error('client.mjs の更新の flush の終わりが見つからない');
  const code = `const updateFlush = ${source.slice(anchor + 'flush: '.length, end + 1)};`;

  const els = new Map();
  const $ = (id) => { if (!els.has(id)) els.set(id, { value: '', textContent: '' }); return els.get(id); };
  const state = { current: 's1', loadingSession: null, drafts: new Map(), attached: [] };
  const draftsSaved = [];   // persistDraft が返した保存の約束（手で終わらせる）
  const context = vm.createContext({
    state, $, t: (k) => k, creatingSession: null,
    saveDraft: () => Promise.resolve(),
    settingsWrite: Promise.resolve(), modeWrite: Promise.resolve(), draftWrites: new Map(),
    persistDraft: (id, value) => { const g = gate(); draftsSaved.push({ id, value, ...g }); return g.promise; },
  });
  vm.runInContext(code, context);
  const flush = () => vm.runInContext('updateFlush()', context);

  // ---- 断る条件はそのまま（会話を作っている・開いている途中・保存先の無い下書き）
  context.creatingSession = Promise.resolve();
  t.ok('会話を作っている間は断る', (await throws(flush())) === 'app.update.loading');
  context.creatingSession = null; state.loadingSession = 's1';
  t.ok('会話を開いている途中も断る', (await throws(flush())) === 'app.update.loading');
  state.loadingSession = null; state.current = null; $('prompt').value = 'かきかけ';
  t.ok('保存先の会話が無い欄の下書きも断る', (await throws(flush())) === 'app.update.draftNoSession');
  state.current = 's1'; $('prompt').value = '';

  // ---- 前に失敗した設定・モードの保存は止めない（「選択したモデルは使用できません」で止まった 0.42.5-beta.2 の不具合）
  context.settingsWrite = rejected('選択したモデルは使用できません');
  context.modeWrite = rejected('モードを保存できませんでした');
  t.ok('前に失敗した設定・モードの保存が残っていても、更新の保存は進む', (await throws(flush())) === null);
  context.settingsWrite = Promise.resolve(); context.modeWrite = Promise.resolve();

  // ---- 走っている設定・モードの保存は終わるまで待つ
  const pendingSettings = gate(), pendingMode = gate();
  context.settingsWrite = pendingSettings.promise; context.modeWrite = pendingMode.promise;
  let done = false;
  const waiting = flush().then(() => { done = true; });
  await settle();
  t.ok('走っている設定の保存が終わるまでは戻らない', !done);
  pendingSettings.resolve({}); await settle();
  t.ok('モードの保存も待つ', !done);
  pendingMode.resolve({}); await waiting;
  t.ok('両方が終われば進む', done);

  // ---- 汚れた下書きは保存し直し、失敗は止める（書きかけを失うおそれ）
  state.drafts.set('d1', { text: 'かきかけ', attached: [], dirty: true });
  state.drafts.set('d2', { text: '保存済み', attached: [], dirty: false });
  state.drafts.set('', { text: '仮置き', dirty: true });   // 会話の無い下書きは保存しない
  const failingDraft = flush();
  await settle();
  t.ok('会話の汚れた下書きだけを保存し直す', draftsSaved.length === 1 && draftsSaved[0].id === 'd1', JSON.stringify(draftsSaved.map(d => d.id)));
  draftsSaved[0].reject(new Error('disk'));
  t.ok('下書きの保存に失敗したら更新を止める', (await throws(failingDraft)) === 'disk');
  draftsSaved.length = 0;
  const savingDraft = flush();
  await settle();
  draftsSaved[0].resolve({});
  t.ok('下書きが保存できれば進む', (await throws(savingDraft)) === null);
  state.drafts.clear(); draftsSaved.length = 0;

  // ---- 前に失敗した下書きの保存（draftWrites に残った拒否）も止める
  context.draftWrites.set('d2', rejected('disk'));
  t.ok('前の下書き保存の失敗が残っていても更新を止める', (await throws(flush())) === 'disk');
}
