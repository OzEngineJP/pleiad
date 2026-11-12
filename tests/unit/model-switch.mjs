// 安全装置によるモデルの切り替え（承認済み 2026-11-13。docs/design-system.md「モデルの切り替え」）:
// 行の描画（web/model-switch.mjs: 初回・2 回目以降・止まった・ボタンの出し分け）、中立の出来事の契約（modelSwitch）、
// 走っているターンを開くときの扱い（live-snapshot: 出来事のまま再生に回す）、fake の台本（出来事と履歴）
import { modelSwitchNode } from '../../web/model-switch.mjs';
import { checkBackendEvent } from '../../core/backends/contract.mjs';
import { splitLive } from '../../web/stream-messages.mjs';
import { liveSnapshot } from '../../core/live-snapshot.mjs';
import { backend as fake } from '../../core/backends/fake.mjs';

export const name = 'model-switch';
export const title = '安全装置のモデルの切り替え: 行の描画・出来事の契約・走っているターンを開く・fake の台本';

// 軽い DOM（tests/lib/dom-stub.mjs）は単純なセレクタ（.クラス・タグ）だけで、click は onclick に流れ、innerHTML は textContent に出ない。必要な分をここで補う
const text = (n) => (n ? n.shown ?? n.textContent ?? '' : '');
const all = (n, pred, out = []) => { for (const c of n.children ?? []) { if (pred(c)) out.push(c); all(c, pred, out); } return out; };
const act = (n, name) => all(n, (c) => c.dataset?.act === name)[0] ?? null;
const click = (n) => n.dispatchEvent({ type: 'click' });
const flat = (n) => text(n).replace(/\s+/g, ' ');
const isOpen = (n) => 'open' in n.attrs;
const nameOf = (id) => ({ 'claude-fable-5-2': 'Fable 5.2', 'claude-opus-4-8': 'Opus 4.8' })[id] ?? id;
const base = { phase: 'switched', from: 'claude-fable-5-2', to: 'claude-opus-4-8', notice: 'Fable 5.2 の応答が止まりました。' };

