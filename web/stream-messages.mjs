// 走っているターンの出来事（loadSession の live が返す stream.events）を、保存済みの履歴と同じ形の仮の発言に畳む。
// 読むだけの筋（作業の詳細、client.mjs の readonlyThread）は履歴の形しか描かないので、ここで畳んで保存済みの発言の後ろに足す
// （Antigravity の子は、ターンが終わるまで履歴に何も入らない）。
// メインパネルは、サーバーが splitLive で畳める分（もう変わらない頭）を発言にして末尾の窓で受け取り、まだ動いている末尾だけを onEvent で再生する（ADR 0257）。
// 発言の区切りは onEvent に合わせる: text.end で発言を閉じ、閉じた後の本文・考えた内容・text.end は次の発言にする。
// 本文の無い（ツールだけの）発言に続く本文の無い text.end は区切らない（onEvent の endedWithText。履歴も連続するツールだけの発言を 1 つにする）。
// ツールは閉じた発言にも続けて入る（履歴の 1 発言 = 本文 + ツール呼び出し）。人の発言・完了通知・提示は発言を閉じる。

const META = new Set(['type', 'sessionId', 'streamSeq']);
const strip = (ev) => Object.fromEntries(Object.entries(ev).filter(([key]) => !META.has(key)));
const isoAt = (at) => typeof at === 'number' && Number.isFinite(at) ? new Date(at).toISOString() : at ?? null;

/** 畳む出来事。これ以外（稼働表示・文脈の量・圧縮・中断の知らせ・ターンの結果と終わり）は splitLive が再生に回す */
const FOLDED = new Set(['text.delta', 'text.end', 'thinking.start', 'thinking.delta', 'tool.start', 'tool.result',
  'userMessage', 'userMessage.delivered', 'userMessage.dropped', 'taskInstruction', 'taskNotice', 'present']);
/** 再生に回すもののうち、最後の 1 件だけが今の状態を表すもの */
const LATEST_ONLY = new Set(['activity', 'contextWindow']);

/**
 * 出来事を前から畳む。onSettled(i, messages, presents) は、i 番目の出来事の手前が「もう変わらない」ときに呼ぶ:
 * i 番目が新しい発言を始め（閉じた発言の後の本文・考えた内容、人の発言・指示・完了通知・提示）、
 * それより前のツールは結果が付き、人の発言は渡っていて、配達の合図の先回りも残っていない。
 * そこで画面の onEvent を空の状態から始めても、手前を履歴として描いた後に同じ並びになる。
 * turnResult を畳むか（読むだけの筋は畳む。メインパネルは onEvent に任せる）は foldResult
 */
