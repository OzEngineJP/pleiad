// OpenCode の上限と再試行の待ち（ADR 0229）の部品: session.status の retry の読み方（retryOf）・エラーの解除時刻（errorOf）・
// 出来事の写し替え（retrying / running・待っても通らない上限）・振り分けで上限に当たっている委譲先を外して戻す（checkCandidate・route の blocked）
import { createTurnMapper, retryOf, errorOf } from '../../core/backends/opencode-normalize.mjs';
import { checkBackendEvent } from '../../core/backends/contract.mjs';
import { normalizeSettings, checkCandidate, route, candidateStates } from '../../core/delegation-routing.mjs';

export const name = 'opencode-retry';
export const title = 'OpenCode の上限と再試行の待ち: retry の読み方・解除時刻・写し替え・振り分けで外して戻す';

const NOW = Date.parse('2026-10-18T11:00:00Z');

export default async function (t) {
  // ---- retryOf: OpenCode 1.19.3 で確かめた形 { type: 'retry', attempt, message, action?, next }
  const free = retryOf({ type: 'retry', attempt: 1, message: 'Free usage exceeded, subscribe to Go', action: { reason: 'free_tier_limit' }, next: NOW + 60_000 });
  t.ok('retryOf: Free の上限（free_tier_limit）は待っても通らない上限。解除時刻は分からない',
    free.definite && free.limit && free.reason === 'free_tier_limit' && free.resetsAt === null && free.attempt === 1 && free.next === NOW + 60_000, JSON.stringify(free));
  const go = retryOf({ type: 'retry', attempt: 2, message: 'Weekly usage limit reached', action: { reason: 'account_rate_limit' }, next: NOW + 3 * 3600_000 });
  t.ok('retryOf: Go の枠（account_rate_limit）は next が解ける時刻', go.definite && go.limit && go.resetsAt === NOW + 3 * 3600_000, JSON.stringify(go));
  const rate = retryOf({ type: 'retry', attempt: 3, message: 'Rate limit exceeded', next: NOW + 420_000 });
  t.ok('retryOf: 曖昧な 429（Rate limit exceeded）は上限による待ちだが、止めない', rate.limit && !rate.definite && rate.resetsAt === null, JSON.stringify(rate));
  const overloaded = retryOf({ type: 'retry', attempt: 1, message: 'Provider is overloaded', next: NOW + 2_400 });
  t.ok('retryOf: 混雑・5xx の再試行は上限ではない', !overloaded.limit && !overloaded.definite);
  const balance = retryOf({ type: 'retry', attempt: 1, message: 'Insufficient balance on your account' });
  t.ok('retryOf: action の無い残高不足も待っても通らない上限。next が無ければ null', balance.definite && balance.next === null && balance.attempt === 1);
  t.ok('retryOf: 本文は 300 字で切る', retryOf({ type: 'retry', message: 'x'.repeat(1000) }).message.length === 300);

  // ---- errorOf: 解除時刻は epoch ms（文字列の ISO は server が読めない）
  const err429 = errorOf({ name: 'APIError', data: { message: 'Rate limit exceeded', statusCode: 429, responseHeaders: { 'Retry-After': '30' } } }, NOW);
  t.ok('errorOf: 429 は limited で、retry-after から解除時刻（ms）', err429.limited && err429.resetsAt === NOW + 30_000, JSON.stringify(err429));
  const errBody = errorOf({ name: 'APIError', data: { message: 'quota', statusCode: 429, responseBody: JSON.stringify({ error: { resets_at: '2026-10-18T12:00:00Z' } }) } }, NOW);
  t.ok('errorOf: 本文の resets_at を ms に', errBody.resetsAt === Date.parse('2026-10-18T12:00:00Z'), JSON.stringify(errBody));
  const err500 = errorOf({ name: 'APIError', data: { message: 'boom', statusCode: 500 } }, NOW);
  t.ok('errorOf: 5xx は limited でなく、解除時刻も無い', !err500.limited && !('resetsAt' in err500));

  // ---- 出来事の写し替え: retry → activity retrying、続く busy → running。待っても通らない上限は limit に覚える
  const out = [];
  const mapper = createTurnMapper({ sessionId: 's', emit: e => out.push(e) });
  const status = st => mapper.handle({ type: 'session.status', properties: { sessionID: 's', status: st } });
  status({ type: 'busy' });
  t.ok('写し替え: 再試行の前の busy では何も出さない', out.length === 0 && mapper.retrying === null);
  status({ type: 'retry', attempt: 1, message: 'Rate limit exceeded', next: NOW + 2_400 });
  const first = out.at(-1);
  t.ok('写し替え: retry は activity retrying（回数・次の時刻・理由・上限か）', first?.type === 'activity' && first.state === 'retrying'
    && first.retry.attempt === 1 && first.retry.next === NOW + 2_400 && first.retry.limit === true && first.retry.reason === null, JSON.stringify(first));
  t.ok('写し替え: 曖昧な 429 は limit を覚えない（OpenCode の再試行に任せる）', mapper.retrying?.attempt === 1 && mapper.limit === null);
  status({ type: 'busy' });
  t.ok('写し替え: 再試行が始まった busy で running に戻す', out.at(-1)?.type === 'activity' && out.at(-1).state === 'running' && mapper.retrying === null);
  status({ type: 'busy' });
  t.ok('写し替え: 待ちの無い busy では running を重ねない', out.filter(e => e.state === 'running').length === 1);
  status({ type: 'retry', attempt: 2, message: 'Weekly usage limit reached', action: { reason: 'account_rate_limit' }, next: NOW + 3600_000 });
  t.ok('写し替え: 待っても通らない上限は limit に覚える（呼ぶ側がターンを止める）', mapper.limit?.definite === true && mapper.limit.resetsAt === NOW + 3600_000);
  status({ type: 'retry', attempt: 3, message: 'Rate limit exceeded', next: NOW + 9_000 });
  t.ok('写し替え: 最初に覚えた上限は後の曖昧な待ちで上書きしない', mapper.limit?.reason === 'account_rate_limit');
  t.ok('写し替え: 出したイベントはどれも契約どおり', out.every(e => checkBackendEvent(e) === null), out.map(e => checkBackendEvent(e)).filter(Boolean).join(' / '));
  t.ok('契約: turnResult limited は resetsAt（数）を持てる', checkBackendEvent({ type: 'turnResult', outcome: 'limited', resetsAt: NOW }) === null);

  // ---- 振り分け: 上限に当たっている委譲先を外し、戻れば選び直す
  const settings = normalizeSettings({ tiers: { t1: ['opencode:big-pickle', 'claude:haiku'], t2: ['opencode:big-pickle', 'claude:haiku'], t3: ['opencode:big-pickle', 'claude:haiku'], t4: ['opencode:big-pickle', 'claude:haiku'] } });
  const usage = {
    opencode: { available: true, checkedAt: NOW - 60_000, windows: [], models: { 'big-pickle': true } },
    claude: { available: true, checkedAt: NOW - 60_000, windows: [], models: { haiku: true },
      accounts: [{ account: '', label: 'login', runnable: true, identity: { org: 'o', email: 'a@example.com' }, windows: [] }] },
  };
  const until = NOW + 600_000;
  const slots = new Map();
  const blocked = (backend, model, account) => slots.get(`${backend}:${model}:${account ?? ''}`) ?? null;
  const checkOpen = checkCandidate('opencode:big-pickle', { usage, settings, now: NOW, blocked });
  t.ok('振り分け: 塞がっていなければ使える', checkOpen.ok === true, JSON.stringify(checkOpen));
  slots.set('opencode:big-pickle:', { reason: 'retry_waiting', until });
  const held = checkCandidate('opencode:big-pickle', { usage, settings, now: NOW, blocked });
  t.ok('振り分け: 再試行を待っている委譲先は外す（理由と戻る見込み）', held.ok === false && held.reason === 'retry_waiting' && held.until === until, JSON.stringify(held));
  const judged = { judge: 'jev', signals: null, probabilities: null, fallback: null };
  const routed = route({ kind: 'implement', judged, settings, usage, now: NOW, blocked });
  const skip = routed.routing.skipped.find(s => s.candidate === 'opencode:big-pickle');
  t.ok('振り分け: route は次の候補を選び、skipped に理由と until（ISO）を載せる', routed.ok && routed.routing.target.backend === 'claude'
    && skip?.reason === 'retry_waiting' && skip.until === new Date(until).toISOString(), JSON.stringify(routed.routing));
  slots.set('opencode:big-pickle:', { reason: 'recently_limited' });
  const states = candidateStates({ settings, usage, now: NOW, blocked });
  const state = states.find(s => s.candidate === 'opencode:big-pickle');
  t.ok('振り分け: 設定画面の候補の状態にも理由が出る（時刻が分からなければ until は無い）', state?.usable === false && state.reason === 'recently_limited' && !('until' in state), JSON.stringify(state));
  slots.set('claude:haiku:', { reason: 'recently_limited', until });
  const claudeHeld = checkCandidate('claude:haiku', { usage, settings, now: NOW, blocked });
  t.ok('振り分け: アカウントごとの委譲先は、塞がったアカウントの行に理由を付けて外す', claudeHeld.ok === false && claudeHeld.reason === 'recently_limited'
    && claudeHeld.accounts?.[0]?.reason === 'recently_limited' && claudeHeld.accounts[0].until === until, JSON.stringify(claudeHeld));
  slots.clear();
  const back = route({ kind: 'implement', judged, settings, usage, now: NOW, blocked });
  t.ok('振り分け: 塞がりが解ければ元の候補を選び直す', back.ok && back.routing.target.backend === 'opencode' && !back.routing.skipped.some(s => s.reason === 'retry_waiting' || s.reason === 'recently_limited'), JSON.stringify(back.routing.target));
}