export default async function (t) {
  // ---- 描画
  {
    const first = modelSwitchNode({ ...base, count: 1 }, { name: nameOf, onUse: () => {}, at: '12:34' });
    const summary = first.querySelector('summary');
    t.ok('初回: 弱い字の 1 行「Fable 5.2 の応答が安全装置で止まり、Opus 4.8 に切り替わりました」と時刻', flat(summary).includes('Fable 5.2 の応答が安全装置で止まり、 Opus 4.8 に切り替わりました') && text(summary).includes('12:34'), text(summary));
    t.ok('初回: 閉じていて、開くと通知の原文が読める', !isOpen(first.querySelector('details')) && text(first.querySelector('.sys-body')).includes(base.notice));
    t.ok('初回: 「次のターンから Opus 4.8 を使う」を行の下（開いた中ではなく外）に出す',
      text(act(first, 'use')) === '次のターンから Opus 4.8 を使う' && !first.querySelector('details').querySelector('.sw-acts') && Boolean(first.querySelector('.sw-acts')) && !first.querySelector('.in-fold'));
    t.ok('初回: 使った後の「使います」と［取り消す］は最初は隠れている', first.querySelector('.done').hidden && act(first, 'undo').hidden);

    const later = modelSwitchNode({ ...base, count: 2 }, { name: nameOf, onUse: () => {} });
    t.ok('2 回目以降: 「安全装置で Opus 4.8 に切り替わりました · この会話で 2 回目」の短い 1 行', text(later.querySelector('summary')).includes('安全装置で') && text(later.querySelector('summary')).includes('この会話で 2 回目')
      && !text(later.querySelector('summary')).includes('Fable'), text(later.querySelector('summary')));
    t.ok('2 回目以降: ボタンは開いた中に入る', Boolean(later.querySelector('details').querySelector('.in-fold') && act(later.querySelector('details'), 'use')));

    const calls = [];
    const row = modelSwitchNode({ ...base, count: 1 }, { name: nameOf, onUse: (on) => calls.push(on) });
    click(act(row, 'use'));
    t.ok('［使う］で onUse(true)・「使います」と［取り消す］が出て、［使う］は隠れる', calls.join() === 'true' && act(row, 'use').hidden && !row.querySelector('.done').hidden && !act(row, 'undo').hidden);
    click(act(row, 'undo'));
    t.ok('［取り消す］で onUse(false)・元に戻る', calls.join() === 'true,false' && !act(row, 'use').hidden && row.querySelector('.done').hidden);

    t.ok('切り替え先を選べない（onUse が無い）ときはボタンを出さない', !modelSwitchNode({ ...base, count: 1 }, { name: nameOf }).querySelector('.sw-acts'));
    t.ok('原文が無ければ本文は空', text(modelSwitchNode({ ...base, notice: undefined, count: 1 }, { name: nameOf }).querySelector('.sys-body')) === '');

    let retried = 0;
    const stopped = modelSwitchNode({ phase: 'stopped', from: 'claude-fable-5-2' }, { name: nameOf, onRetry: () => { retried++; } });
    t.ok('止まった行: 「✕ 応答が止まりました Fable 5.2 の安全装置が止め…」の失敗の行で、折りたたみを持たない', stopped.classList.contains('turn-failed') && text(stopped).includes('応答が止まりました')
      && text(stopped).includes('Fable 5.2') && !stopped.querySelector('details'), text(stopped));
    click(act(stopped, 'retry'));
    t.ok('止まった行: ［モデルを選んで送り直す］が onRetry を呼ぶ', retried === 1 && text(act(stopped, 'retry')) === 'モデルを選んで送り直す');
    t.ok('止まった行: onRetry が無ければボタンを出さない', !act(modelSwitchNode({ phase: 'stopped', from: 'x' }, { name: nameOf }), 'retry'));
  }

  // ---- 出来事の契約
  t.ok('契約: switched（from・to）と stopped（from だけ）を通す',
    checkBackendEvent({ type: 'modelSwitch', phase: 'switched', from: 'a', to: 'b' }) === null && checkBackendEvent({ type: 'modelSwitch', phase: 'stopped', from: 'a' }) === null);
  t.ok('契約: phase が違う・from が無いものは落とす',
    /phase/.test(checkBackendEvent({ type: 'modelSwitch', phase: 'maybe', from: 'a' })) && /from/.test(checkBackendEvent({ type: 'modelSwitch', phase: 'switched', to: 'b' })));

  // ---- 走っているターンを開く（live-snapshot）
  {
    const events = [
      { type: 'text.delta', text: '調べ' }, { type: 'text.end', uuid: 'u1' },
      { type: 'modelSwitch', phase: 'switched', from: 'claude-fable-5-2', to: 'claude-opus-4-8' },
      { type: 'text.delta', text: '続き' }, { type: 'tool.start', id: 'c1', name: 'Bash', input: {} },
    ].map((e, i) => ({ sessionId: 's', streamSeq: i + 1, ...e }));
    const snap = liveSnapshot({ messages: [], events });
    const kept = snap.events.filter((e) => e.type === 'modelSwitch');
    t.ok('走っているターンの切り替えは、畳んだ発言に混ぜず出来事のまま再生に回す（1 回だけ）', kept.length === 1 && !snap.messages.some((m) => m.kind === 'modelSwitch'));
    t.ok('畳む位置より前の切り替えも失わない', splitLive(events.slice(0, 5)).events.filter((e) => e.type === 'modelSwitch').length === 1);
    const again = liveSnapshot({ messages: [], events });
    t.ok('同じ出来事から作り直しても数は増えない（再接続・開き直し）', again.events.filter((e) => e.type === 'modelSwitch').length === 1);
  }

  // ---- fake の台本（fake の待ちは unref のタイマーなので、走っている間はこちらで事象ループを保つ）
  {
    const keep = setInterval(() => {}, 50);
    const run = async (prompt, sessionId) => {
      const emitted = [];
      await fake.runTurn({ prompt, sessionId, emit: (e) => emitted.push(e), onPromptDelivered: () => {}, signal: { signal: new AbortController().signal }, control: {} });
      return emitted;
    };
    const ok = await run('switch 一回目', 'ms-1');
    const sw = ok.find((e) => e.type === 'modelSwitch');
    t.ok('"switch …": switched（Fable 5.2 → Opus 4.8・原文つき）を出し、いつもの返答が続く', sw?.phase === 'switched' && sw.from === 'claude-fable-5-2' && sw.to === 'claude-opus-4-8' && Boolean(sw.notice)
      && ok.indexOf(sw) < ok.findIndex((e) => e.type === 'text.delta') && ok.at(-1).type === 'turnResult');
    const history = await fake.getMessages('ms-1');
    const kinds = history.map((m) => m.kind ?? m.role);
    t.ok('履歴にも切り替えの行が残り、続く返答に switchedModel が付く', kinds.join() === 'user,modelSwitch,assistant' && history[1].to === 'claude-opus-4-8' && history[2].switchedModel === 'claude-opus-4-8', kinds.join());
    await run('switch 二回目', 'ms-1');
    t.ok('2 回目も行が増える（行は 2 つ）', (await fake.getMessages('ms-1')).filter((m) => m.kind === 'modelSwitch').length === 2);

    const stop = await run('switch-stop だめ', 'ms-2');
    const st = stop.find((e) => e.type === 'modelSwitch');
    t.ok('"switch-stop …": stopped（from だけ）を出し、本文は返さずターンが ok で終わる', st?.phase === 'stopped' && !st.to && !stop.some((e) => e.type === 'text.delta') && stop.at(-1).type === 'turnResult' && stop.at(-1).outcome === 'ok');
    t.ok('止まった方は履歴に行を作らない', !(await fake.getMessages('ms-2')).some((m) => m.kind === 'modelSwitch'));
    const plain = await run('こんにちは', 'ms-3');
    t.ok('ふつうの発言では切り替えを出さない', !plain.some((e) => e.type === 'modelSwitch'));
    clearInterval(keep);
  }
}
