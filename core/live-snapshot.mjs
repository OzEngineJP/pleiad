// 走っているターンを開くときの形（ADR 0257）。ターンの出来事のうち、もう変わらない頭を履歴と同じ形の発言に畳み（web/stream-messages.mjs の splitLive）、
// まだ動いている末尾だけを画面が再生する出来事として残す。畳んだ発言はターン前の履歴の後ろに並び、保存済みの履歴と同じ末尾の窓（ADR 0182）で運ばれる。
// 走っている間の tool.result はバックエンドが全文で流す（画面の走っているカード用）。畳んだ発言の結果は、保存済みの履歴と同じ長さに切る
import { splitLive } from '../web/stream-messages.mjs';
import { MAX_RESULT_CHARS, cutText } from './backends/shared.mjs';

const cutCall = (call) => {
  const text = call?.result?.text;
  if (typeof text !== 'string' || text.length <= MAX_RESULT_CHARS) return call;
  return { ...call, result: { ...call.result, text: cutText(text, MAX_RESULT_CHARS, '\n…'), truncated: true } };
};

/**
 * @param {{ messages: object[], presents: object[], events: object[], initialMessageId?: string|null }} stream ターンの stream（ターン前の履歴の写しと出来事）
 * @param {{ backend?: string|null, model?: string|null }} [speaker] 畳んだ AI の発言の発言者
 * @returns {{ messages: object[], presents: object[], events: object[] }}
 *   messages は畳んだ発言だけ（live: true の印付き。ターン前の履歴・ターンを始めた発言は含まない）、presents も畳んだ分だけ、events は再生する出来事
 */
export function liveSnapshot(stream, { backend = null, model = null } = {}) {
  const split = splitLive(stream?.events ?? [], { backend, model, initialMessageId: stream?.initialMessageId ?? null });
  return {
    messages: split.messages.map(m => ({ ...m, live: true, ...(m.toolCalls ? { toolCalls: m.toolCalls.map(cutCall) } : {}) })),
    presents: split.presents,
    events: split.events,
  };
}
