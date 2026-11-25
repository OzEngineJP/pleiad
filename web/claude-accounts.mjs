// Claude のアカウント（会話ごとに選ぶ。core/claude-accounts.mjs）の設定。
// 一覧の追加・名前の変更・削除と、claude.ai のログイン（Pleiad が疑似端末で `claude auth login` を回す。core/claude-login.mjs）。
//
// 1 つのアカウントが持つ認証は claude.ai のログイン 1 つだけ（ADR 0352）。会話・使用量の表示・claude.ai のコネクターは、
// どれもアカウントごとの専用フォルダのログインで動く。新しいアカウントは、名前を付けてログインが済んだ時点で一覧に載る。
//
// 面は「カードがその場で開く」形（docs/design-system.md「Claude のアカウント」）:
//   閉じたカード = 名前・状態の一行・直す必要があるときの 1 つのボタン・［編集］［削除］。
//   開いたカード = 名前をその場で書き換える・ログインの行（状態と「ログインし直す」）。流れ（コードを貼る等）は、その行の下で進む。
// 流れ（認可）が走っているカードは閉じない。［完了］・Esc は名前だけを片付け、流れは［やめる］か、済む・失敗して閉じるまで残る。
// 取り消し（claudeLoginCancel）を送るのは［やめる］・別の流れを始める・流れのあるアカウントを削除する、の 3 つだけ（面を閉じても送らない）。
// 状態（state）から HTML を作り、変わった所だけ差し替える（web/dom-patch.mjs）。描き直さないので、フォーカス・打ちかけの文字・
// 開閉の動きが続く。
import { t } from './i18n.mjs';
import { patch, flash, ms } from './dom-patch.mjs';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// パスワード管理の拡張・ブラウザーに保存や補完を促されないための印（コード・表示名の欄）
const NOPM = 'autocomplete="off" data-1p-ignore data-lpignore="true" data-bwignore data-form-type="other"';
const sel = {
  card: id => `[data-account="${CSS.escape(id)}"]`,
  name: id => `[data-account="${CSS.escape(id)}"] [data-name]`,
  toggle: id => `[data-toggle="${CSS.escape(id)}"]`,
  del: id => `[data-del="${CSS.escape(id)}"]`,
  fix: (id, kind) => `[data-account="${CSS.escape(id)}"] .mp-body [data-fix="${CSS.escape(id)}:${kind}"]`,
  slot: (key, kind) => `[data-slot="flow:${CSS.escape(key)}:${kind}"]`,
  code: id => `[data-account="${CSS.escape(id)}"] [data-code]`,
  body: id => `[data-account="${CSS.escape(id)}"] .mp-body`,
};
const KINDS = { lg: 'usage-login' };
const MAX_NAME = 60;

