// Chrome の操作待ちのカード（permission の browserHandoff。core/chrome/handoff.mjs、ADR 0148・0168）。
// 接続の案内（reason: connect。setup / consent / permission / denied）と、人への依頼（asked → operating）の 2 種類を 1 枚で描く。
// 接続の案内は承認の形（「許可　{エージェント} に Chrome への接続を許可しますか？」）で聞き、押したら Pleiad が Chrome の確認に答える（ADR 0218）。
// トグルがオフ（setup）なら「オンにしてつなぐ」で Pleiad がトグルを入れる。確認なしのモードでも、ここは人が押す。
// client.mjs は枠（見出し・置き場・名簿への登録）を作り、中身とボタンはここが持つ。
// 決着（戻した・つながった・断った・中断）はサーバーの permissionSettled で届き、畳む字は settledLine が決める。
// リモートの端末（client が operateHere を渡す）では「Chrome で操作する」を「この端末で操作する」（右パネルの Chrome の窓で操作する。by: 'device'）と
// 「PC で操作する」に分ける（第 7 段）。

const CHROME_INSPECT_ADDRESS = 'chrome://inspect/#remote-debugging';
// i18n-dynamic: ui:chat.browserHandoff.
const K = 'chat.browserHandoff.';
const S = 'settings.browser.agentBrowser.';

const REASONS = ['login', 'captcha', 'two_factor', 'payment', 'other'];

/** 依頼の種類の字（login ほか）。知らない値は other */
export const reasonLabel = (t, reason) => t(`${K}reason.${REASONS.includes(reason) ? reason : 'other'}`);

/** カードの見出しの 1 行（一覧・通知・畳んだ後の要約に使う） */
export function handoffSummary(t, h) {
  return h.reason === 'connect' ? t(`${K}connect.lead`) : t(`${K}askedLead`, { reason: reasonLabel(t, h.reason) });
}

/** 見出しの印。接続の案内は承認（承認を待っている）、人への依頼は Chrome の操作待ち */
export const handoffMark = (t, h) => (h?.reason === 'connect' ? t('chat.approval.headingMark') : t(`${K}headingMark`));

/** 決着の 1 行。ev は permissionSettled のイベント（allow・reason・response） */
export function settledLine(t, ev) {
  const r = ev?.response;
  if (ev?.allow === true && r?.kind === 'connected' && r.auto) return t(`${K}done.${r.continued ? 'connectedAutoContinued' : 'connectedAuto'}`);
  if (ev?.allow === true && r?.kind === 'connected') return t(`${K}done.${r.continued ? 'connectedContinued' : 'connected'}`);
  if (ev?.allow === true) return t(`${K}done.${r?.continued ? 'resumedContinued' : 'resumed'}`);
  if (ev?.reason === 'aborted') return t(`${K}done.aborted`);
  return t(`${K}done.declined`);
}

/**
 * 本文とボタンを作る。
 *   view = browserHandoffView(ev, { el, t, cmd, operateHere })
 *   view.body      … 本文の要素（差し替えで中身が替わる）
 *   view.buttons   … 今のボタン（actions へ並べる）。replaceButtons の呼び出しで並べ直す
 *   view.update(h) … permissionUpdate の browserHandoff を渡して描き直す
 * onChange(buttons, res) は描き直すたびに呼ばれ、client が actions を並べ直す。
 * spinner() は「つないでいます…」の回る印（web/arc.mjs の runMark）。
 * operateHere(会話の id) はリモートの端末だけ: 右パネルにその会話の Chrome の窓を開き、映像の箱の大きさ（{ width, height, scale }。開けなければ null）を返す
 */
