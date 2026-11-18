// 作業中に設定を変えた跡の行と、止めたことを見せない仕組み（docs/design-system.md「作業中の設定の変更」・ADR 0341）
//   - 跡の行の文: 「Claude Code から OpenAI Codex に切り替えました」「エフォートを high から xhigh に変えました」「作業の途中で…」
//     止めた・中断の語は使わない。値は太字、エージェントはロゴつき。エージェントの切り替えだけ開くと引き継ぎの説明
//   - 記録の形（settingsChangeLine）: 項目は 4 つだけ、値は短く切る
//   - 設定の変更で止めたときの AI への文（reason="settings"）は見えない行、CLI の中断の行も出さない
//   - 送信待ちの列: 作業中に送ったら予約を効かせる（live は途中送信、stop は待つ、裏だけを待つ間は止めない）
import { N } from '../lib/dom-stub.mjs';
import { settingsTraceText, renderSettingsChangeLine, setSettingsTraceLabels } from '../../web/settings-trace.mjs';
import { settingsChangeLine } from '../../core/history.mjs';
import { classifySystemMessages, splitInterruptionNote } from '../../core/system-messages.mjs';
import { interruptionNote, settingsResumePrompt } from '../../core/interrupt-stops.mjs';
import { createMessageQueue } from '../../core/message-queue.mjs';

export const name = 'settings-trace';
export const title = '作業中の設定の変更: 跡の行の文・記録の形・止めたことを見せない・送ったら予約を効かせる列';


