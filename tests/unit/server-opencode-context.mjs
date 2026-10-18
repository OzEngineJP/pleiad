// OpenCode に Pleiad が担当するコンテキスト（指示・Skills・外部 MCP の中継。ply_context）を渡す（core/backends/opencode-context.mjs・opencode.mjs）。
// 本物の OpenCode は使わない（tests/lib/fake-opencode.mjs。止め方の環境変数と、写した設定の置き場・渡し直した作業場所の設定を書き残させる）。
// 本物の OpenCode がそれで指示・Skills・MCP を読まなくなることは、モデルへ送った要求を受けて確かめた（docs/multi-backend.md §2.10「Pleiad 担当のコンテキスト」）。
//   - エージェント任せの会話は共有のサーバー。Pleiad が担当するターンは、そのターンだけ専用のサーバーを起こし、終わったら止める
//   - 専用のサーバー: 作業場所の設定を止め、設定の置き場は写したもの（担当の種類の AGENTS.md・skills・mcp を外す）。担当の種類に合わせて止め方の環境変数を足す
//   - 指示と Skills の一覧は system に入り、ply_context のツール（Skill の本文・外部 MCP）を中継の口から呼べる
//   - 担当の組み合わせ: エージェントに任せる指示ファイル・.opencode の Skills は絶対パスで渡し直す。MCP を任せれば作業場所の mcp を渡し直す
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import { parseJsonc, mergeConfig, stripOwned } from '../../core/backends/opencode-context.mjs';

export const name = 'server-opencode-context';
export const title = 'OpenCode に Pleiad のコンテキスト（指示・Skills・外部 MCP）を、そのターンだけの専用のサーバーで渡す';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

