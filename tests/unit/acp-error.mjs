import assert from 'node:assert/strict';
import { GrokAcp } from '../../core/backends/grok-acp.mjs';
import { DevinAcp } from '../../core/backends/devin-acp.mjs';
import { acpTurnLimit } from '../../core/backends/acp-error.mjs';
import { currentLocale, setLocale, t as translate } from '../../core/i18n.mjs';

export const name = 'acp-error';
export const title = 'ACP provider limits retain actionable reasons without exposing RPC secrets';

export default async function test(t) {
  const previousLocale = currentLocale();
  const secret = 'SYNTHETIC_ACP_SECRET';
  const cases = [
    [{ code: -32603, message: `API error (status 402 Payment Required): Grok Build usage balance exhausted ${secret}` }, 'usageExhausted'],
    [{ code: -32000, message: secret, data: { message: `insufficient_quota ${secret}` } }, 'usageExhausted'],
    [{ code: -32603, message: 'Internal error', data: `Grok Build usage balance exhausted ${secret}` }, 'usageExhausted'],
    [{ code: -32603, message: 'Internal error', data: { details: `Grok Build usage balance exhausted ${secret}` } }, 'usageExhausted'],
    [{ code: -32000, message: secret, data: { error: { message: `quota exceeded ${secret}` } } }, 'usageExhausted'],
    [{ code: -32000, message: `API error (status 402 Payment Required): ${secret}` }, 'paymentRequired'],
    [{ code: -32000, message: secret, data: { statusCode: 402 } }, 'paymentRequired'],
    [{ code: -32000, message: secret, data: { httpStatus: 402 } }, 'paymentRequired'],
    [{ code: -32000, message: `rate limit exceeded ${secret}` }, 'rateLimited'],
    [{ code: -32000, message: secret, data: { status: 429 } }, 'rateLimited'],
    [{ code: -32042, message: secret, data: { token: secret } }, null],
    [{ code: -32601, message: 'Method not found' }, null],
    [{ code: -32002, message: secret }, null],
    [{ code: 1e21, message: secret }, null],
  ];
  try {
    for (const locale of ['ja', 'en']) {
      setLocale(locale);
      for (const [Client, agent] of [[GrokAcp, 'Grok'], [DevinAcp, 'Devin']]) {
        const client = new Client({ timeoutMs: 0 });
        client.proc = { stdin: { writable: true, write() {} } };
        for (const [error, key] of cases) {
          const pending = client.call('session/prompt', { prompt: [{ type: 'text', text: secret }] });
          client.reader.push(Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: `pleiad-${client.nextId}`, error }) + '\n'));
          await assert.rejects(pending, result => {
            assert.equal(result.message, key ? translate(`acp.errors.${key}`, { agent }) : `${agent} ACP request failed`);
            assert.equal(result.code, Number.isSafeInteger(error.code) ? error.code : -32000);
            assert.equal(Object.hasOwn(result, 'data'), false);
            assert.equal(result.message.includes(secret), false);
            assert.equal(JSON.stringify(result).includes(secret), false);
            return true;
          });
          assert.equal(client.pending.size, 0);
        }
        t.ok(`${agent} ${locale}: provider limits are localized and unknown failures stay private`, true);
      }
    }
  } finally { setLocale(previousLocale); }

  const now = 1_792_425_600_000;
  const retryable = { 'cognition.ai/errorKind': 'unavailable', 'cognition.ai/retryable': true };
  const rateMsg = 'Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in 12 seconds (at 15:58 UTC). (trace ID: 0000)';
  assert.deepEqual(acpTurnLimit({ code: -32010, message: rateMsg, data: retryable }, now), { resetsAt: now + 12_000 });
  t.ok('retryable + 既知の rate limit 文言 + 相対秒数 → 受信時刻+秒数の有限 resetsAt', true);

  // 実機の文面（Issue #111。2026-10-20〜21 のログに出た形: N seconds・N second・N minute・N minutes・N hours N minutes）
  const real = (span, at) => ({ code: -32010, data: retryable,
    message: `Reached free model rate limit. Upgrade to Max for higher limits, or switch to a different model. Your limit will reset in ${span} (at ${at} UTC). (trace ID: 0000)` });
  // now は 16:00:00 UTC。併記の時刻は分に切り上がっている
  assert.deepEqual(acpTurnLimit(real('1 second', '16:01'), now), { resetsAt: now + 60_000 });
  assert.deepEqual(acpTurnLimit(real('45 seconds', '16:01'), now), { resetsAt: now + 60_000 });
  t.ok('秒の形（second・seconds）は limited。分に切り上がった併記の時刻（2 分以内）の方が遅ければそちら', true);
  assert.deepEqual(acpTurnLimit(real('1 minute', '16:01'), now), { resetsAt: now + 60_000 });
  assert.deepEqual(acpTurnLimit(real('3 minutes', '16:03'), now), { resetsAt: now + 180_000 });
  t.ok('分の形（minute・minutes）も limited で、解除の見込みを残す', true);
  assert.deepEqual(acpTurnLimit(real('10 hours 50 minutes', '02:50'), now), { resetsAt: now + (10 * 60 + 50) * 60_000 });
  assert.deepEqual(acpTurnLimit(real('2 hours, 1 minute and 5 seconds', '18:02'), now), { resetsAt: Date.UTC(2026, 9, 19, 18, 2) });
  t.ok('時と分の組み合わせ（10 hours 50 minutes）も limited（600 秒を超える見込みを捨てない）', true);
  assert.deepEqual(acpTurnLimit(real('0 seconds', '16:00'), now), { resetsAt: now + 1000 });
  t.ok('0 seconds も limited（過去の時刻にせず、少し先にする）', true);
  const timeOnly = msg => ({ code: -32010, data: retryable, message: msg });
  assert.deepEqual(acpTurnLimit(timeOnly('Reached free model rate limit. Your limit will reset at 18:01 UTC.'), now), { resetsAt: Date.UTC(2026, 9, 19, 18, 1) });
  assert.deepEqual(acpTurnLimit(timeOnly('Reached free model rate limit. Your limit will reset at 09:30 UTC.'), now), { resetsAt: Date.UTC(2026, 9, 20, 9, 30) });
  t.ok('時刻だけの形（at HH:MM UTC）も読む。今より前の時刻は翌日', true);
  assert.deepEqual(acpTurnLimit(real('12 seconds', '23:59'), now), { resetsAt: now + 12_000 });
  t.ok('相対の見込みと大きく離れた併記の時刻（時計・日付の食い違い）は採らない', true);

  assert.deepEqual(acpTurnLimit({ code: -32010, message: 'Reached free model rate limit. Your limit will reset soon.', data: retryable }, now), { resetsAt: null });
  t.ok('解除の見込みが読めない rate limit も limited（resetsAt: null。error にすると枠が止まらず、自動の振り分けが選び直す）', true);
  assert.equal(acpTurnLimit({ code: -32010, message: rateMsg, data: { 'cognition.ai/errorKind': 'unavailable' } }, now), null);
  assert.equal(acpTurnLimit({ code: -32010, message: rateMsg }, now), null);
  t.ok('provider の retryable 印が無い同じ文言は対象外', true);
  assert.equal(acpTurnLimit({ code: -32010, message: 'Internal error', data: retryable }, now), null);
  t.ok('retryable でも rate limit でない文言は対象外', true);
  assert.deepEqual(acpTurnLimit({ code: -32010, message: 'reset in 99999999999999999999 seconds rate limit', data: retryable }, now), { resetsAt: now + 24 * 3600_000 });
  assert.deepEqual(acpTurnLimit({ code: -32010, message: 'rate limit reset in 3 days', data: retryable }, now), { resetsAt: now + 24 * 3600_000 });
  t.ok('桁あふれ・1 日を超える見込みは 1 日で切る（枠を何日も外さない）', true);
  assert.equal(acpTurnLimit({ code: -32010, message: rateMsg, data: retryable }, Number.NaN), null);
  assert.equal(acpTurnLimit({ code: -32010, message: rateMsg, data: { 'cognition.ai/retryable': 'true' } }, now), null);
  assert.equal(acpTurnLimit({ code: -32010, message: rateMsg, data: 'x' }, now), null);
  assert.equal(acpTurnLimit({ code: -32010, message: rateMsg, data: retryable }, 8640000000000000), null);
  assert.equal(acpTurnLimit({ code: -32010, message: rateMsg, data: retryable }, -Number.MAX_SAFE_INTEGER), null);
  const finite = acpTurnLimit({ code: -32010, message: rateMsg, data: retryable }, now);
  t.ok('無効な now・文字列の "true"・非オブジェクト data を退け、受理したものは有限の safe integer', Number.isSafeInteger(finite.resetsAt));
}
