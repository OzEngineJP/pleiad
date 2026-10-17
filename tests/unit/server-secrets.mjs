// 秘密情報と変数をサーバー越しに（fake バックエンド。LLM は呼ばない。ADR 0215）:
//   - 画面（人）の操作: secrets.save・secrets.list・secrets.import。一覧・返り・イベントに秘密の値が出ない
//   - ターンのシェルへ渡す: 次のターンから環境変数として渡り、一覧の文は名前だけ。エージェントが値を表示しても、画面へ出る前に伏せる（履歴の読み直しも）
//   - 入力欄の `!` の行にも同じ値が渡り、出力の秘密の値は伏せる
//   - AI の操作（ply_control）: 一覧は値なし・変数は書ける・人の操作（secrets.save）は見えない・AI が作った値は承認カード・入力のカード（secrets.request）
//   - 入力のカード: 待たずに返る → カード（値は載せない）→ 人が保存 → 項目ができ、保存した名前だけが会話へ届く。カードの「許可」では保存にならない
//   - サイトでの入力（core/secret-fill.mjs）: origin が合うときだけ Input.insertText で入れる。返りに値は無い
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { hostShell } from '../../core/host-shell.mjs';
import { createSecretFill } from '../../core/secret-fill.mjs';
import { createSecrets } from '../../core/secrets.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';

export const name = 'server-secrets';
export const title = '秘密情報と変数をサーバー越しに: 操作と権限・ターンのシェルへ渡す・画面へ出る前に伏せる・`!` の行・入力のカード・サイトでの入力';