export default async function (t) {
  // ---- 部品（純粋な関数）
  t.ok('JSONC: コメントと末尾のカンマを許し、文字列の中の // は残す', JSON.stringify(parseJsonc('{\n  // c\n  "a": "x//y", /* b */ "b": [1, 2,],\n}')) === JSON.stringify({ a: 'x//y', b: [1, 2] }));
  t.ok('設定の合わせ方: オブジェクトは深く、plugin・instructions は足し、ほかは後ろが勝つ',
    JSON.stringify(mergeConfig({ mcp: { a: { enabled: true } }, instructions: ['x'], model: 'm1' }, { mcp: { b: {} }, instructions: ['y'], model: 'm2' })) === JSON.stringify({ mcp: { a: { enabled: true }, b: {} }, instructions: ['x', 'y'], model: 'm2' }));
  t.ok('担当の種類のキーだけを外す', JSON.stringify(stripOwned({ instructions: [], mcp: {}, skills: {}, provider: {} }, { instruction: 'ply', skill: 'native', mcp: 'ply' })) === JSON.stringify({ skills: {}, provider: {} }));

  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-oc-context-')));
  const cwd = path.join(tmp, 'repo'), dataDir = path.join(tmp, 'data'), cfg = path.join(tmp, 'cfg');
  const launchFile = path.join(tmp, 'launches.jsonl');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  const launches = async () => (await fs.readFile(launchFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const text = (r) => r.events.filter((e) => e.type === 'text.delta' && e.sessionId === r.sessionId).map((e) => e.text).join('');
  let host, client;
  try {
    const fixture = path.join(tmp, 'fixture.mjs');
    await write(fixture, `import readline from 'node:readline';for await(const line of readline.createInterface({input:process.stdin})){const m=JSON.parse(line);if(m.id===undefined)continue;const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'Echo',inputSchema:{type:'object'}}]}:m.method==='tools/call'?{content:[{type:'text',text:'echo:'+(process.env.API_KEY||'none')}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}`);
    // 作業場所: 指示・Skills・MCP と、設定の instructions
    await fs.mkdir(path.join(cwd, '.git'), { recursive: true });
    await write(path.join(cwd, 'AGENTS.md'), '# Rules\n\nThe project codeword is PROJECT-RULE-OC.\n');
    await write(path.join(cwd, 'extra.md'), 'EXTRA-RULE\n');
    await write(path.join(cwd, 'opencode.json'), JSON.stringify({ instructions: ['extra.md'], mcp: { projmcp: { type: 'local', command: ['node', 'x.js'], enabled: false } } }));
    await write(path.join(cwd, '.opencode', 'skills', 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill for the opencode test\n---\n\nDEMO-SKILL-BODY\n');
    // 全体の設定の置き場（XDG_CONFIG_HOME/opencode）: 指示・Skills・MCP と、残すべき接続先の設定・エージェントのフォルダー
    await write(path.join(cfg, 'opencode', 'AGENTS.md'), 'GLOBAL-RULE\n');
    await write(path.join(cfg, 'opencode', 'opencode.jsonc'), '{\n  // the user config\n  "mcp": { "globalmcp": { "type": "remote", "url": "http://127.0.0.1:1/x" } },\n  "provider": { "myprov": { "name": "Mine" } },\n}\n');
    await write(path.join(cfg, 'opencode', 'skills', 'gs', 'SKILL.md'), '---\nname: gs\ndescription: global skill\n---\nGS\n');
    await write(path.join(cfg, 'opencode', 'agent', 'reviewer.md'), 'REVIEWER\n');

    host = await startServer({ dataDir, timeoutMs: 40_000, env: {
      AGENT_HOST_BACKENDS: 'opencode', AGENT_HOST_OPENCODE_BIN: `node "${path.join(ROOT, 'tests', 'lib', 'fake-opencode.mjs')}"`,
      AGENT_HOST_OPENCODE_DATA: path.join(tmp, 'oc-data'), FAKE_OPENCODE_LAUNCH_FILE: launchFile, XDG_CONFIG_HOME: cfg,
      // 共有のサーバーと専用のサーバーで会話を分け合う（本物は同じ DB）
      FAKE_OPENCODE_STATE_DIR: path.join(tmp, 'oc-state'),
    } });
    client = await open({ ...host, autoAllow: true });
    const [backend] = await client.cmd('backends');
    t.ok('能力: ply_context をターンごとの口で受ける', backend.capabilities.plyContext === 'turn', JSON.stringify(backend.capabilities.plyContext));

    // エージェント任せの会話は共有のサーバー
    const plain = await client.runTurn({ backend: 'opencode', cwd, prompt: 'show-system', mode: 'full', model: 'fake/echo' }, { ms: 60_000 });
    const sessionId = plain.sessionId;
    const shared = (await launches())[0];
    t.ok('エージェント任せ: 共有のサーバーで、止め方の環境変数は無い', plain.outcome === 'ok' && (await launches()).length === 1 && Object.keys(shared.flags).length === 0 && shared.xdg === cfg, JSON.stringify(shared));
    t.ok('エージェント任せ: Pleiad の指示に OpenCode のコンテキストは入れない', !text(plain).includes('PROJECT-RULE-OC'));

    // 担当はすべて Pleiad（この場所の上書き。探すのは共通の形（作業場所の AGENTS.md）と OpenCode の形。外部 MCP は Pleiad の登録も）
    await client.cmd('savePlyMcp', { name: 'fixture', mode: 'add', value: { transport: 'stdio', command: process.execPath, args: [fixture], env: { API_KEY: 'OC_ENV_SECRET' } } });
    for (const kind of ['instruction', 'skill', 'mcp']) await client.cmd('setContextSettings', { cwd, place: cwd, kind,
      value: { owner: 'ply', user: kind === 'mcp' ? { sources: [], excludePaths: [] } : null, directory: { sources: ['common', 'opencode'], excludePaths: [] } } });
    const managed = await client.runTurn({ sessionId, prompt: 'show-system', mode: 'full' }, { ms: 60_000 });
    const body = text(managed);
    t.ok('Pleiad の担当: 指示と Skills の一覧が system に入る', managed.outcome === 'ok' && body.includes('PROJECT-RULE-OC') && /demo: Demo skill for the opencode test/.test(body), body);
    const dedicated = (await launches()).at(-1);
    for (let n = 0; n < 200 && alive(dedicated.pid); n++) await new Promise((r) => setTimeout(r, 50));
    t.ok('Pleiad の担当: そのターンだけ専用のサーバーを起こし、終わったら止める（共有のサーバーは残る）', (await launches()).length === 2 && dedicated.pid !== shared.pid && !alive(dedicated.pid) && alive(shared.pid), JSON.stringify({ dedicated: dedicated.pid, shared: shared.pid }));
    t.ok('専用のサーバー: 作業場所の設定と Claude の指示・外の Skills を止める', dedicated.flags.OPENCODE_DISABLE_PROJECT_CONFIG === '1' && dedicated.flags.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT === '1'
      && dedicated.flags.OPENCODE_DISABLE_EXTERNAL_SKILLS === '1' && dedicated.flags.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS === '1', JSON.stringify(dedicated.flags));
    const mirror = path.join(dedicated.xdg, 'opencode');
    const mirrored = await fs.readdir(mirror);
    const mirroredConfig = JSON.parse(await fs.readFile(path.join(mirror, 'opencode.jsonc'), 'utf8'));
    t.ok('写した置き場: データ置き場の中で、AGENTS.md と skills を置かず、設定から mcp を外し、接続先とエージェントのフォルダーは残す',
      path.relative(path.join(dataDir, 'opencode', 'managed'), dedicated.xdg).split(path.sep).length === 1 && !mirrored.includes('AGENTS.md') && !mirrored.includes('skills')
      && mirrored.includes('agent') && !mirroredConfig.mcp && mirroredConfig.provider?.myprov?.name === 'Mine', JSON.stringify({ mirrored, mirroredConfig }));
    t.ok('写した置き場: フォルダーは junction（中身を写さない）', (await fs.lstat(path.join(mirror, 'agent'))).isSymbolicLink() && (await fs.readFile(path.join(mirror, 'agent', 'reviewer.md'), 'utf8')) === 'REVIEWER\n');
    t.ok('専用のサーバー: 作業場所の設定は、担当の種類（指示・MCP）を外して渡し直す', !dedicated.config.mcp && !dedicated.config.instructions && !dedicated.config.skills && dedicated.config.autoupdate === false
      && dedicated.config.plugin?.length === 1, JSON.stringify(dedicated.config));

    const skillId = /demo: Demo skill for the opencode test（id: ([^、]+)、/.exec(body)?.[1];
    const skill = await client.runTurn({ sessionId, prompt: `mcp:${JSON.stringify({ server: 'ply_context', tool: 'load_skill', arguments: { id: skillId } })}`, mode: 'full' }, { ms: 60_000 });
    t.ok('ply_context のツールを中継の口から呼べる（Skill の本文）', skill.outcome === 'ok' && skill.events.some((e) => e.type === 'tool.result' && String(e.text).includes('DEMO-SKILL-BODY')),
      JSON.stringify(skill.events.filter((e) => e.type === 'tool.result')).slice(0, 400));
    const record = await client.cmd('sessionContext', { sessionId });
    const row = record?.report?.entries?.find((e) => e.name === 'fixture');
    t.ok('会話の記録に Pleiad 担当として残る（外部 MCP は接続済み）', record?.report?.status === 'ready' && !record.report.guardedBackend && row?.status === 'connected',
      JSON.stringify({ status: record?.report?.status, guarded: record?.report?.guardedBackend, reason: record?.report?.reason, row }));

    // 担当の組み合わせ: 指示と MCP はエージェント、Skills だけ Pleiad
    for (const kind of ['instruction', 'mcp']) await client.cmd('setContextSettings', { cwd, place: cwd, kind, value: { owner: 'native', user: null, directory: null } });
    const mixed = await client.runTurn({ sessionId, prompt: 'show-system', mode: 'full' }, { ms: 60_000 });
    const m = (await launches()).at(-1);
    const instructions = (m.config.instructions ?? []).map((p) => path.resolve(p));
    t.ok('組み合わせ: エージェントに任せる指示は、作業場所の指示ファイルと設定の instructions を絶対パスで渡し直す', mixed.outcome === 'ok'
      && instructions.includes(path.join(cwd, 'AGENTS.md')) && instructions.includes(path.join(cwd, 'extra.md')) && !m.flags.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT, JSON.stringify(m));
    t.ok('組み合わせ: MCP を任せれば作業場所の mcp を渡し直し、Skills の担当は外の Skills を止める', m.config.mcp?.projmcp?.command?.[1] === 'x.js' && m.flags.OPENCODE_DISABLE_EXTERNAL_SKILLS === '1' && !m.config.skills, JSON.stringify(m.config));
    const mirrored2 = await fs.readdir(path.join(m.xdg, 'opencode'));
    const config2 = JSON.parse(await fs.readFile(path.join(m.xdg, 'opencode', 'opencode.jsonc'), 'utf8'));
    t.ok('組み合わせ: 写した置き場に全体の AGENTS.md と mcp を残し、skills は置かない', mirrored2.includes('AGENTS.md') && !mirrored2.includes('skills') && Boolean(config2.mcp?.globalmcp), JSON.stringify({ mirrored2, config2 }));

    // 指示だけ Pleiad: .opencode の Skills は skills.paths で渡し直す
    await client.cmd('setContextSettings', { cwd, place: cwd, kind: 'instruction', value: { owner: 'ply', user: null, directory: { sources: ['common', 'opencode'], excludePaths: [] } } });
    await client.cmd('setContextSettings', { cwd, place: cwd, kind: 'skill', value: { owner: 'native', user: null, directory: null } });
    await client.runTurn({ sessionId, prompt: 'show-system', mode: 'full' }, { ms: 60_000 });
    const i = (await launches()).at(-1);
    t.ok('組み合わせ: Skills を任せれば .opencode の Skills を skills.paths で渡し直し、外の Skills は止めない', (i.config.skills?.paths ?? []).map((p) => path.resolve(p)).includes(path.join(cwd, '.opencode', 'skills'))
      && !i.flags.OPENCODE_DISABLE_EXTERNAL_SKILLS && i.flags.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT === '1' && (await fs.readdir(path.join(i.xdg, 'opencode'))).includes('skills'), JSON.stringify(i));
    // プロセスが消えるまでには少し間がある（Linux）。決め打ちで待たず、消えるまで待つ（上限 10 秒）
    const gone = async () => (await launches()).slice(1).every((x) => !alive(x.pid));
    for (let n = 0; n < 200 && !(await gone()); n++) await new Promise((r) => setTimeout(r, 50));
    t.ok('どのターンの後も、専用のサーバーは残らない', await gone());
  } finally {
    client?.close(); await host?.stop();
    for (const x of await launches()) if (alive(x.pid)) { try { process.kill(x.pid); } catch { /* 終わっている */ } }
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
