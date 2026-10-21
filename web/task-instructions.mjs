// 委譲の子への追加指示（ply_task_send）の行を、会話の中の受け付けた位置へ差し込む。
// 返すのは発言と指示の混ざった配列: 発言は元の形、指示は { role:'instruction', instruction }。
// mergeToolTurns より前に差し込むので、ツール呼び出しのまとまりの途中にも指示の行を置ける。
//
// 位置は ID で引く（件数・本文での照合はしない）:
// - 走っているターンの受付の出来事（stream-messages.mjs が畳む taskInstructionId の行）はその位置
// - ターン開始の入力に使った発言（deliveryId = messageId）は省き、保存した受付位置に全員分を置く
// - 届いた発言の履歴行（nativeId）は重複なので省く。省くのは指示の本文とまるごと一致した行だけ
//   （API のページに無い古い指示の本文まで消さない）。省いた行の位置は指示ごとに覚えておき、
//   錨も時刻も引けない指示の置き場に使う（時刻の無い履歴でも末尾に流れない）。指示の行は
//   受付位置に残す（届いた位置＝受け付けた後の出力より後ろへは動かさない）
// - 受付時の錨（instruction.anchor）: 直前に見えていたもの（発言の uuid・ツール呼び出しの id・
//   人の発言の messageId・直前の指示）の id を受付時に記録したもの。読み直し後も同じ場所に戻る
// - どれも無い分は受付時刻（at）。配送済みで ID も時刻の手がかりも無い旧データは履歴の発言に任せる
//
// 表示契約: この関数が読む指示の項目は INSTRUCTION_FIELDS。ホストの経過の読み出し
// （core/remote/agent-view.mjs の viewInstructions）・手元の射影（core/ops/delegation.mjs の
// delegation.instructions の uiHandler）・ホストが send の応答に添える記録（server.mjs の remoteAgentInvoke）は、
// すべて同じ instructionView で作る
export const INSTRUCTION_FIELDS = Object.freeze(['id', 'at', 'state', 'text', 'deliveryId', 'nativeId', 'anchor', 'nextTurn']);
/** 指示の記録を表示契約の形にする。clipText で本文を絞れる（ホストの読み出しは口の上限に収めるため切る） */
export function instructionView(x, clipText = s => s) {
  return {
    id: String(x?.id), at: x?.at ?? null, state: String(x?.state ?? ''), text: clipText(String(x?.text ?? '')),
    ...(x?.deliveryId ? { deliveryId: String(x.deliveryId) } : {}),
    ...(x?.nativeId ? { nativeId: String(x.nativeId) } : {}),
    ...(x?.anchor && typeof x.anchor === 'object' && typeof x.anchor.v === 'string' ? { anchor: { kind: String(x.anchor.kind), v: String(x.anchor.v) } } : {}),
    ...(x?.nextTurn ? { nextTurn: true } : {}),
  };
}