const TOKEN = 'tok-' + 'q'.repeat(28);
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-host-secrets-srv-')));
  const repo = path.join(scratch, 'repo');
  await fs.mkdir(repo, { recursive: true });
  const server = await startServer({ env: { AGENT_HOST_BACKENDS: 'fake' }, dataDir: path.join(scratch, 'data'), timeoutMs: 60_000 });
  const c = await open({ port: server.port, token: server.token });
  const raw = [];
  c.ws.on('message', (data) => raw.push(data.toString()));
  const invoke = (op, args = {}) => c.cmd('invoke', { op, args });
  const control = (op, args = {}) => `control:${JSON.stringify({ name: 'call_op', arguments: { op, args } })}`;
  const toolText = (r) => r.events.filter((e) => e.type === 'tool.result').map((e) => e.text).join('\n');
  try {
    // ---- 画面（人）の操作
    const v = await invoke('secrets.save', { kind: 'var', label: 'NODE_ENV', value: 'development', env: { name: 'NODE_ENV', scope: 'all' } });
    const s = await invoke('secrets.save', { kind: 'secret', label: 'API_TOKEN', value: TOKEN, env: { name: 'API_TOKEN', scope: { folders: [repo] } }, note: '試験用' });
    const listed = await invoke('secrets.list');
    t.ok('secrets.save: 登録すると id を返し、一覧（画面）は変数の値だけを持つ（秘密の値は無い）', /^sec-/.test(v.id) && /^sec-/.test(s.id)
      && listed.items.length === 2 && listed.items.find((i) => i.id === v.id).value === 'development' && !JSON.stringify(listed).includes(TOKEN));
    const bad = await rejects(invoke('secrets.save', { kind: 'var', label: 'X', value: 'x', env: { name: 'PLEIAD_CONTROL_URL' } }));
    t.ok('使えない名前は理由つきで断る', bad?.code === 'RESERVED_NAME' || /Pleiad/.test(bad?.message ?? ''), bad?.message);

    // ---- ターンのシェルへ渡す
    const { sessionId } = await c.cmd('newSession', { backend: 'fake', cwd: repo });
    let r = await c.runTurn({ sessionId, prompt: 'secrets-info' });
    const info = JSON.parse(r.events.filter((e) => e.type === 'text.delta').map((e) => e.text).join('') || '{}');
    t.ok('次のターンから、その場所の環境変数として渡る（名前）', JSON.stringify(info.names) === '["API_TOKEN","NODE_ENV"]', JSON.stringify(info));
    t.ok('エージェントへの一覧の文は名前・種類・メモだけで、値は無い', /API_TOKEN（秘密 · 試験用）/.test(info.instructions ?? '') && !String(info.instructions).includes(TOKEN) && !String(info.instructions).includes('development'));
    r = await c.runTurn({ sessionId, prompt: 'secrets-env:API_TOKEN' });
    const said = r.events.filter((e) => e.type === 'text.delta').map((e) => e.text).join('');
    t.ok('エージェントが値を表示しても、画面へ出る前に伏せる', said.includes('value=***') && !raw.some((m) => m.includes(TOKEN)), said);
    const loaded = await c.cmd('loadSession', { sessionId });
    t.ok('開き直した履歴でも伏せる', JSON.stringify(loaded).includes('value=***') && !JSON.stringify(loaded).includes(TOKEN));
    const other = await c.cmd('newSession', { backend: 'fake', cwd: scratch });
    const elsewhere = JSON.parse((await c.runTurn({ sessionId: other.sessionId, prompt: 'secrets-info' })).events.filter((e) => e.type === 'text.delta').map((e) => e.text).join('') || '{}');
    t.ok('フォルダーの値は、そのフォルダーの外の会話には渡らない', JSON.stringify(elsewhere.names) === '["NODE_ENV"]', JSON.stringify(elsewhere));

    // ---- `!` の行
    const sh = hostShell();
    const ref = (n) => (sh?.name === 'powershell' ? `$env:${n}` : `$${n}`);
    const from = c.mark();
    await c.cmd('runShell', { sessionId, runId: 'secrets-shell-0001', command: `echo "v=${ref('NODE_ENV')} s=${ref('API_TOKEN')}"`, cwd: repo });
    await c.waitFor((e) => e.type === 'shell.done' && e.runId === 'secrets-shell-0001', { from, ms: 20_000 });
    const out = c.since(from).filter((e) => e.type === 'shell.output').map((e) => e.text).join('');
    t.ok('`!` の行にも同じ値が渡り、出力の秘密の値は伏せる', out.includes('v=development') && out.includes('s=***') && !raw.some((m) => m.includes(TOKEN)), out);

    // ---- AI の操作（ply_control）
    r = await c.runTurn({ sessionId, prompt: control('secrets.list') });
    t.ok('AI の secrets.list: 名前・種類・メモと変数の値。秘密の値は無い', toolText(r).includes('API_TOKEN') && toolText(r).includes('development') && !toolText(r).includes(TOKEN), toolText(r));
    r = await c.runTurn({ sessionId, prompt: control('secrets.save', { kind: 'secret', label: 'X', value: 'y'.repeat(10), env: { name: 'X' } }) });
    t.ok('AI からは人の操作（secrets.save）が見えない', /NOT_FOUND|見つかりません|not found/i.test(toolText(r)), toolText(r));
    r = await c.runTurn({ sessionId, prompt: control('secrets.setVariable', { name: 'LOG_LEVEL', value: 'debug' }) });
    const afterVar = await invoke('secrets.list');
    t.ok('AI は変数を登録できる（承認なし）', afterVar.items.some((i) => i.env?.name === 'LOG_LEVEL' && i.value === 'debug' && i.by === 'ai'), toolText(r));
    r = await c.runTurn({ sessionId, prompt: control('secrets.create', { kind: 'secret', label: 'Generated', value: 'gen-' + 'z'.repeat(20), env: { name: 'GEN_TOKEN' } }) });
    const card = r.events.find((e) => e.type === 'permission' && e.settingChange?.op === 'secrets.create');
    t.ok('AI が作った値の登録は承認カードを出し、待たずに返る（カードに値は無い）', Boolean(card) && /pending|PENDING/i.test(toolText(r)) && !JSON.stringify(card).includes('z'.repeat(20)), toolText(r));
    const fromAllow = c.mark();
    await c.cmd('resolvePermission', { id: card.id, allow: true, receipt: card.settingChange.receipt });
    await c.waitFor((e) => e.type === 'secretsChanged', { from: fromAllow, ms: 10_000 });
    t.ok('許可すると、AI が登録した印（by: ai）の項目ができる', (await invoke('secrets.list')).items.some((i) => i.label === 'Generated' && i.by === 'ai' && i.kind === 'secret'));
    // 承認の結果を届けるターンが終わるまで待つ
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from: fromAllow, ms: 20_000 });

    // ---- 入力のカード（secrets.request）
    const fromReq = c.mark();
    r = await c.runTurn({ sessionId, prompt: control('secrets.request', { kind: 'secret', name: 'STRIPE_KEY', reason: '決済の試験に使う', scope: 'folder' }) });
    const req = await c.waitFor((e) => e.type === 'permission' && e.secretRequest, { from: fromReq, ms: 10_000 });
    t.ok('secrets.request: 待たずに返り、会話に入力のカード（名前・理由・渡す場所。値は無い）', /PENDING_INPUT|requestId/.test(toolText(r)) && req.secretRequest.name === 'STRIPE_KEY'
      && req.secretRequest.reason === '決済の試験に使う' && req.secretRequest.scope?.folders?.length === 1, JSON.stringify(req.secretRequest));
    const allowed = await rejects(c.cmd('resolvePermission', { id: req.id, allow: true }));
    t.ok('カードの「許可」では保存にならない（値を入れて保存する操作だけ）', allowed?.code === 'SECRET_INPUT_ONLY');
    const SAVED = 'sk_test_' + 'w'.repeat(24);
    const fromAnswer = c.mark();
    const answered = await invoke('secrets.answerRequest', { requestId: req.secretRequest.requestId, value: SAVED });
    const settled = await c.waitFor((e) => e.type === 'settingApproval' && e.requestId === req.secretRequest.requestId, { from: fromAnswer, ms: 10_000 });
    const item = (await invoke('secrets.list')).items.find((i) => i.id === answered.id);
    t.ok('人が保存すると、頼まれた名前・場所の秘密の値ができ、カードが決着する', settled.outcome === 'allowed' && item?.env?.name === 'STRIPE_KEY' && item.kind === 'secret'
      && item.env.scope.folders?.length === 1 && item.note === '決済の試験に使う');
    const notice = await c.waitFor((e) => (e.type === 'taskNotice' || e.type === 'userMessage') && /STRIPE_KEY/.test(e.text ?? '') && /保存/.test(e.text ?? ''), { from: fromAnswer, ms: 20_000 }).catch(() => null);
    t.ok('会話には保存した名前だけが届く（値は無い）', Boolean(notice) && !raw.some((m) => m.includes(SAVED)), notice?.text);
    // 届けたターン（結果を渡す新しいターン）が終わるまで待つ
    await c.waitFor((e) => e.type === 'turnEnd' && e.sessionId === sessionId, { from: fromAnswer, ms: 20_000 });
    const info2 = JSON.parse((await c.runTurn({ sessionId, prompt: 'secrets-info' })).events.filter((e) => e.type === 'text.delta').map((e) => e.text).join('') || '{}');
    t.ok('次のターンから、保存した値も環境変数として渡る', info2.names?.includes('STRIPE_KEY'), JSON.stringify(info2));

    // ---- 消す
    r = await c.runTurn({ sessionId, prompt: control('secrets.delete', { id: s.id }) });
    t.ok('AI が秘密の値を消すのは承認カード', r.events.some((e) => e.type === 'permission' && e.settingChange?.op === 'secrets.delete'), toolText(r));
    await invoke('secrets.delete', { id: s.id });
    t.ok('人は消せる。消したら渡らない', !(await invoke('secrets.list')).items.some((i) => i.id === s.id));
    t.ok('ここまでの全部の画面への送信に、秘密の値が無い', !raw.some((m) => m.includes(TOKEN) || m.includes(SAVED)));
  } finally {
    c.close();
    await server.stop();
  }

  // ---- サイトでの入力（core/secret-fill.mjs）。偽のタブ（CDP の send を記録する）
  const dataDir = path.join(scratch, 'fill');
  const store = createSecrets({ dataDir, values: createSecretStore({ file: path.join(dataDir, 'secret-values.json'), cipher: plainCipher }) });
  await store.init();
  const PW = 'pw-' + 'm'.repeat(16);
  const { id } = await store.create({ kind: 'login', label: 'GitHub', username: 'bot', password: PW, sites: ['github.com'] });
  const page = { origin: 'https://github.com', editable: true, value: '' };
  const sent = [];
  const tab = { async send(method, params) {
    sent.push([method, params]);
    if (method === 'Runtime.evaluate' && /location\.origin/.test(params.expression)) return { result: { value: { origin: page.origin, editable: page.editable, frame: false } } };
    if (method === 'Runtime.evaluate' && /length/.test(params.expression)) return { result: { value: page.value.length } };
    if (method === 'Input.insertText') page.value = params.text;
    return { result: { value: true } };
  }, async detach() {} };
  const fill = createSecretFill({ relay: () => ({ view: { current: () => 'target-1', attach: async () => tab } }), secrets: store });
  const done = await fill('s1', { item: id, field: 'password' }, 'ja');
  t.ok('fill_secret: origin が合えば Input.insertText で入れ、返りは文だけ（値は無い）', done.ok && page.value === PW && !done.text.includes(PW) && /GitHub/.test(done.text));
  t.ok('入力したことを残す', (await store.list()).items.find((i) => i.id === id).lastUse?.site === 'github.com');
  page.origin = 'https://evil.example'; page.value = ''; sent.length = 0;
  const refused = await fill('s1', { item: id, field: 'password' }, 'ja');
  t.ok('origin が合わなければ入れない（値を読まず、insertText を送らない）', !refused.ok && page.value === '' && !sent.some(([m]) => m === 'Input.insertText') && /evil\.example/.test(refused.text));
  page.origin = 'https://github.com'; page.editable = false;
  t.ok('入力欄にフォーカスが無ければ入れない', !(await fill('s1', { item: id, field: 'username' }, 'ja')).ok && page.value === '');
  t.ok('知らない項目・ログイン情報でない項目は断る', !(await fill('s1', { item: 'sec-000000000000', field: 'password' }, 'ja')).ok);
  await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
}
