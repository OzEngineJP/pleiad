// CLI/API にモデルを断られた枠の記録（core/model-rejects.mjs）と、エージェントごとの断りの検出（ADR 0311）
import { createModelRejects, HOLD_MS } from '../../core/model-rejects.mjs';
import { codexModelError } from '../../core/backends/codex-limit.mjs';
import { isClaudeModelError, normalizeSdkMessage } from '../../core/backends/claude-normalize.mjs';

export const name = 'model-rejects';
export const title = 'Model rejections: held for a while per slot, cleared on success or settings change, detected per agent';

export default async function test(t) {
  let clock = 1_800_000_000_000;
  const rejects = createModelRejects({ now: () => clock });
  const rec = rejects.record({ backend: 'codex', model: 'gpt-x', account: null, message: 'model_not_found' });
  t.ok('断られた枠を HOLD_MS（30 分）覚える', rec.until === clock + HOLD_MS && rejects.get('codex', 'gpt-x', null)?.until === clock + HOLD_MS);
  t.ok('別のモデル・別のアカウントの枠には効かない', !rejects.get('codex', 'gpt-y', null) && !rejects.get('codex', 'gpt-x', 'acct'));
  clock += 10 * 60_000;
  rejects.record({ backend: 'codex', model: 'gpt-x', account: null });
  t.ok('また断られたら、そこからもう 30 分', rejects.get('codex', 'gpt-x', null).until === clock + HOLD_MS);
  clock += HOLD_MS + 1;
  t.ok('期限が過ぎれば忘れる', rejects.get('codex', 'gpt-x', null) === null && rejects.list().length === 0);
  rejects.record({ backend: 'claude', model: 'fable', account: 'a' });
  rejects.clear('claude', 'fable', 'a');
  t.ok('同じ枠のターンが通ったら消える', rejects.get('claude', 'fable', 'a') === null);
  rejects.record({ backend: 'claude', model: 'fable', account: null });
  rejects.reset();
  t.ok('設定が変わったら全部忘れる', rejects.list().length === 0);

  t.ok('Codex: model_not_found・「model does not exist」を断りと読む', codexModelError({ message: '400 {"error":{"code":"model_not_found"}}' }) && codexModelError('The model `x` does not exist'));
  t.ok('Codex: 上限・通信の失敗は断りに読まない', !codexModelError('rate limit exceeded') && !codexModelError('ECONNRESET'));
  t.ok('Claude: 断りの文面を読む', isClaudeModelError("There's an issue with the selected model (x). It may not exist or you may not have access to it.") && !isClaudeModelError('Invalid API key'));
  const marks = normalizeSdkMessage({ type: 'result', subtype: 'success', is_error: true, api_error_status: 404, result: 'There is an issue with the selected model' });
  t.ok('Claude: 404 の is_error の result に modelRejected の印を付ける', marks.some(e => e.type === 'modelRejected'), JSON.stringify(marks));
}