export function browserHandoffView(ev, { el, t, cmd, onChange = () => {}, operateHere = null, spinner = null }) {
  let h = ev.browserHandoff;
  const targetSessionId = () => h.targetSessionId ?? ev.targetSessionId ?? ev.sessionId;
  const body = el('div', 'bh-body');
  const res = el('span', 'res');
  let buttons = [];
  let busy = false;

  const fail = err => {
    if (err?.code === 'ALREADY_RESOLVED') return;
    res.className = 'res fail';
    res.setAttribute('role', 'alert');
    res.replaceChildren(`✕ ${t(`${K}failed`, { error: err?.message ?? String(err) })}`);
  };
  /** 押したら応答まで止め、失敗したら押す前の形に戻す。成功の畳みはサーバーの決着の便りが行う（操作によっては先に届く） */
  const run = (button, work) => async () => {
    if (busy) return;
    busy = true;
    for (const b of buttons) b.disabled = true;
    res.className = 'res';
    res.removeAttribute('role');
    res.replaceChildren();
    try { await work(); } catch (err) { fail(err); }
    busy = false;
    paint();   // 押している間に届いた差し替えも、ここで反映する
  };
  const button = (label, work, cls = 'btn') => {
    const b = el('button', cls, label);
    b.type = 'button';
    b.onclick = run(b, work);
    return b;
  };
  const decline = (label = t(`${K}decline`)) => button(label, () => cmd('resolvePermission', { id: ev.id, allow: false, always: false, messageKey: 'userDenied' }), 'btn btn-quiet');
  const note = text => el('p', 'browser-setting-note', text);
  const C = `${K}connect.`;
  let copied = false, copyTimer = null;

  /** 「許可　{問い}」と説明（アプリの承認と同じ形。web/computer-use.mjs の approvalBody） */
  const ask = (question, explain) => {
    const box = el('div', 'cu-ap bh-ask');
    const ln = el('div', 'ln');
    ln.append(el('span', 'lbl', t('chat.computerApproval.label')));
    const q = el('span', 'q');
    q.append(el('span', 'qt', question));
    ln.append(q);
    box.append(ln, el('div', 'expl', explain));
    return box;
  };
  /** 手でトグルを入れる手順（アドレスの横に「コピー」） */
  const steps = () => {
    const list = el('ol', 'bh-steps');
    const one = el('li');
    const text = el('span', null, t(`${C}step1`));
    const addr = el('span', 'bh-addr');
    const copy = el('button', 'btn btn-quiet bh-copy', copied ? t(`${S}setup.copied`) : t(`${C}copy`));
    copy.type = 'button';
    copy.onclick = async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(CHROME_INSPECT_ADDRESS);
        copied = true; clearTimeout(copyTimer); copyTimer = setTimeout(() => { copied = false; if (!busy) paint(); }, 2000);
      } catch { copied = false; res.className = 'res fail'; res.replaceChildren(t(`${S}setup.copyFailed`)); return; }
      if (!busy) paint();
    };
    addr.append(el('code', null, CHROME_INSPECT_ADDRESS), copy);
    text.append(addr);
    one.append(el('span', 'n', '1'), text);
    const two = el('li');
    two.append(el('span', 'n', '2'), el('span', null, t(`${C}step2`)));
    list.append(one, two);
    return list;
  };
  const working = text => { const line = el('div', 'bh-working'); line.append(...(spinner ? [spinner()] : []), el('span', null, text)); return line; };
  const agent = () => h.agent || t('chat.computerApproval.agent');

  function paintConnect() {
    const lead = el('div', 'bh-lead');
    if (h.state === 'setup' && h.assist === 'enabling') {
      body.replaceChildren(working(t(`${C}enabling`)));
      buttons = [decline()];
    } else if (h.state === 'setup' && h.enable && h.assist !== 'enable-failed') {
      // Pleiad がトグルを入れる。確認なしのモードでも聞く（ADR 0218）
      const manual = el('details', 'bh-manual');
      manual.append(el('summary', null, t(`${C}manual`)), steps(), note(t(`${C}auto`)));
      body.replaceChildren(ask(t(`${C}enableQuestion`), t(`${C}enableExplain`)), manual);
      buttons = [...(h.auto ? [el('span', 'bh-left', t(`${C}enableAlways`))] : []),
        decline(t('chat.approval.deny')), button(t(`${C}enableAllow`), () => cmd('chromeEnable'), 'btn btn-primary')];
    } else if (h.state === 'setup') {
      lead.textContent = h.assist === 'enable-failed' ? t(`${C}enableFailed`) : t(`${S}setup.status`);
      body.replaceChildren(lead, note(t(h.assist === 'enable-failed' ? `${C}enableFailedNote` : `${C}auto`)), steps());
      // オンにできなかった（Chrome が自分の画面を先に出していた など）: 済ませてから押し直せる
      buttons = [decline(), ...(h.enable && h.assist === 'enable-failed' ? [button(t(`${S}denied.retry`), () => cmd('chromeEnable'), 'btn btn-primary')] : [])];
    } else if (h.state === 'consent') {
      body.replaceChildren(ask(t(`${C}question`, { agent: agent() }), t(`${C}explain`)));
      buttons = [el('span', 'bh-left', t(`${C}blocking`)), decline(t('chat.approval.deny')), button(t('chat.approval.allow'), () => cmd('chromeConsent'), 'btn btn-primary')];
    } else if (h.state === 'denied') {
      lead.textContent = t(`${S}denied.status`);
      body.replaceChildren(lead);
      buttons = [decline(), button(t(`${S}denied.retry`), () => cmd('chromeConnect'), 'btn btn-primary')];
    } else if (h.assist === 'allowing') {
      body.replaceChildren(working(t(`${C}allowing`)));
      buttons = [decline()];
    } else {
      lead.textContent = t(`${S}permission.status`);
      body.replaceChildren(lead, note(t(h.assist === 'allow-failed' ? `${C}allowFailedNote` : `${S}permission.note`)));
      buttons = [decline(), ...(h.dialog ? [button(t(`${S}permission.raise`), () => cmd('chromeRaiseDialog'), 'btn btn-primary')] : [])];
    }
  }

  function paintRequest() {
    const lead = el('div', 'bh-lead');
    if (h.state === 'operating') {
      lead.textContent = t(`${K}operating`);
      const where = h.by !== 'device' ? t(`${K}operatingNote`) : operateHere ? t(`${K}operatingOnDevice`) : t(`${K}operatingByDevice`);
      // 人が操作している間も、頼まれたこと（asked のときと同じ本文）を「Claude に戻す」まで出し続ける
      body.replaceChildren(lead, ...(h.message ? [el('p', 'bh-message', h.message)] : []), note(where));
      buttons = [button(t(h.turnLive === false ? `${K}resumeContinue` : `${K}resume`), () => cmd('chromeResume', { sessionId: targetSessionId() }), 'btn btn-primary')];
    } else {
      lead.textContent = t(`${K}askedLead`, { reason: reasonLabel(t, h.reason) });
      body.replaceChildren(lead);
      if (h.message) body.append(el('p', 'bh-message', h.message));
      buttons = operateHere
        ? [decline(), button(t(`${K}operateOnPc`), () => cmd('chromeTakeOver', { sessionId: targetSessionId() })), button(t(`${K}operateHere`), takeOverHere, 'btn btn-primary')]
        : [decline(), button(t(`${K}operate`), () => cmd('chromeTakeOver', { sessionId: targetSessionId() }), 'btn btn-primary')];
    }
    if (h.waitingTasks?.length > 1) {
      const list = el('ul', 'bh-waiting-tasks');
      for (const task of h.waitingTasks) {
        const item = el('li', task.current ? 'current' : null, task.title || task.taskId || '');
        // 操作に開く窓は一つだけ。どの子の窓かを字でも示す（終わると次の子の窓に替わる）
        if (task.current) item.append(el('small', 'bh-current', ` · ${t(`${K}waitingCurrent`)}`));
        list.append(item);
      }
      body.append(list);
    }
    if (h.windowTitle) body.append(el('small', 'bh-window', h.windowTitle));
  }

  async function takeOverHere() {
    const size = await operateHere(targetSessionId());
    if (!size) throw new Error(t(`${K}noWindow`));
    await cmd('chromeTakeOver', { sessionId: targetSessionId(), by: 'device', ...size });
  }

  function paint() {
    if (h.reason === 'connect') paintConnect(); else paintRequest();
    onChange(buttons, res);
  }
  paint();

  return {
    body,
    res,
    get buttons() { return buttons; },
    summary: () => handoffSummary(t, h),
    mark: () => handoffMark(t, h),
    update(next) {
      if (!next) return;
      h = { ...h, ...next };
      if (!busy) paint();
    },
  };
}
