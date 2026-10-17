// OpenCode の会話で、Pleiad がそろえる Hooks（ADR 0049）を Claude Code の形で走らせる（core/backends/opencode-hooks.mjs）:
// ツールの前（止める・入力を書き換える）・ツールの後（結果に足す）・発言の前（止める）・終わりの前（続けさせる）・発火の記録。
// ツールの前後は身代わりの opencode serve（tests/lib/fake-opencode.mjs）が、Pleiad のプラグインと同じく中継の口の /hook を呼ぶ
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'server-opencode-hooks';
export const title = 'OpenCode: Pleiad がそろえる Hooks を Claude Code の形で走らせる（ツールの前後・発言の前・終わりの前・発火の記録）';

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-opencode-hooks-'));
  const script = async (file, body) => { const p = path.join(tmp, file).replace(/\\/g, '/'); await fs.writeFile(p, body); return p; };
  // Claude の Hooks の約束: stdin に JSON、exit 2 と stderr で止める、stdout の JSON で答える
  const readStdin = "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{const i=JSON.parse(s||'{}');";
  const denyBash = await script('deny.mjs', `${readStdin} if(i.tool_name==='Bash'&&String(i.tool_input?.command).includes('forbidden')){process.stderr.write('no forbidden commands');process.exit(2)} });`);
  const rewrite = await script('rewrite.mjs', `${readStdin} if(i.tool_input?.command==='echo hello')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow',updatedInput:{command:'echo rewritten'}}})); });`);
  const after = await script('after.mjs', `${readStdin} process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:'checked by '+i.tool_name}})); });`);
  const prompt = await script('prompt.mjs', `${readStdin} if(String(i.prompt).includes('secret')){process.stderr.write('do not send secrets');process.exit(2)} });`);
  const stop = await script('stop.mjs', `${readStdin} if(!i.stop_hook_active&&String(i.session_id).startsWith('ses_'))process.stdout.write(JSON.stringify({decision:'block',reason:'please also say goodbye'})); });`);
  const server = await startServer({ dataDir: path.join(tmp, 'data'), timeoutMs: 60_000, env: { AGENT_HOST_BACKENDS: 'opencode', AGENT_HOST_OPENCODE_BIN: `node "${path.join(ROOT, 'tests/lib/fake-opencode.mjs')}"` } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const text = (r) => r.events.filter((e) => e.type === 'text.delta' && e.sessionId === r.sessionId).map((e) => e.text).join('');
  try {
    const save = (value) => c.cmd('savePlyHook', { value: { agent: 'claude', targets: ['opencode'], ...value } });
    const preview = await c.cmd('plyHookPreview', { value: { name: 'p', agent: 'claude', event: 'SessionStart', matcher: '', command: 'x', targets: ['claude', 'opencode'] } });
    t.ok('渡し方の確認: OpenCode には SessionStart も渡せる（Claude の SDK のコールバックの制約は無い）', preview.targets.opencode?.status === 'ok' && preview.targets.claude?.status === 'blocked', JSON.stringify(preview.targets));
    await save({ name: 'deny-bash', event: 'PreToolUse', matcher: 'Bash', command: `node ${denyBash}` });
    await save({ name: 'rewrite', event: 'PreToolUse', matcher: 'Bash', command: `node ${rewrite}` });
    await save({ name: 'after', event: 'PostToolUse', matcher: 'Bash|Edit', command: `node ${after}` });
    await save({ name: 'prompt', event: 'UserPromptSubmit', matcher: '', command: `node ${prompt}` });
    await save({ name: 'stop', event: 'Stop', matcher: '', command: `node ${stop}` });
    await c.cmd('setHooksOwner', { place: null, value: { owner: 'ply', disabled: [] }, revision: (await c.cmd('plyHooks', {})).revision });

    const first = await c.runTurn({ backend: 'opencode', cwd: ROOT, prompt: 'tool please', mode: 'full' }, { ms: 60_000 });
    const sid = first.sessionId;
    const all = text(first);
    t.ok('ツールの前: 書き換えた入力でツールが動く（Claude の updatedInput を OpenCode の形へ戻す）', first.events.some((e) => e.type === 'tool.start' && e.input?.command === 'echo rewritten'), JSON.stringify(first.events.filter((e) => e.type === 'tool.start')));
    t.ok('ツールの後: 足す文脈がツールの結果と返答に入る（ツール名は Claude の形 Bash）', all.includes('checked by Bash'), all);
    t.ok('終わりの前: Stop の Hooks が続けさせた理由を次の発言として渡し、1 回で止まる', all.includes('please also say goodbye') && (all.match(/please also say goodbye/g) ?? []).length === 1, all);
    const panel = await c.cmd('sessionHooks', { sessionId: sid, cwd: ROOT, backend: 'opencode' });
    // 発火の記録（hookRun）は server が会話の記録に集める（画面へは流さない）
    t.ok('発火の記録が Pleiad の登録として会話に残る', panel.runs.some((r) => r.pleiad && r.phase === 'response') && new Set(panel.runs.map((r) => r.name)).size >= 4, JSON.stringify(panel.runs.map((r) => [r.name, r.phase])));
    t.ok('会話の右パネル: Pleiad が渡した分だけ観測でき、渡した登録が会話の記録に残る', panel.observed === 'pleiad' && panel.unify?.supplied?.length === 5 && panel.unify.supplied.every((s) => s.via === 'callback'), JSON.stringify({ observed: panel.observed, supplied: panel.unify?.supplied }));

    const blocked = await c.runTurn({ sessionId: sid, prompt: 'tool forbidden', mode: 'full' }, { ms: 60_000 });
    t.ok('ツールの前: exit 2 の Hooks はツールを止め、理由がツールの失敗としてモデルへ返る', text(blocked).includes('blocked: no forbidden commands')
      && blocked.events.some((e) => e.type === 'tool.result' && e.isError === true && /no forbidden commands/.test(e.text ?? '')), text(blocked));
    const deniedHook = await c.runTurn({ sessionId: sid, prompt: 'send the secret', mode: 'full' }, { ms: 60_000 });
    t.ok('発言の前: UserPromptSubmit が止めたら送らず、理由を返す', deniedHook.outcome === 'error'
      && deniedHook.events.some((e) => e.type === 'turnResult' && /do not send secrets/.test(e.error ?? '')), JSON.stringify(deniedHook.events.filter((e) => e.type === 'turnResult')));
  } finally {
    c.close();
    await server.stop();
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