export function setupClaudeAccounts({ cmd, openSettings, onChange = () => {} }) {
  const panel = document.createElement('section');
  // 面の中の要素は面の中で探す。面はカードの枠へ移り、カードの描き直しで文書から外れることがある（そのときも例外で止めない）
  const $ = s => panel.querySelector(s);
  panel.className = 'mp-panel'; panel.id = 'claudeAccountsPanel'; panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'caTitle');
  document.getElementById('agentControls').append(panel);

  let accounts = [], loaded = null;
  let openId = '';                 // 開いているカード（追加のカードは draftId）
  let confirmId = '';              // 削除の確認を出しているカード
  let removing = '';               // 畳んで消えていくカード
  let message = '';                // 面の下の一言（読み込み中・削除の失敗）
  let saving = false;
  let flow = null;                 // 進行中の認可 { id, kind: lg, loginId, phase, url, message, name, accountId, popup }
  const nd = {};                   // 打ちかけの表示名（カード id → 文字）
  const err = {};                  // 表示名の誤り（カード id → 文）
  const fresh = {};                // いま済んだログイン（`${id}:lg`）。✓ を出す
  const lastFix = new Map();       // カードを開くとき、直すボタンが畳み終わるまで文字を残す
  const alias = new Map();         // 追加のカードが実際のアカウントになったとき、そのカードの DOM を引き継ぐ（実 id → 札）
  let seq = 1, draftId = 'new1';
  let focusAfter = null, selectAfter = false, flashAfter = [];
  let cerr = '';
  const coarse = matchMedia('(hover:none) and (pointer:coarse)').matches;
  // デスクトップ版はサーバーが既定のブラウザーで開く。ブラウザー版は押した時点で窓を開けておき、URL が届いたら移す（後から開くとポップアップとして止められる）
  // リモートの窓（plyRemote）はデスクトップ版でも、サーバーが開くのはホストの PC のブラウザー。ブラウザー版と同じく手元で開く（docs/remote.md §7.3）
  const desktop = () => Boolean(window.plyDesktop) && !window.plyRemote;

  /** 一覧を取り直す。force でなければ前回の結果を使い回す */
  async function load(force = false) {
    if (!loaded || force) loaded = cmd('claudeAccounts').then(r => { accounts = r.accounts ?? []; return accounts; })
      .catch(e => { loaded = null; throw e; });
    return loaded;
  }
  const entries = () => {
    // 認可の途中でサーバーに登録されたアカウントは、追加のカードのまま見せる（別のカードに分かれて見えないように）
    const hide = flow && flow.id === draftId ? flow.accountId : null;
    return [...accounts.filter(a => a.id !== hide), { id: draftId, name: flow?.id === draftId ? flow.name : '', draft: true }];
  };
  const byId = id => entries().find(a => a.id === id);
  const keyOf = id => alias.get(id) ?? id;   // DOM の札（追加のカードから本物になったカードは、追加のときの札のまま）

  // ---------------------------------------------------------------- 表示名の検査（サーバーと同じ決まり: 前後の空白だけ除く・大文字小文字は区別する）
  function check(id, value) {
    const v = String(value ?? '').trim();
    if (!v) return t('accounts.name.required');
    if (v.length > MAX_NAME) return '';
    const a = byId(id);
    // すでに同名が 2 つあるデータは、名前を変えないかぎり咎めない。片方を変えれば解消する
    if (a && !a.draft && a.name.trim() === v) return '';
    return accounts.some(x => x.id !== id && x.name.trim() === v) ? t('accounts.name.duplicate') : '';
  }

  // ---------------------------------------------------------------- 描画（状態 → HTML）
  const cancelButton = `<button class="btn" type="button" data-flow="cancel">${esc(t('accounts.cancel'))}</button>`;
  function codeStep(f, error) {
    const v = f.phase === 'verifying' || f.phase === 'done';   // 済んだ直後（一覧の取り直しの間）も入力できない姿のまま
    const link = /^https:\/\//.test(f.url ?? '') ? `<p class="mp-note"><a href="${esc(f.url)}" target="_blank" rel="noreferrer">${esc(t('accounts.flow.openLink'))}</a></p>` : '';
    const step1 = f.accountId ? t('accounts.flow.step1Usage') : t('accounts.flow.step1New');
    return `<form class="mp-stage" data-k="step:code" data-flowform novalidate><p>${esc(step1)}</p>${link}<p>${esc(t('accounts.flow.step2'))}</p>`
      + `<label class="mp-field"><input data-code aria-label="${esc(t('accounts.flow.codeLabel'))}" placeholder="${esc(t('accounts.flow.codePlaceholder'))}" ${NOPM} spellcheck="false"${error ? ' aria-invalid="true"' : ''}${v ? ' disabled' : ''}></label>`
      + `<div data-slot="cerr">${error ? `<p class="mp-state" role="alert">${esc(error)}</p>` : ''}</div>`
      + `<div class="mp-actions">${cancelButton}<button class="btn btn-primary" type="submit"${v ? ' disabled' : ''}><span data-t>${esc(v ? t('accounts.flow.verifying') : t('accounts.flow.submit'))}</span></button></div></form>`;
  }
  function stepHtml(f) {
    if (f.phase === 'starting') return `<div class="mp-stage" data-k="step:starting"><p>${esc(t('accounts.flow.starting'))}</p><div class="mp-actions">${cancelButton}</div></div>`;
    if (f.phase === 'error') {
      return `<div class="mp-stage" data-k="step:error"><p class="mp-state" role="alert">${esc(f.message || t('accounts.flow.failed'))}</p><div class="mp-actions">`
        + `<span class="mp-duo">${cancelButton}<button class="btn btn-primary" type="button" data-flow="retry">${esc(t('accounts.flow.retry'))}</button></span></div></div>`;
    }
    return codeStep(f, cerr || (f.phase === 'code' ? f.message : ''));
  }

  function cardHtml(a) {
    const id = a.id, dr = Boolean(a.draft), edit = openId === id, n = esc(a.name), e = err[id];
    const hasLogin = !dr && a.usageLogin;
    // claude.ai のログインが切れている（更新できなかった印。ADR 0340 段 3）。直すボタンは「claude.ai にログインし直す」
    const expired = hasLogin && Boolean(a.usageExpired);
    const f = flow?.id === id ? flow : null, confirm = confirmId === id;
    // edit = 名前を書き換えている（［完了］を出す）。open = 中身が開いている（書き換え中か、流れが走っている）
    const open = edit || Boolean(f);
    // 閉じたカードの直すボタン（ログインがまだ・切れている）。操作の組 [直す][編集][削除] の先頭に置く
    const want = dr ? null : !hasLogin ? { kind: 'lg', label: t('accounts.authorizeUsage') } : expired ? { kind: 'lg', label: t('accounts.redoUsage') } : null;
    const fix = open ? null : want;
    if (want) lastFix.set(id, want);
    const fx = fix ?? lastFix.get(id);
    // 開いたカードで一番目立たせる操作は 1 つ
    const main = f ? 'step' : dr || !hasLogin || expired ? 'lg' : 'done';
    const pri = k => main === k ? ' btn-primary' : '';
    const tgl = dr ? [t('accounts.cancel'), t('accounts.label.cancelAdd')] : edit ? [t('accounts.done'), t('accounts.label.done', { name: a.name })] : [t('accounts.edit'), t('accounts.label.edit', { name: a.name })];
    const lgWord = expired ? t('accounts.status.expired') : hasLogin ? t('accounts.status.done') : t('accounts.status.none');
    const key = alias.get(id) ?? id;
    // 状態の行。直すボタンがあるカードでは名前の下（名前と同じ列）に入れ、操作の組が名前の横に収まらなければ組ごと状態の行の下へ回る
    const sum = `<div class="mp-fold${open || dr ? '' : ' open'}" data-k="sum"><div class="mp-fold-in mp-sum"><small data-t>${esc(t('accounts.summary', { login: lgWord }))}</small></div></div>`;

    const head = `<div class="mp-row mp-head"><div class="mp-card-info"><div class="mp-name">`
      + `<strong data-k="nm"${edit ? ' aria-hidden="true"' : ''}${a.name.length > 20 ? ` title="${n}"` : ''}>${n}</strong>`
      + `<input class="mp-name-in" data-k="in" data-name="${esc(id)}" value="${esc(nd[id] ?? a.name)}"${edit ? '' : ' tabindex="-1"'} aria-label="${esc(t('accounts.name.label'))}" maxlength="${MAX_NAME}" placeholder="${esc(t('accounts.name.placeholder'))}" ${NOPM} spellcheck="false"${e ? ` aria-invalid="true" aria-describedby="mpe-${esc(key)}"` : ''}>`
      + `</div><div data-slot="err:${esc(key)}">${e ? `<p class="mp-state" id="mpe-${esc(key)}" role="alert">${esc(e)}</p>` : ''}</div>`
      + (want ? sum : '') + `</div>`
      + `<div class="mp-card-actions${confirm ? ' away' : ''}" data-k="acts">`
      + `<span class="mp-hfold${fix ? ' open' : ''}" data-k="fixf"><span>${fx ? `<button class="btn btn-quiet" type="button" data-fix="${esc(id)}:${fx.kind}"${fix ? '' : ' tabindex="-1"'}>${esc(fx.label)}</button>` : ''}</span></span>`
      + `<button class="btn${edit && !dr ? pri('done') : ''}" type="button" data-toggle="${esc(id)}"${dr && f ? ' hidden' : ''} aria-expanded="${open}" aria-controls="mpb-${esc(key)}" aria-label="${esc(tgl[1])}"><span data-t>${esc(tgl[0])}</span></button>`
      + `<span class="mp-hfold${dr ? '' : ' open'}" data-k="delf"><span><button class="btn" type="button" data-del="${esc(id)}" aria-label="${esc(a.name ? t('accounts.label.delete', { name: a.name }) : t('accounts.label.newAccount'))}">${esc(t('accounts.delete'))}</button></span></span></div></div>`;

    const step = kind => f?.kind === kind ? stepHtml(f) : '';
    const cred = (kind, label, status, acts) => `<div class="mp-cred" data-k="cred:${kind}" role="group" aria-label="${esc(label)}"><div class="mp-cred-info"><span>${esc(label)}</span><small data-t aria-live="polite">${esc(status)}</small></div>`
      + `<div class="mp-fold${f?.kind === kind ? '' : ' open'}" data-k="acts"><div class="mp-fold-in mp-card-actions">${acts}</div></div><div class="mp-flow" data-slot="flow:${esc(key)}:${kind}" tabindex="-1">${step(kind)}</div></div>`;
    const lg = cred('lg', t('accounts.login'), fresh[id + ':lg'] ? t('accounts.status.loginFresh') : lgWord,
      `<button class="btn${pri('lg')}" type="button" data-fix="${esc(id)}:lg">${esc(hasLogin ? t('accounts.redoUsage') : t('accounts.authorizeUsage'))}</button>`);
    const body = `<div class="mp-fold${open ? ' open' : ''}" data-k="body" id="mpb-${esc(key)}"><div class="mp-fold-in mp-wide mp-body" role="group" aria-label="${esc(dr ? t('accounts.label.newAccount') : t('accounts.label.settings', { name: a.name }))}" tabindex="-1">${lg}</div></div>`;
    const conf = `<div data-slot="confirm:${esc(key)}">${confirm ? `<div class="mp-confirm" role="group" aria-label="${esc(t('accounts.label.confirm', { name: a.name }))}"><p>${esc(t('accounts.confirmDelete', { name: a.name }))}</p><div class="mp-card-actions"><button class="btn" type="button" data-confirm="no">${esc(t('accounts.cancel'))}</button><button class="btn danger" type="button" data-confirm="yes">${esc(t('accounts.confirmDeleteButton'))}</button></div></div>` : ''}</div>`;
    return `<div class="mp-fold${(dr ? open : true) && removing !== id ? ' open' : ''}" data-k="fold:${esc(key)}"><div class="mp-fold-in"><div class="mp-card mp-acct${open ? ' is-open' : ''}${edit ? ' is-edit' : ''}${want ? ' has-fix' : ''}" data-account="${esc(id)}">${head}${want ? '' : sum}${body}${conf}</div></div></div>`;
  }

  function html() {
    const list = entries(), adding = openId === draftId || flow?.id === draftId;
    return `<div class="mp-row"><h3 id="caTitle">${esc(t('accounts.title'))}</h3><button type="button" class="btn" id="caClose">${esc(t('accounts.close'))}</button></div>`
      + `<p class="mp-note mp-intro">${esc(t('accounts.intro'))}</p>`
      + `<div class="mp-list">${list.map(cardHtml).join('')}</div>`
      + `<div data-slot="empty">${accounts.length || adding ? '' : `<p class="mp-note">${esc(t('accounts.empty'))}</p>`}</div>`
      + `<div class="mp-fold${adding ? '' : ' open'}" data-k="addf"><div class="mp-fold-in"><button type="button" class="btn" data-add>${esc(t('accounts.add'))}</button></div></div>`
      + `<p class="mp-note">${esc(t('accounts.usageNote'))}</p>`
      + `<p class="mp-state" data-k="state" role="status">${esc(message)}</p>`;
  }

  /** 状態に合わせて描く。そのあと、予約したフォーカスと一瞬の強調を行う */
  function draw() {
    patch(panel, html());
    for (const s of flashAfter.splice(0)) { const x = $(s); if (x) flash(x); }
    if (focusAfter) {
      const x = typeof focusAfter === 'function' ? focusAfter() : $(focusAfter);
      if (x) { x.focus({ preventScroll: true }); if (selectAfter && x.select) x.select(); }
      focusAfter = null; selectAfter = false;
    }
  }

  // ---------------------------------------------------------------- カードの開閉・名前の保存
  /**
   * 名前の書き換えを終える。done=［完了］・Enter（保存。保存できないなら開いたまま誤りを出す）/ esc=名前を戻す /
   * switch=ほかのカードを開く（保存する。空・重複は戻す。サーバーの側の失敗は切り替えを止め、開いたまま誤りを出す）。
   * 流れが走っているカードは、流れの所を開いたまま残す（取り消しは送らない）
   */
  async function closeCard(how) {
    const id = openId, a = byId(id);
    if (!a) { openId = ''; return true; }
    if (!a.draft) {
      const v = (nd[id] ?? a.name).trim(), e = check(id, v);
      if (how === 'done' && e) { err[id] = e; focusAfter = sel.name(id); draw(); return false; }
      if (how !== 'esc' && !e && v !== a.name) {
        saving = true;
        try { await cmd('saveClaudeAccount', { id, name: v }); await load(true); onChange(); }
        catch (ex) { err[id] = ex.message; focusAfter = sel.name(id); saving = false; draw(); return false; }
        saving = false;
      }
    }
    const running = flow?.id === id;
    if (!running) { delete nd[id]; cerr = ''; }
    delete err[id]; delete fresh[id + ':lg'];
    openId = '';
    return true;
  }
  /** 開く。開いているほかのカードは閉じる（名前を保存）。保存に失敗したら切り替えない（false） */
  async function openCard(id, focus) {
    if (openId && openId !== id && !(await closeCard('switch'))) return false;
    confirmId = ''; openId = id;
    if (focus) focusAfter = focus;
    else if (coarse) focusAfter = sel.body(id);
    else { focusAfter = sel.name(id); selectAfter = true; }
    return true;
  }
  /** 流れを止める（［やめる］・流れのあるアカウントの削除）。まだ動いている流れ（済み・失敗でない）にだけ取り消しを送る（origin の startLogin と同じ条件） */
  function stopFlow(id) {
    if (flow?.id === id) {
      flow.popup?.close?.();
      const lid = flow.loginId, live = !['done', 'error'].includes(flow.phase);
      flow = null;
      if (lid && live) cmd('claudeLoginCancel', { loginId: lid }).catch(() => {});
    }
    cerr = '';
  }

  // ---------------------------------------------------------------- 認可の流れ
  async function startFlow(id, kind) {
    const a = byId(id); if (!a) return;
    if (openId !== id && flow?.id !== id && !(await openCard(id, sel.slot(keyOf(id), kind)))) { draw(); return; }
    let name = a.name;
    if (a.draft) {
      name = (nd[id] ?? '').trim();
      const e = check(id, name);
      if (e) { err[id] = e; focusAfter = sel.name(id); selectAfter = false; draw(); return; }
      delete err[id];
    }
    cerr = '';
    await startLogin({ id, kind, accountId: a.draft ? undefined : id, name });
  }
  async function startLogin({ id, kind, accountId, name }) {
    if (flow?.loginId && !['done', 'error'].includes(flow.phase)) await cmd('claudeLoginCancel', { loginId: flow.loginId }).catch(() => {});
    flow?.popup?.close?.();
    let popup = null;
    if (!desktop()) {
      // ブラウザー版: クリックの中で窓を開けておく。認可ページへ移ったあと、元の画面を操作できないよう opener を切る
      try { popup = window.open('', '_blank'); if (popup) popup.opener = null; } catch {}
    }
    flow = { id, kind, loginId: null, accountId: accountId ?? null, name, phase: 'starting', url: null, message: '', popup };
    confirmId = ''; focusAfter = sel.slot(keyOf(id), kind); draw();
    const mine = flow;
    try {
      const { loginId } = await cmd('claudeLoginStart', { kind: KINDS[kind], ...(accountId ? { accountId } : { name }), open: desktop() });
      if (flow === mine) {
        flow.loginId = loginId;
        // イベントが応答より先に届いていたら、そちらを当てる
        const early = pending.get(loginId); pending.delete(loginId);
        if (early) for (const ev of early) apply(ev);
      }
    } catch (e) {
      popup?.close?.();
      if (flow === mine) {
        flow.phase = 'error'; flow.message = e.message; flow.popup = null;
        // 開く前に止められた名前の誤り（重複など。サーバーの code: bad-name）は、行の中の流れでなく名前の欄に出す。ほかは流れの所に［やり直す］と出す
        if (!accountId && e.code === 'bad-name') {
          flow = null;
          if (openId !== id) await openCard(id, sel.name(id));   // やり直しのときは、ほかのカードの書き換えを片付けてから名前の欄を開く
          err[id] = e.message; focusAfter = sel.name(id);
        } else focusAfter = `${sel.slot(keyOf(id), kind)} [data-flow="retry"]`;
        draw();
      }
    }
  }
  async function submitCode(form) {
    const f = flow; if (!f?.loginId || f.phase !== 'code' && f.phase !== 'url') return;
    const code = String(form.querySelector('[data-code]')?.value ?? '').trim();
    if (!code) { cerr = t('accounts.flow.codeRequired'); focusAfter = sel.code(f.id); draw(); return; }
    f.phase = 'verifying'; f.message = ''; cerr = ''; focusAfter = sel.slot(keyOf(f.id), f.kind); draw();
    try { await cmd('claudeLoginCode', { loginId: f.loginId, code }); }
    catch (e) { if (flow === f) { f.phase = 'code'; f.message = e.message; focusAfter = sel.code(f.id); draw(); } }
  }
  // claudeLoginStart の応答より先に届いたイベント（loginId がまだ分からない）
  const pending = new Map();
  function apply(ev) {
    if (!flow || ev.loginId !== flow.loginId) return;
    const f = flow;
    if (ev.accountId) f.accountId = ev.accountId;
    if (ev.phase === 'url') {
      f.url = ev.url;
      if (f.phase === 'starting') { f.phase = 'url'; focusIfLost(f); }
      if (f.popup && /^https:\/\//.test(ev.url ?? '')) { try { f.popup.location.href = ev.url; } catch {} f.popup = null; }
    } else if (ev.phase === 'code') { f.phase = 'code'; f.message = ev.message ?? ''; focusIfLost(f); }
    else if (ev.phase === 'verifying') f.phase = 'verifying';
    else if (ev.phase === 'done') { f.phase = 'done'; draw(); finishFlow(f); return; }   // 一覧を取り直す間も入力できない姿で見せる
    else if (ev.phase === 'error') { f.phase = 'error'; f.message = ev.message ?? ''; f.popup?.close?.(); f.popup = null; focusAfter = `${sel.slot(keyOf(f.id), f.kind)} [data-flow="retry"]`; }
    else if (ev.phase === 'cancelled') flow = null;
    draw();
  }
  /** 次の段階の入力欄へフォーカスを移す。ただし、利用者が別の所へ移していたら奪わない */
  function focusIfLost(f) {
    const ae = document.activeElement;
    if (ae === document.body || ae === null || ae.closest?.(sel.slot(keyOf(f.id), f.kind))) focusAfter = sel.code(f.id);
  }
  /** 済んだ: 一覧を取り直し、行の状態を「✓」にして、追加のカードなら実際のアカウントへ引き継ぐ */
  async function finishFlow(f) {
    try { await load(true); } catch {}
    if (flow !== f) return;
    const wasIn = inCard(f.id);   // 引き継ぐ前の札で見る（追加のカードの DOM はまだ追加のときの id）
    let id = f.id;
    if (id === draftId && f.accountId) id = promoteDraft(f.accountId);
    fresh[id + ':' + f.kind] = true; flashAfter.push(`${sel.card(id)} [data-k="cred:${f.kind}"]`);
    flow = null;
    // 書き換え中で開いたままなら［完了］へ。流れだけで開いていたカードは閉じるので、フォーカスがその中にあったときだけ［編集］へ
    if (openId === id || wasIn) focusAfter = sel.toggle(id);
    draw(); onChange();
  }
  /** 追加のカードが実際のアカウントになった: 同じ DOM を引き継ぎ、新しい追加のカードを用意する */
  function promoteDraft(realId) {
    alias.set(realId, draftId);
    if (openId === draftId) openId = realId;
    if (nd[draftId] != null) { nd[realId] = nd[draftId]; delete nd[draftId]; }
    delete err[draftId];
    draftId = 'new' + (++seq);
    return realId;
  }
  /** サーバーからの claudeLogin イベント（web/client.mjs が渡す） */
  function loginEvent(ev) {
    if (flow && !flow.loginId && flow.phase === 'starting') {
      const list = pending.get(ev.loginId) ?? []; list.push(ev); pending.set(ev.loginId, list);
      if (pending.size > 20) pending.delete(pending.keys().next().value);
      return;
    }
    apply(ev);
  }
  function cancelFlow() {
    const f = flow; if (!f) return;
    stopFlow(f.id);
    focusAfter = openId === f.id ? sel.fix(f.id, f.kind) : sel.toggle(f.id); draw();
  }
  const inCard = id => { const c = $(sel.card(id)), ae = document.activeElement; return Boolean(c && ae && c.contains(ae)); };

  // ---------------------------------------------------------------- 削除
  async function remove(id) {
    message = '';
    const order = entries().filter(x => !x.draft).map(x => x.id), next = order.filter(x => x !== id)[Math.min(order.indexOf(id), order.length - 2)];
    try {
      await cmd('deleteClaudeAccount', { id });
    } catch (e) { confirmId = ''; message = t('accounts.deleteFailed', { error: e.message }); draw(); return; }
    confirmId = '';
    if (flow?.id === id) stopFlow(id);   // 流れのあるアカウントの削除は、その流れに取り消しを送る
    if (openId === id) { delete nd[id]; delete err[id]; openId = ''; }
    removing = id; focusAfter = next ? sel.toggle(next) : '[data-add]'; draw();
    // 畳み終わってから一覧から外す（下のカードが跳ばない）
    setTimeout(async () => { try { await load(true); } catch {} removing = ''; draw(); onChange(); }, ms('--dur'));
  }

  // ---------------------------------------------------------------- 入力
  panel.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b || !panel.contains(b) || b.disabled) return;
    const d = b.dataset;
    if (b.id === 'caClose') { close(); return; }
    if (saving) return;
    if (d.toggle) {
      const id = d.toggle;
      if (openId !== id) { if (!(await openCard(id))) { draw(); return; } }
      else if (byId(id)?.draft) { await closeCard('esc'); if (flow?.id !== id) focusAfter = '[data-add]'; }
      else if (await closeCard('done')) focusAfter = sel.toggle(id);
      else return;
    } else if (d.add != null) { if (!(await openCard(draftId))) { draw(); return; } }
    else if (d.del) { confirmId = d.del; focusAfter = '[data-confirm="no"]'; }
    else if (d.confirm) {
      const id = confirmId;
      if (d.confirm === 'no') { confirmId = ''; focusAfter = sel.del(id); }
      else { await remove(id); return; }
    } else if (d.fix) { const [id, kind] = d.fix.split(':'); await startFlow(id, kind); return; }
    else if (d.flow === 'retry') {
      const f = flow; if (!f) return;
      // origin と同じく、流れが知ったアカウント（登録済みのもの）があればそれで、無ければ名前でやり直す
      await startLogin({ id: f.id, kind: f.kind, accountId: f.accountId ?? (byId(f.id)?.draft ? undefined : f.id), name: f.name });
      return;
    } else if (d.flow === 'cancel') { cancelFlow(); return; }
    else return;
    draw();
  });
  panel.addEventListener('submit', e => {
    e.preventDefault();
    if (e.target.matches('[data-flowform]')) submitCode(e.target);
  });
  panel.addEventListener('input', e => {
    const i = e.target, id = i.dataset?.name;
    if (id != null) { nd[id] = i.value; if (err[id]) { delete err[id]; draw(); } }
    else if (i.dataset?.code != null && cerr) { cerr = ''; draw(); }
  });
  panel.addEventListener('keydown', async e => {
    if (e.isComposing) return;
    const id = e.target.dataset?.name;
    if (e.key === 'Enter' && id != null) {
      // 登録済み: Enter は名前を保存して閉じる。新しいカード: Enter は一番の操作（claude.ai にログイン）
      e.preventDefault();
      if (saving) return;
      if (byId(id)?.draft) await startFlow(id, 'lg');
      else if (await closeCard('done')) { focusAfter = sel.toggle(id); draw(); }
    } else if (e.key === 'Escape') {
      // 1 回に 1 層: 削除の確認 → カード（名前を戻す）。流れは止めない（［やめる］だけが止める）。設定の画面までは届かせない
      const o = openId;
      if (!confirmId && !o) return;
      e.preventDefault(); e.stopPropagation();
      if (confirmId) { const c = confirmId; confirmId = ''; focusAfter = sel.del(c); }
      else { const dr = byId(o)?.draft, running = flow?.id === o; await closeCard('esc'); focusAfter = running ? sel.slot(keyOf(o), flow.kind) : dr ? '[data-add]' : sel.toggle(o); }
      draw();
    }
  });

  // ---------------------------------------------------------------- 外から使う入口
  /** 面を閉じる。流れは止めない（origin と同じ。開き直すと、流れがまだ生きていれば続きが見える） */
  function close() {
    panel.hidden = true;
    openId = ''; confirmId = ''; message = '';
    for (const k of Object.keys(nd)) delete nd[k];
    for (const k of Object.keys(err)) delete err[k];
    for (const k of Object.keys(fresh)) delete fresh[k];
    draw();
  }
  // usageLogin: そのアカウントの claude.ai のログイン（し直し）を始める（会話の失敗の行の［ログインし直す］。web/auth-expired.mjs、ADR 0212・0352）。
  // focus: そのアカウントのカードの［編集］へフォーカスを置く（設定 › 委譲の「ログインし直す」。ADR 0264）
  let onOpen = () => {};
  async function open({ usageLogin, focus } = {}) {
    openSettings(); panel.hidden = false; onOpen('claude');   // backend-allow: この面は Claude のアカウント専用
    message = t('accounts.loading'); draw();
    try {
      await load(true);
      message = ''; confirmId = ''; draw();
      panel.scrollIntoView({ block: 'nearest' });
      const target = usageLogin && accounts.find(a => a.id === usageLogin);
      if (target) await startFlow(target.id, 'lg');
      else if (usageLogin) { message = t('accounts.loginMissing'); draw(); }
      else if (focus && accounts.some(a => a.id === focus)) { focusAfter = sel.toggle(focus); draw(); }
    } catch (e) { message = e.message; draw(); }
  }
  draw();
  return {
    open, load, list: () => accounts, loginEvent,
    /** 管理の面（web/client.mjs がカードの枠へ移し、描き直しの前に元の置き場へ戻す） */
    panel,
    /** 面を閉じる（エージェントのカードの「接続」を畳むとき。［閉じる］と同じ） */
    close,
    /** 開いている面のエージェント（閉じていれば ''。設定のカードの aria-expanded と再描画で使う） */
    get openAgent() { return panel.hidden ? '' : 'claude'; },   // backend-allow: この面は Claude のアカウント専用
    /** open() が呼ばれた（カードの「接続」の面を開く合図。web/client.mjs が受ける） */
    onOpen(fn) { onOpen = fn; },
    invalidate: () => { loaded = null; if (!panel.hidden) load(true).then(() => draw()).catch(() => {}); },
  };
}