export default async function (t) {
  const oldDoc = globalThis.document;
  const doc = new N('document');
  Object.assign(doc, { createElement: (tag) => new N(tag), createElementNS: (_ns, tag) => new N(tag), createTextNode: (s) => { const n = new N('span'); n.textContent = String(s); return n; }, getElementById: () => null, head: new N('head'), body: new N('body') });
  globalThis.document = doc;
  try {
    setSettingsTraceLabels({
      backend: (id) => ({ claude: 'Claude Code', codex: 'OpenAI Codex' })[id] ?? id,
      model: (id) => ({ 'claude-opus-5-5': 'Opus 5.5' })[id] ?? id,
      mode: (id) => ({ auto: '自動', default: '確認する' })[id] ?? id,
      logo: (id) => Object.assign(new N('span'), { className: `logo-${id}` }),
    });
    const agent = { live: false, changes: [{ field: 'backend', from: 'claude', to: 'codex' }, { field: 'model', from: '', to: 'gpt' }] };
    t.ok('エージェントの切り替えは「A から B に切り替えました」だけ（モデルは言わない）', settingsTraceText(agent) === 'Claude Code から OpenAI Codex に切り替えました', settingsTraceText(agent));
    const effort = { live: false, changes: [{ field: 'effort', from: 'high', to: 'xhigh' }] };
    t.ok('エフォートを変えた行', settingsTraceText(effort) === 'エフォートを high から xhigh に変えました', settingsTraceText(effort));
    const live = { live: true, changes: [{ field: 'model', from: '', to: 'claude-opus-5-5' }, { field: 'mode', from: 'default', to: 'auto' }] };
    t.ok('止めずに切り替えた行は「作業の途中で」、複数の項目は「、」でつなぎ、既定は「既定」', settingsTraceText(live) === '作業の途中でモデルを 既定 から Opus 5.5 に、承認モードを 確認する から 自動 に変えました', settingsTraceText(live));
    const all = [agent, effort, live].map(settingsTraceText).join(' ');
    t.ok('止めた・中断の語を使わない', !/中断|止め/.test(all), all);

    const row = renderSettingsChangeLine({ kind: 'settingsChange', at: '2026-11-18T01:02:03Z', settingsChange: effort });
    const bolds = row.querySelectorAll('b');
    t.ok('値だけ太字（変える前・後）', row.tagName?.toLowerCase?.() === 'div' && bolds.length === 2 && bolds[0].textContent === 'high' && bolds[1].textContent === 'xhigh', row.outerHTML);
    const agentRow = renderSettingsChangeLine({ kind: 'settingsChange', at: '2026-11-18T01:02:03Z', settingsChange: agent });
    t.ok('エージェントの切り替えは開ける行で、値にロゴを添える', agentRow.tagName?.toLowerCase?.() === 'details' && agentRow.querySelector('.logo-codex') !== null && agentRow.querySelector('dl') !== null, agentRow.outerHTML);
    t.ok('開いた中身も中断を言わない', !/中断|止め/.test(agentRow.querySelector('dl')?.textContent ?? ''), agentRow.outerHTML);
  } finally { globalThis.document = oldDoc; }

  // ---- 記録の形
  const line = settingsChangeLine({ live: 'yes', changes: [{ field: 'model', from: '', to: 'x'.repeat(500) }, { field: 'cwd', from: 'a', to: 'b' }, null, { field: 'mode', from: 'default', to: 'auto', extra: 1 }] });
  t.ok('記録は 4 つの項目だけ・live は true のときだけ・値は短く切る',
    line.live === false && line.changes.map((c) => c.field).join() === 'model,mode' && line.changes[0].to.length <= 201 && !('extra' in line.changes[1]), JSON.stringify(line));

  // ---- 止めたことを見せない
  const note = interruptionNote('ja', { tools: [{ key: 'tool:1', tool: 'Bash', target: 'npm test' }] }, 'settings');
  t.ok('設定の変更で止めたときの AI への文は reason="settings" の印で、止めたコマンドの名前はそのまま伝える', note?.hidden === true && note.text.startsWith('<pleiad-interruption reason="settings">') && note.text.includes('npm test'), note?.text);
  const split = splitInterruptionNote(`${note.text}次の発言`);
  t.ok('履歴では見えない印（hidden）になり、続く発言は残る', split?.hidden === true && split.rest === '次の発言', JSON.stringify(split));
  const plain = splitInterruptionNote(interruptionNote('ja', { tools: [{ key: 'tool:1', tool: 'Bash', target: 'x' }] }, 'user').text);
  t.ok('人が止めたときの文は今までどおり見える', plain && !plain.hidden);
  const rows = classifySystemMessages([
    { role: 'user', text: 'slow', uuid: 'u1' },
    { role: 'assistant', text: '...', uuid: 'a1' },
    { role: 'user', text: '[Request interrupted by user]', uuid: 'u2' },
    { role: 'user', text: settingsResumePrompt('ja'), uuid: 'u3' },
    { role: 'user', text: 'again', uuid: 'u4' },
    { role: 'user', text: '[Request interrupted by user]', uuid: 'u5' },
    { role: 'user', text: 'by person', uuid: 'u6' },
  ]);
  const interrupts = rows.filter((m) => m.kind === 'interrupt').map((m) => m.uuid);
  t.ok('設定の変更で止めたときの CLI の中断の行は出さず、人が止めた中断の行は残す', JSON.stringify(interrupts) === JSON.stringify(['u5']), JSON.stringify(rows.map((m) => m.kind ?? m.role)));
  const resume = rows.find((m) => m.kind === 'interruptionNote');
  t.ok('続ける文は見えない行（hidden）', resume?.hidden === true && !rows.some((m) => m.role === 'user' && String(m.text).includes('pleiad-interruption')), JSON.stringify(resume));

  // ---- 送信待ちの列: 作業中に送ったら予約を効かせる
  const data = { s: { nextSettings: { backend: 'fake', model: 'smart' } } };
  const store = { get: async (id) => data[id] ?? {}, getAll: async () => data,
    setSessionData: async (id, field, value) => { (data[id] ??= {})[field] = structuredClone(value); } };
  const steered = [], applied = [];
  let phase = 'active', how = 'live';
  const queue = createMessageQueue({ store,
    active: () => ({ phase, steer: async (item) => { steered.push(item.args.prompt); return true; } }),
    start: () => { throw new Error('must not start'); }, changed: () => {}, delivered: () => {},
    applyReserved: async (id) => { applied.push(id); if (how === 'live') data[id].nextSettings = null; return how; } });
  await queue.accept('s', 'm-1', { prompt: 'live' });
  await queue.kick('s');
  t.ok('その場で効いたら（live）そのまま途中送信する', applied.length >= 1 && JSON.stringify(steered) === '["live"]' && (await queue.list('s'))[0].status === 'sent', JSON.stringify({ applied, steered }));

  data.s.nextSettings = { backend: 'fake', mode: 'auto' };
  how = 'stop';
  await queue.accept('s', 'm-2', { prompt: 'stop' });
  await queue.kick('s');
  const stopped = (await queue.list('s'))[1];
  t.ok('止めたら（stop）途中送信せず、ターンの終わりを待つ（止まったら新しい設定のターンで始める）', applied.length >= 2 && steered.length === 1 && stopped.status === 'queued' && stopped.waiting?.reason === 'turn' && !stopped.waiting.detail, JSON.stringify(stopped));

  how = 'wait';
  await queue.kick('s');
  const held = (await queue.list('s'))[1];
  t.ok('止められない（wait。委譲の子）ときは予約のまま次のターンを待つ', held.waiting?.detail === 'reserved' && steered.length === 1, JSON.stringify(held));

  phase = 'waiting';
  const before = applied.length;
  await queue.kick('s');
  t.ok('返答が終わって裏だけを待つ間（phase: waiting）は止めず、予約を残して途中送信する',
    applied.length === before && (await queue.list('s'))[1].status === 'sent' && steered.at(-1) === 'stop' && data.s.nextSettings?.mode === 'auto', JSON.stringify({ applied, steered, next: data.s.nextSettings }));
}
