// 記憶の自動整理の状態の決まり（web/memory-model.mjs。DOM に触れない）:
// 実効の入切・確定の未ログイン・受動の未確認と、設定 › 記憶 › bot の状態の優先順・bot ページの導線の短い状態。
import { learnEnabledOf, authOutOf, authUnconfirmedOf, learnPanelView, learnRouteView, coreFitView } from '../../web/memory-model.mjs';

export const name = 'memory-model';
export const title = '記憶の自動整理: 実効の入切・認証の確かさ・状態の優先順（停止・失敗は未確認で隠さない）';

export default async function (t) {
  // ---- 実効の入切（learnEnabledOf）
  t.ok('status.enabled があればそれが実効値', learnEnabledOf({ enabled: true }, {}) === true && learnEnabledOf({ enabled: false }, { memoryAutoLearn: true }) === false);
  t.ok('status.enabled が無くて memoryAutoLearn も無いなら OFF（paused の逆にはしない）', learnEnabledOf({}, {}) === false && learnEnabledOf({}, { memoryLearnPaused: false }) === false);
  t.ok('memoryAutoLearn が true でも paused が残っていれば OFF', learnEnabledOf({}, { memoryAutoLearn: true, memoryLearnPaused: true }) === false);
  t.ok('memoryAutoLearn が true で止めていなければ ON', learnEnabledOf({}, { memoryAutoLearn: true }) === true && learnEnabledOf({}, { memoryAutoLearn: true, memoryLearnPaused: false }) === true);
  t.ok('様子も設定も無ければ OFF', learnEnabledOf(null, null) === false && learnEnabledOf(undefined, undefined) === false);

  // ---- 認証の確かさ
  const out = { supported: true, installed: true, loggedIn: false };
  const unconf = { supported: true, installed: true, loggedIn: false, unconfirmed: true };
  const pend = { supported: true, installed: true, loggedIn: false, pending: true };
  const inside = { supported: true, installed: true, loggedIn: true };
  t.ok('確定の未ログインだけ authOut', authOutOf(out) === true);
  t.ok('受動の未確認は未ログインにしない', authOutOf(unconf) === false && authUnconfirmedOf(unconf) === true);
  t.ok('確認中（pending）は未ログインでも未確認でもない', authOutOf(pend) === false && authUnconfirmedOf(pend) === false);
  t.ok('ログイン済み・非対応・未インストールは未ログインでも未確認でもない',
    authOutOf(inside) === false && authOutOf({ supported: false }) === false && authOutOf({ supported: true, installed: false, loggedIn: false }) === false && authUnconfirmedOf(inside) === false);

  // ---- パネルの状態の優先順
  const opts = { enabled: true, authOut: false, unconfirmed: false };
  t.ok('オフは何より先（走っていても未確認でも）', learnPanelView({ running: true }, { ...opts, enabled: false, unconfirmed: true }).mode === 'off');
  t.ok('実行中', learnPanelView({ running: true }, { ...opts, unconfirmed: true }).mode === 'running');
  t.ok('止まっている + 受動の未確認: 停止が主状態で、未確認は注記。［接続を確認］と［もう一度］は両方残る', (() => {
    const v = learnPanelView({ halted: true }, { ...opts, unconfirmed: true });
    return v.mode === 'halted' && v.warn && v.authNote === 'unconfirmed' && v.actions.join() === 'check,retry';
  })());
  t.ok('止まっている + 確定の未ログイン: ［ログイン］と［もう一度］', (() => {
    const v = learnPanelView({ halted: true }, { ...opts, authOut: true });
    return v.mode === 'halted' && v.authNote === 'authWait' && v.actions.join() === 'login,retry';
  })());
  t.ok('失敗 + 受動の未確認: 失敗が主状態で、注記と［接続を確認］［もう一度］', (() => {
    const v = learnPanelView({ failure: { message: 'down' } }, { ...opts, unconfirmed: true });
    return v.mode === 'failed' && v.authNote === 'unconfirmed' && v.actions.join() === 'check,retry';
  })());
  t.ok('失敗 + 確定の未ログイン: ［ログイン］と［もう一度］', (() => {
    const v = learnPanelView({ failure: { message: 'down' } }, { ...opts, authOut: true });
    return v.mode === 'failed' && v.actions.join() === 'login,retry';
  })());
  t.ok('未確認は本体の状態になれる（何も無ければ unconfirmed。［接続を確認］と［今すぐ整理］）', (() => {
    const v = learnPanelView({ nextAt: 1 }, { ...opts, unconfirmed: true });
    return v.mode === 'unconfirmed' && v.actions.join() === 'check,now';
  })());
  t.ok('確定の未ログインは待ち（［ログイン］だけ）', (() => {
    const v = learnPanelView({ nextAt: 1 }, { ...opts, authOut: true });
    return v.mode === 'authWait' && v.warn && v.actions.join() === 'login';
  })());
  t.ok('全部通れば待ち（［今すぐ整理］）', learnPanelView({ nextAt: 1 }, opts).mode === 'waiting' && learnPanelView({ nextAt: 1 }, opts).actions.join() === 'now');
  t.ok('停止・失敗だけなら注記は無く［もう一度］だけ', (() => {
    const v = learnPanelView({ halted: true }, opts);
    return v.mode === 'halted' && v.authNote == null && v.actions.join() === 'retry';
  })());

  // ---- bot ページの導線の短い状態
  t.ok('様子が読めなくても導線は出す（open）', learnRouteView(null, { enabled: true }).key === 'open');
  t.ok('オフ', learnRouteView({ nextAt: 1 }, { enabled: false }).key === 'off');
  t.ok('実行中', learnRouteView({ running: true }, { enabled: true }).key === 'running');
  t.ok('停止も失敗も「失敗」で目立たせる', learnRouteView({ halted: true }, { enabled: true }).key === 'failed' && learnRouteView({ failure: {} }, { enabled: true }).key === 'failed');
  t.ok('次の予定の時刻を持つ', (() => {
    const at = new Date(2030, 0, 2, 3, 4).getTime();
    const v = learnRouteView({ nextAt: at }, { enabled: true });
    return v.key === 'next' && typeof v.params.at === 'string' && v.params.at.length > 0;
  })());

  // ---- 会話の始まりに入りきらない記憶（memory.coreFit。設定 › 記憶の 1 行）
  t.ok('入りきらない記憶が無ければ行を出さない（null）', coreFitView({ omitted: { untiered: 0, always: 0, workspace: 0 }, total: 0 }) === null && coreFitView(null) === null && coreFitView({}) === null && coreFitView({ omitted: 'x' }) === null);
  t.ok('段の順（段なし・いつも・この作業場所で）で、0 の段は出さない', (() => {
    const v = coreFitView({ omitted: { workspace: 2, always: 0, untiered: 5 }, total: 7 });
    return v.parts.map((p) => `${p.tier}:${p.n}`).join() === 'untiered:5,workspace:2' && v.total === 7;
  })());
  t.ok('数でない値・負の値・小数は 0 か整数に直す（形が壊れても落ちない）', (() => {
    const v = coreFitView({ omitted: { untiered: 'x', always: -3, workspace: 2.9 } });
    return v.parts.length === 1 && v.parts[0].tier === 'workspace' && v.parts[0].n === 2 && v.total === 2;
  })());
}
