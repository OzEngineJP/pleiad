// 毎晩の整理の状態の決まり（web/memory-model.mjs。DOM に触れない）:
// 実効の入切・確定の未ログイン・受動の未確認と、設定 › bot の状態の優先順・bot ページの導線の短い状態・「渡す場面が決まっていない記憶」の欄（毎晩の整理が少しずつ決める分）。
import { learnEnabledOf, authOutOf, authUnconfirmedOf, learnPanelView, learnRouteView, sortPanelView } from '../../web/memory-model.mjs';

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

  // ---- 渡す場面が決まっていない記憶（memory.sortStatus。設定 › bot の 2 つ目のかたまり。数・内訳だけで、始める・止める操作は無い）
  const sortOf = (over = {}) => ({ status: 'none', running: false, untiered: 0, nights: 0, perNight: 500, processed: 0, left: 0, failures: 0, changed: 0, unknown: 0,
    tiers: { always: 0, workspace: 0, archive: 0 }, startedAt: null, updatedAt: null, undone: null, ...over });
  t.ok('様子が読めなければ欄を出さない（null）', sortPanelView(null) === null && sortPanelView(undefined) === null && sortPanelView('x') === null);
  t.ok('決まっていない記憶があれば欄を出す。何晩で終わるか・1 晩の件数・件数は数のまま持つ。取り消すものは無い', (() => {
    const v = sortPanelView(sortOf({ untiered: 1440, nights: 3 }));
    return v.show === true && v.mode === 'none' && v.untiered === 1440 && v.nights === 3 && v.perNight === 500 && v.placed === 0 && v.undo === false;
  })());
  t.ok('決まっていない記憶も決めた分も無ければ欄を出さない', sortPanelView(sortOf()).show === false);
  t.ok('決めた分があれば、内訳を持ち［決めた分を取り消す］を出す（決まっていない記憶が 0 でも）', (() => {
    const v = sortPanelView(sortOf({ status: 'done', tiers: { always: 10, workspace: 36, archive: 4 } }));
    return v.show === true && v.mode === 'done' && v.placed === 50 && v.tiers.always === 10 && v.tiers.workspace === 36 && v.tiers.archive === 4 && v.undo === true;
  })());
  t.ok('走っている間は取り消せない（毎晩の整理の最中に外れる分と取り違えない）', (() => {
    const v = sortPanelView(sortOf({ status: 'going', running: true, untiered: 900, nights: 2, tiers: { always: 3, workspace: 0, archive: 0 } }));
    return v.mode === 'running' && v.undo === false && v.show === true;
  })());
  t.ok('毎晩続けている途中（going）は取り消せる', (() => {
    const v = sortPanelView(sortOf({ status: 'going', untiered: 900, nights: 2, tiers: { always: 3, workspace: 0, archive: 0 } }));
    return v.mode === 'going' && v.undo === true;
  })());
  t.ok('前の晩の失敗は failed（毎晩の整理の失敗にはしない）。決めた分があれば取り消せる', (() => {
    const v = sortPanelView(sortOf({ status: 'failed', untiered: 160, failures: 3, tiers: { always: 2, workspace: 0, archive: 0 } }));
    return v.mode === 'failed' && v.undo === true && v.untiered === 160;
  })());
  t.ok('取り消した後は、戻した数と残した数だけ出す。もう一度取り消すことはできない・決まっていない記憶が 0 でも記録は出す', (() => {
    const v = sortPanelView(sortOf({ status: 'undone', untiered: 0, tiers: { always: 0, workspace: 0, archive: 0 }, undone: { restored: 3, kept: 1 } }));
    return v.mode === 'undone' && v.undo === false && v.show === true && v.undone.restored === 3 && v.undone.kept === 1;
  })());
  t.ok('取り消した記録が無ければ undone は null（status だけ undone の壊れた形でも落ちない）', sortPanelView(sortOf({ status: 'undone' })).undone === null);
  t.ok('知らない状態・壊れた数は none・0 に直す（形が壊れても落ちない。本文のような文字列は持たない）', (() => {
    const v = sortPanelView({ status: 'weird', untiered: 'x', nights: -4, tiers: { always: -2, workspace: 'y' }, processed: 3.7, memoryText: '秘密の本文' });
    return v.mode === 'none' && v.untiered === 0 && v.nights === 0 && v.placed === 0 && v.show === false && !JSON.stringify(v).includes('秘密');
  })());
}