function fold(events, { backend, model, initialMessageId, foldResult = true, onSettled = null }) {
  const messages = [];
  const presents = [];
  const calls = new Map();
  const open = new Set();        // 結果がまだのツールの id
  const users = new Map();       // messageId -> 人の発言（途中送信）
  const undelivered = new Set(); // 受理しただけで、まだエージェントに渡っていない発言（渡るまでは指示の一覧に出ている）
  const deliveredEarly = new Set(); // 吹き出しより先に届いた配達の合図（onEvent の deliveredEarly と同じ）
  let turn = null, closed = false, writing = false, thinking = false, endedWithText = false, pendingUuid = null, lastAt = null;
  const closeTurn = () => { turn = null; closed = false; writing = false; thinking = false; endedWithText = false; pendingUuid = null; };
  // 入れ物が無ければ作る。閉じた印はそのまま（onEvent の ensureTurnEl）。入れ物の無いまま閉じた発言の id（pendingUuid）は、この入れ物が持つ
  const ensureTurn = () => {
    if (turn) return turn;
    turn = { role: 'assistant', text: '', ...(backend ? { backend } : {}), ...(model ? { model } : {}), ...(lastAt ? { at: lastAt } : {}),
      ...(pendingUuid ? { uuid: pendingUuid } : {}) };
    pendingUuid = null;
    messages.push(turn);
    return turn;
  };
  // 本文・考えた内容は、閉じた発言の後なら新しい入れ物に書く（onEvent の openTurnEl。閉じ直すので pendingUuid は捨てる）
  const openTurn = () => {
    if (closed) closeTurn();
    return ensureTurn();
  };
  /** この出来事が新しい発言を始めるか（手前の発言はもう変わらない） */
  const starts = (ev) => {
    switch (ev?.type) {
      case 'text.delta': return Boolean(ev.text) && !writing && (!turn || closed);
      case 'thinking.delta': return Boolean(ev.text) && !thinking && (!turn || closed);
      case 'userMessage': return !(ev.initial || (ev.messageId && ev.messageId === initialMessageId));
      case 'taskInstruction': case 'taskNotice': return true;
      case 'present': return ev.by !== 'human';
      default: return false;
    }
  };
  for (let i = 0; i < (events?.length ?? 0); i++) {
    const ev = events[i];
    if (onSettled && i > 0 && !open.size && !undelivered.size && !deliveredEarly.size && starts(ev)) onSettled(i, messages, presents);
    const at = isoAt(ev?.at);
    if (typeof at === 'string') lastAt = at;
    switch (ev?.type) {
      case 'text.delta': {
        const text = String(ev.text ?? '');
        if (!text) break;
        if (!writing) { const m = openTurn(); if (m.text) m.text += '\n\n'; writing = true; }
        thinking = false;
        turn.text += text;
        break;
      }
      case 'text.end': {
        const bodyless = !writing && !thinking;
        // ツールだけの発言に続くツールだけの発言は、同じ発言のまま（onEvent も入れ物を替えない）
        if (bodyless && closed && !endedWithText) break;
        // 見せるものが無いまま閉じた（考えた内容が署名だけ）: 入れ物は作らず、id は次の入れ物に持たせる
        if (bodyless && !turn) { pendingUuid = ev.uuid ?? null; closed = true; endedWithText = false; break; }
        const m = openTurn();
        if (ev.uuid) m.uuid = ev.uuid;
        endedWithText = !bodyless;
        closed = true; writing = false; thinking = false;
        break;
      }
      case 'thinking.start':
        writing = false;
        break;
      case 'thinking.delta': {
        if (!ev.text) break;
        if (!thinking) { const m = openTurn(); m.thinking = m.thinking ? `${m.thinking}\n\n` : ''; thinking = true; }
        turn.thinking += String(ev.text);
        break;
      }
      case 'tool.start': {
        if (ev.id && calls.has(ev.id)) break;
        writing = false;
        const m = ensureTurn();
        const call ={ id: ev.id ?? null, name: ev.name, input: ev.input ?? null };
        // 始まりの時刻（サーバーが受けた at・バックエンドが申告した startedAt）。走っている行の経過の起点（web/server-clock.mjs）
        if (Number.isFinite(ev.at)) call.at = ev.at;
        if (ev.startedAt != null) call.startedAt = ev.startedAt;
        (m.toolCalls ??= []).push(call);
        if (ev.id) { calls.set(ev.id, call); open.add(ev.id); }
        break;
      }
      case 'tool.result': {
        const call = calls.get(ev.id);
        if (call) { const { id, ...result } = strip(ev); call.result = result; }
        open.delete(ev.id);
        break;
      }
      case 'userMessage': {
        if (ev.initial || (ev.messageId && ev.messageId === initialMessageId)) break;
        closeTurn();
        const known = ev.messageId ? users.get(ev.messageId) : null;
        const m = known ?? { role: 'user', text: '', at: null };
        m.text = String(ev.text ?? '');
        m.at = at ?? m.at;
        if (ev.sentBy) m.sentBy = ev.sentBy;
        if (!known) { messages.push(m); if (ev.messageId) users.set(ev.messageId, m); }
        if (ev.pending && ev.messageId && !deliveredEarly.delete(ev.messageId)) undelivered.add(m);
        else undelivered.delete(m);
        break;
      }
      case 'userMessage.delivered': {
        const m = users.get(ev.messageId);
        if (m) undelivered.delete(m);
        else if (ev.messageId) deliveredEarly.add(ev.messageId);
        break;
      }
      case 'userMessage.dropped': {
        const m = users.get(ev.messageId);
        if (m) { messages.splice(messages.indexOf(m), 1); users.delete(ev.messageId); undelivered.delete(m); }
        break;
      }
      case 'taskInstruction': {
        // 委譲の子への追加指示を受け付けた（server.mjs の steerInstruction ではなく受付時の出来事）。
        // この位置が会話の中での位置。状態（送信中・渡った・落ちた）は instructions の記録が正なので、ここでは場所の印だけ置く
        closeTurn();
        messages.push({ role: 'user', taskInstructionId: ev.instructionId, text: String(ev.text ?? ''), at });
        break;
      }
      case 'taskNotice':
        closeTurn();
        messages.push({ role: 'user', internalTaskNotice: true, text: String(ev.text ?? ''), at });
        break;
      case 'present':
        if (ev.by !== 'human') closeTurn();
        presents.push(strip(ev));
        break;
      case 'turnResult':
        if (!foldResult || ev.compact || ev.outcome === 'ok') break;
        closeTurn();
        if (ev.outcome === 'aborted') messages.push({ role: 'system', kind: 'interrupt', text: '', at });
        break;
      default:
        break;
    }
  }
  return { messages, presents, undelivered };
}

