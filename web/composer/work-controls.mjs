// 子の会話のモーダルの入力欄の設定チップ（モデルと effort・作業場所・承認モード）の値と口（ADR 0315 段 4）。
// メインの controls（web/client.mjs）と同じ部品（web/composer-controls.mjs の setupComposerControls）に渡す get / on を、
// 「いま詳細に出している子」の行から作る。子のエージェントは送る前から決まっているので切り替えず（backendSwitchable: false）、
// 値の読みは「予約中の選択 → 次のターンの予約 → 子の行」の順（メインの composerSelection と同じ）。変えると次のターンから効く。
// アカウントと互換の接続先もメインと同じ面に出す（server の reserveTurnSettings が会話ごとに受ける。次のターンから効く）。
import { effortsKeyOf } from '../composer-vocab.mjs';

/**
 * @param {object} h client.mjs が渡す持ち分
 * @param {(childId: string) => object|undefined} h.row 子の一覧の行（state.sessions）。まだ載っていなければ undefined
 * @param {(childId: string) => object|null} h.item いま詳細に出している子（モーダルの項目）。子が違えば null
 * @param {(row: object) => object|null} h.pending 書いている間の選択（pendingChoice）
 * @param {() => object[]} h.backends
 * @param {(id: string) => string} h.labelOf
 * @param {(backend: string, account: string, cwd: string) => { modes: object, models: object }|null} h.vocab 取ってある語彙（同期）
 * @param {(backend: string, account: string, cwd: string) => Promise<any>} h.loadVocab 語彙を取る
 * @param {{ ready: Function, fresh: Function, adopt: Function, efforts: object }} h.efforts 子用のエフォートの段の見張り
 * @param {(patch: object, childId: string) => Promise<any>|undefined} h.reserve 次のターンの設定を予約する（reserveSettings）
 * @param {(childId: string, mode: string) => Promise<any>} h.setMode
 * @param {(backend: string) => Promise<any>} h.loadChoices そのエージェントのアカウントと接続先の一覧を取る
 * @param {(backend: string, account: string, endpoint: string) => object[]|null} h.accounts アカウントの候補（出さないときは null）
 * @param {(backend: string, endpoint: string) => object|null} h.endpointView 接続先の値と口（出さないときは null）
 * @param {() => object[]} h.recent 最近使った作業場所
 * @param {(backend: string, account: string, cwd: string) => void} h.revalidate モデルの面を開いたとき、語彙を裏で取り直す
 * @param {(childId: string) => void} h.repaint 値が届いた・変わったので描き直す
 * @param {(error: string, kind?: 'mode') => void} h.fail 保存できなかった理由（kind は承認モードのとき 'mode'）
 * @param {() => object} h.empty エフォートの段が無いときの代わり
 */