export function injectTaskInstructions(instructions = [], messages = []) {
  const byId = new Map((instructions ?? []).filter(Boolean).map(i => [i.id, i]));
  const anchored = new Set();
  const deliveryRows = new Set(), deliveryAnchors = new Map();
  // 位置の印として out に残すが、届いた発言そのものは出さない行（viaNative で消した行）。
  // 時刻の足場に数えない（取り除いた行と同じ扱い）
  const nativeRows = new Set();
  const out = [];
  const ins = instruction => ({ role: 'instruction', instruction, text: instruction.text, at: instruction.at });

  for (const m of messages ?? []) {
    const marker = m?.taskInstructionId ? byId.get(m.taskInstructionId) : null;
    if (marker && !anchored.has(marker.id)) { out.push(ins(marker)); anchored.add(marker.id); continue; }
    const viaDelivery = m?.messageId ? instructions.filter(x => x.deliveryId === m.messageId) : [];
    if (viaDelivery.length) {
      if (String(m.text ?? '') === viaDelivery.map(x => x.text).join('\n\n')) {
        for (const x of viaDelivery) deliveryAnchors.set(x.id, m);
        // Keep the row as a fallback anchor until every instruction is placed.
        deliveryRows.add(m); out.push(m); continue;
      }
      // A partial batch may contain instructions outside the fetched page.
      viaDelivery.forEach(x => anchored.add(x.id)); out.push(m); continue;
    }
    // nativeId の行は、指示が別の印（marker・deliveryId）で置き済みでも省く（消さないと二重に出る）。
    // 省くのは指示の本文とまるごと一致した行だけ
    const viaNative = m?.uuid ? instructions.filter(x => x.nativeId === m.uuid) : [];
    if (viaNative.length && String(m.text ?? '') === viaNative.map(x => x.text).join('\n\n')) {
      // 届いた行の位置を指示ごとに覚えておく（deliveryAnchors と同じ考え方）。行は位置の印として残し、最後に外す
      for (const x of viaNative) deliveryAnchors.set(x.id, m);
      deliveryRows.add(m); nativeRows.add(m); out.push(m); continue;
    }
    if (viaNative.length) viaNative.forEach(x => anchored.add(x.id));   // 確かめられないときは履歴の行を残し、指示は出さない
    out.push(m);
  }

  // 錨が指すものを out の中から探す（発言の uuid / ツール呼び出しの id / 発言の messageId / 直前の指示）
  const anchorIndex = anchor => {
    if (!anchor) return -1;
    if (anchor.kind === 'instruction') return out.findIndex(x => x.role === 'instruction' && x.instruction?.id === anchor.v);
    // ツールの錨で分けた発言は前後とも同じ uuid。発言の錨（本文を書き終えた後）は後ろの片に付ける
    if (anchor.kind === 'uuid') return out.findLastIndex(x => x.role !== 'instruction' && x.uuid === anchor.v);
    return out.findIndex(x => (anchor.kind === 'msg' && (x.messageId === anchor.v || x.instruction?.deliveryId === anchor.v))
      || (anchor.kind === 'tool' && (x.toolCalls ?? []).some(c => c.id === anchor.v)));
  };
  const tsOf = m => { const t = m?.at; if (Number.isFinite(t)) return t; const p = Date.parse(t); return Number.isFinite(p) ? p : null; };
  // 位置の印だけの行（消した届いた行）は、時刻の足場にしない（無ければ前の行の時刻を引き継ぐ＝行が無いのと同じ）
  const eff = out.map(m => nativeRows.has(m) ? null : tsOf(m));
  for (let i = 1; i < eff.length; i++) if (eff[i] == null) eff[i] = eff[i - 1];
  const atIndex = at => { let i = 0; while (i < eff.length && (eff[i] == null || eff[i] <= at)) i++; return i; };
  const anchorTail = new Map();   // 錨（JSON）→ 次に差す位置（同じ錨に続ける分の受付順を保つ）

  for (const instruction of (instructions ?? [])) {
    if (!instruction || anchored.has(instruction.id)) continue;
    // 配送済みで履歴も錨も時刻も引けないものは、履歴の発言が引き継ぐ（旧データを推測で消したり二重に出したりしない）
    if (instruction.state === 'delivered' && !instruction.nativeId && !deliveryAnchors.has(instruction.id)) continue;
    const ai = anchorIndex(instruction.anchor);
    if (ai >= 0) {
      // 同じ錨を指す指示が連続するときは、直前に置いた指示の直後へ（受付順を保つ）
      const key = JSON.stringify(instruction.anchor);
      const previous = anchorTail.get(key);
      const pos = previous ? out.indexOf(previous) + 1 : ai + 1;
      // 錨がツール呼び出しで、同じ発言の中に後の呼び出しがあるなら、その発言を錨の位置で分ける
      // （受付後に続いたツール呼び出しは指示の後ろに残す＝元の見え方を戻す）
      const row = out[ai];
      if (instruction.anchor?.kind === 'tool') {
        const calls = row.toolCalls ?? [];
        const p = calls.findIndex(c => c.id === instruction.anchor.v);
        // ツールの後に書いた本文を同じ発言に畳む形（codex の textAfterTools）では、本文も受付後の出力
        const textAfter = Boolean(row.textAfterTools && row.text);
        if (p >= 0 && (p < calls.length - 1 || textAfter)) {
          // ai+1 に指示を差すと、後半の呼び出し（と後の本文）が指示の後ろへ押し出される
          out[ai] = { ...row, toolCalls: calls.slice(0, p + 1), ...(textAfter ? { text: '' } : {}) };
          out.splice(ai + 1, 0, { ...row, text: textAfter ? row.text : '', thinking: undefined, toolCalls: calls.slice(p + 1) });
          eff.splice(ai + 1, 0, eff[ai]);
        }
      }
      const inserted = ins(instruction);
      out.splice(pos, 0, inserted); eff.splice(pos, 0, eff[ai] ?? null);
      anchorTail.set(key, inserted);
      continue;
    }
    // 届いた行を省いた分・錨も時刻も引けない配送済み以外は、受付時刻の位置に出す
    const delivery = deliveryAnchors.get(instruction.id);
    const hasTime = Number.isFinite(instruction.at) && out.some(m => m.role !== 'instruction' && !deliveryRows.has(m) && tsOf(m) != null);
    const i = delivery && !hasTime ? out.indexOf(delivery) : atIndex(Number.isFinite(instruction.at) ? instruction.at : Infinity);
    out.splice(i, 0, ins(instruction)); eff.splice(i, 0, instruction.at ?? null);
  }
  return out.filter(m => !deliveryRows.has(m));
}