const shown = (undelivered) => (m) => !undelivered.has(m) && (m.role !== 'assistant' || m.text || m.thinking || m.toolCalls?.length);

/**
 * @param {object[]} events stream.events（streamSeq の順）
 * @param {{ backend?: string|null, model?: string|null, initialMessageId?: string|null }} [opts]
 *   backend・model は仮の AI の発言の発言者。initialMessageId はターンを始めた発言（サーバーが履歴の末尾に足し済み）
 * @returns {{ messages: object[], presents: object[] }} 保存済みの履歴（NormalizedMessage）と提示（presents）と同じ形
 */
export function streamMessages(events = [], { backend = null, model = null, initialMessageId = null } = {}) {
  const { messages, presents, undelivered } = fold(events ?? [], { backend, model, initialMessageId });
  return { messages: messages.filter(shown(undelivered)), presents };
}

/**
 * メインパネルで走っている会話を開くときの形（ADR 0257）。出来事を、もう変わらない頭と、まだ動いている末尾に分ける。
 * 頭は履歴と同じ形の発言・提示に畳み（messages・presents）、末尾は onEvent で再生する出来事（events）として返す。
 * 頭にあった再生用の出来事（稼働表示・文脈の量は最後の 1 件、圧縮・中断の知らせ・ターンの結果と終わりは全部）は、末尾の前に付けて返す。
 * 分けられる所が無ければ、全部を出来事のまま返す（folded: 0。今までと同じ）。
 * 畳んだ発言は、頭の後の出来事では変わらない（新しい発言が始まる所でしか分けない・結果の無いツール・渡っていない発言を頭に残さない）
 * @returns {{ messages: object[], presents: object[], events: object[], folded: number }} folded は畳んだ出来事の数
 */
export function splitLive(events = [], { backend = null, model = null, initialMessageId = null } = {}) {
  const list = events ?? [];
  let cut = null;
  fold(list, { backend, model, initialMessageId, foldResult: false,
    onSettled: (i, messages, presents) => { cut = { i, messages: messages.length, presents: presents.length }; } });
  if (!cut) return { messages: [], presents: [], events: list, folded: 0 };
  // 頭だけを畳み直す（末尾の出来事が混ざらない、その時点の形）
  const head = fold(list.slice(0, cut.i), { backend, model, initialMessageId, foldResult: false });
  const replay = [];
  const latest = new Map();
  for (const ev of list.slice(0, cut.i)) {
    if (FOLDED.has(ev?.type)) continue;
    if (LATEST_ONLY.has(ev.type)) latest.set(ev.type, ev);
    else replay.push(ev);
  }
  const carried = [...replay, ...latest.values()].sort((a, b) => (a.streamSeq ?? 0) - (b.streamSeq ?? 0));
  return { messages: head.messages.filter(shown(head.undelivered)), presents: head.presents, events: [...carried, ...list.slice(cut.i)], folded: cut.i };
}