export function createWorkControls(h) {
  const asked = new Set();   // 取りに行った語彙・エフォートの鍵（失敗しても同じ鍵を取り続けない）
  const local = new Map();   // 子 -> 保存できるまでの選択（行の写しが書く前でも、選んだ直後のチップが戻らない）

  /** 子の今の選択（次のターンの予約があればそれ） */
  function selection(childId) {
    const row = h.row(childId);
    const item = h.item(childId);
    const chosen = row ? h.pending(row) : null;
    const next = row?.nextSettings ?? null;
    const pick = (key, fromRow, fromItem) => chosen?.[key] ?? next?.[key] ?? fromRow ?? fromItem ?? '';
    const base = {
      backend: next?.backend ?? row?.backend ?? item?.backend ?? '',
      account: pick('account', row?.claudeAccount, ''),
      endpoint: pick('endpoint', row?.compatEndpoint, ''),
      cwd: pick('cwd', row?.cwd, item?.cwd),
      model: pick('model', row?.model, item?.model),
      effort: pick('effort', row?.effort, item?.effort),
      mode: pick('mode', row?.mode, ''),
    };
    // 重ねた選択は、行がその値になったら外す（行より先に見せていただけ。ずっと重ねると、ほかで変わった値を隠してしまう）
    const mine = local.get(childId);
    if (mine) drop(childId, Object.keys(mine).filter((k) => mine[k] === base[k]));
    return { ...base, ...local.get(childId) };
  }
  // 互換の接続先ではアカウントを使わない（接続先のキーで送る。メインの syncTopbar と同じ）
  const accountOf = (s) => (s.endpoint ? '' : s.account);
  const effortSel = (s) => ({ backend: s.backend, account: accountOf(s), endpoint: s.endpoint, model: s.model, cwd: s.cwd });

  function get(childId) {
    const s = selection(childId);
    const vocab = s.backend ? h.vocab(s.backend, accountOf(s), s.cwd) : null;
    if (s.backend && !vocab) {
      const key = JSON.stringify(['vocab', s.backend, accountOf(s), s.cwd]);
      if (!asked.has(key)) { asked.add(key); h.loadVocab(s.backend, accountOf(s), s.cwd).then(() => h.repaint(childId)).catch(() => {}); }
    }
    if (s.backend) {
      const key = JSON.stringify(['choices', s.backend]);
      if (!asked.has(key)) { asked.add(key); h.loadChoices(s.backend).then(() => h.repaint(childId)).catch(() => {}); }
    }
    const sel = effortSel(s);
    const ready = Boolean(vocab) && h.efforts.ready(sel);
    if (vocab && !h.efforts.fresh(sel)) {
      const key = `efforts:${effortsKeyOf(sel)}`;
      if (!asked.has(key)) {
        asked.add(key);
        h.efforts.adopt(sel, () => effortSel(selection(childId)), h.empty()).then((ok) => { if (ok) h.repaint(childId); }).catch(() => {});
      }
    }
    const efforts = ready ? h.efforts.efforts : {};
    const models = vocab?.models ?? {};
    const modes = vocab?.modes ?? {};
    return {
      cwd: s.cwd, recent: h.recent(), cwdDisabled: false,
      backends: h.backends(), backend: s.backend, backendSwitchable: false,
      models, modelsPending: !vocab, model: s.model,
      efforts, effortsPending: !ready, effort: s.effort, effortDisabled: !ready || Object.keys(efforts).length <= 1,
      accounts: s.backend ? h.accounts(s.backend, s.account, s.endpoint) : null, account: s.account,
      endpoint: s.backend ? h.endpointView(s.backend, s.endpoint) : null,
      modes, modesPending: !vocab, mode: s.mode || (Object.keys(modes)[0] ?? ''),
      lockedNote: '',
      // 子のエージェントは決まっている。面の頭にはロゴと名前だけを出す（Channels のスレッドの面と同じ）
      destination: { sent: true, bot: null, selected: null, readOnlyBot: null, fixedAfterSend: true, threadPlain: true,
        botSetup: '', backendLabel: h.labelOf, groups: [] },
      git: null, worktree: null, worktreePending: false, worktreeBusy: null, worktreeCheck: 'confirmed',
    };
  }

  const drop = (childId, keys) => {
    const rest = { ...local.get(childId) };
    for (const k of keys) delete rest[k];
    if (Object.keys(rest).length) local.set(childId, rest); else local.delete(childId);
  };
  /**
   * 選んだ値を、保存できるまで重ねて見せる。保存できたら、行の予約（nextSettings）が値を持つので重ねを外す
   * （行がまだ一覧に無いときは、外すとチップが戻るので残す）。保存できなければ戻して理由を言う
   */
  function choose(childId, patch, apply) {
    local.set(childId, { ...local.get(childId), ...apply });
    h.repaint(childId);
    const write = h.reserve(patch, childId);
    if (!write) { drop(childId, Object.keys(apply)); h.repaint(childId); return; }
    write.then(() => { if (h.row(childId)) drop(childId, Object.keys(apply)); h.repaint(childId); },
      (e) => { drop(childId, Object.keys(apply)); h.fail(e?.message ?? String(e)); h.repaint(childId); });
  }

  const on = {
    cwd: (childId, v) => choose(childId, { cwd: v }, { cwd: v }),
    model: (childId, v) => choose(childId, { model: v, rememberModel: true }, { model: v }),
    effort: (childId, v) => choose(childId, { effort: v, rememberEffort: true }, { effort: v }),
    mode: (childId, v) => {
      local.set(childId, { ...local.get(childId), mode: v });
      h.repaint(childId);
      h.setMode(childId, v).then(() => { if (h.row(childId)?.mode === v) drop(childId, ['mode']); h.repaint(childId); },
        (e) => { drop(childId, ['mode']); h.fail(e?.message ?? String(e), 'mode'); h.repaint(childId); });
    },
    // 互換の接続先。'' は公式。モデルとエフォートは接続先の既定へ戻る（メイン・server と同じ）
    endpoint: (childId, v) => choose(childId, { endpoint: v }, { endpoint: v, model: '', effort: '' }),
    // アカウント。'' はログイン中のアカウント（既定）
    account: (childId, v) => choose(childId, { account: v }, { account: v }),
    openModel: (childId) => { const s = selection(childId); if (s.backend) h.revalidate(s.backend, accountOf(s), s.cwd); },
    // 子では使わない口（worktree・エージェント）は渡さない
  };
  return { get, on, selection };
}
