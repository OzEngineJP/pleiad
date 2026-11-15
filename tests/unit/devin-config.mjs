import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareDevinLaunch, prepareDevinMcpOff, devinTurnConfig, overlayDevinConfig, METADATA_CONFIG } from '../../core/backends/devin-config.mjs';
import { canLinkMcpOffHome } from '../../core/backends/mcp-off-home.mjs';

export const name = 'devin-config';
export const title = 'Devin native 設定と認証を保ち、metadata と専用セッションの置き場を分ける';
export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-devin-config-'));
  try {
    const cwd = path.join(root, 'project'), configHome = path.join(root, 'user-config');
    await fs.mkdir(cwd); await fs.mkdir(configHome);
    const file = path.join(configHome, 'keep.json'); await fs.writeFile(file, 'native sentinel');
    const env = { DEVIN_CONFIG_HOME: configHome, WINDSURF_API_KEY: 'fake-key', DEVIN_MODEL: 'user-choice', CUSTOM: 'keep' };
    const native = await prepareDevinLaunch({ command: ['fake', '--user-flag'], cwd, env, dataDir: root });
    assert.deepEqual(native.command, ['fake', '--user-flag']);
    assert.equal(native.env.DEVIN_CONFIG_HOME, configHome); assert.equal(native.env.WINDSURF_API_KEY, 'fake-key');
    assert.equal(native.env.CUSTOM, 'keep'); assert.equal(native.cwd, cwd);
    t.ok('通常の会話は user 設定・既存認証・追加引数をそのまま保つ', true);
    const meta = await prepareDevinLaunch({ command: ['fake'], cwd, env, dataDir: root, metadata: true });
    const config = JSON.parse(await fs.readFile(meta.command[2], 'utf8'));
    assert.deepEqual(config, METADATA_CONFIG);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(meta.command[2]), 'mcp_config.json'), 'utf8')), { mcpServers: {} });
    t.ok('metadata は固定の小さな設定・空 MCP と専用 cwd に隔離する', meta.cwd !== cwd && meta.env.DEVIN_CONFIG_HOME !== configHome && Object.values(config.read_config_from).every(v => v === false));
    t.ok('通常セッションと metadata セッションは別の内部領域を使う', native.env.DEVIN_SESSIONS_DIR !== meta.env.DEVIN_SESSIONS_DIR && native.env.DEVIN_SESSIONS_DIR.startsWith(root));
    assert.equal(await fs.readFile(file, 'utf8'), 'native sentinel');
    assert.deepEqual(await fs.readdir(configHome), ['keep.json']);
    t.ok('user 設定も資格情報もコピー・上書きしない', true);
    t.ok('入力の env と command を書き換えない', env.DEVIN_CONFIG_HOME === configHome && !Object.hasOwn(env, 'DEVIN_SESSIONS_DIR'));
    if (process.platform !== 'win32') t.ok('内部 metadata 設定は所有者だけ読み書きできる', ((await fs.stat(meta.command[2])).mode & 0o777) === 0o600);
    const runtime = { supplied: [{ hook: { command: 'node marker.mjs', timeout: 12 }, d: { event: 'PreToolUse', matcher: '^exec$', timeout: 9, adapter: false } }] };
    const turnConfig = devinTurnConfig({ hooksRuntime: runtime, nativeShellOff: true });
    const scoped = await prepareDevinLaunch({ command: ['fake'], cwd, env, dataDir: root, turnConfig });
    const turnPath = scoped.command.at(-1);
    assert.equal(scoped.command.at(-2), '--config');
    assert.deepEqual(JSON.parse(await fs.readFile(turnPath, 'utf8')), {
      read_config_from: { agents_standard: false, cursor: false, windsurf: false, claude: false, copilot: false, opencode: false, zed: false },
      hooks: { PreToolUse: [{ matcher: '^exec$', hooks: [{ type: 'command', command: 'node marker.mjs', timeout: 9 }] }] },
      disabled_tools: ['exec', 'shell_command', 'write_to_process', 'kill_shell', 'get_output'],
    });
    if (process.platform !== 'win32') t.ok('Scoped turn config is owner-only', ((await fs.stat(turnPath)).mode & 0o777) === 0o600);
    await scoped.cleanup();
    await assert.rejects(fs.stat(turnPath), { code: 'ENOENT' });
    // 閉じる処理が走らずに残った会話限定の設定（サーバーが落ちた）は、次の起動で 1 日を過ぎたものだけ消す
    const turnDir = path.dirname(turnPath);
    const stale = path.join(turnDir, '00000000-0000-4000-8000-000000000000.json'), fresh = path.join(turnDir, '11111111-1111-4111-8111-111111111111.json'), other = path.join(turnDir, 'keep.txt');
    for (const f of [stale, fresh, other]) await fs.writeFile(f, '{}');
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(stale, old, old); await fs.utimes(other, old, old);
    const next = await prepareDevinLaunch({ command: ['fake'], cwd, env, dataDir: root, turnConfig });
    const left = await fs.readdir(turnDir);
    t.ok('1 日を過ぎた会話限定の設定の残りだけを消す（新しいもの・ほかの名前は残す）',
      !left.includes(path.basename(stale)) && left.includes(path.basename(fresh)) && left.includes('keep.txt') && left.includes(path.basename(next.command.at(-1))), JSON.stringify(left));
    await next.cleanup();
    assert.deepEqual(await fs.readdir(configHome), ['keep.json']);
    t.ok('Hooks and native shell policy are confined to the turn config', turnConfig.read_config_from.claude === false && turnConfig.hooks.PreToolUse.length === 1 && turnConfig.disabled_tools.includes('exec'));
    assert.equal(devinTurnConfig({ hooksRuntime: { supplied: [] } }), null);
    assert.equal(devinTurnConfig(), null);
    t.ok('empty hook owners keep native imports and the shared holder untouched', true);
    await assert.rejects(prepareDevinLaunch({ command: ['fake'], cwd, env, dataDir: root, turnConfig: { marker: 'x'.repeat(1024 * 1024) } }),
      e => e.code === 'DEVIN_CONFIG_TOO_LARGE' && e.message.includes('config.json') && e.message.includes('1 MiB'));
    t.ok('oversized turn configs are rejected before writing, naming config.json and the 1 MiB limit', true);
    // 先頭に BOM の付いた設定（メモ帳などで保存した UTF-8）も読んで止める（N4）
    const bomHome = path.join(root, 'bom-config'), bomDir = path.join(bomHome, 'devin');
    await fs.mkdir(bomDir, { recursive: true });
    await fs.writeFile(path.join(bomDir, 'mcp_config.json'), '\uFEFF{ "mcpServers": { "a": { "command": "x" } } }');
    await fs.writeFile(path.join(bomDir, 'config.json'), '\uFEFF{ "model": "m" }');
    const bomTarget = await prepareDevinMcpOff({ root: path.join(root, 'bom-off'), source: bomDir, suppress: ['a'] });
    const bomOut = JSON.parse(await fs.readFile(path.join(bomTarget, 'devin', 'mcp_config.json'), 'utf8'));
    t.ok('BOM の付いた mcp_config.json・config.json も読める（止める名前に disabled を付ける）', bomOut.mcpServers.a.disabled === true && bomOut.mcpServers.a.command === 'x', JSON.stringify(bomOut));

    // Devin の --config は利用者の config.json を置き換える（実機 3000.11.92）。会話限定の設定は、利用者の設定に Pleiad の分を重ねて渡す
    const userHome = async (name, text) => {
      const home = path.join(root, name), dir = path.join(home, 'devin');
      await fs.mkdir(dir, { recursive: true });
      if (text !== undefined) await fs.writeFile(path.join(dir, 'config.json'), text);
      return { home, dir, env: { DEVIN_CONFIG_HOME: home } };
    };
    const mark = label => ({ matcher: '', hooks: [{ type: 'command', command: label }] });
    const userText = '﻿// 利用者の設定\n{\n  "devin": { "org_id": "org-1", },\n  "agent": { "model": "swe-2-flash-medium" },\n'
      + '  "read_config_from": { "cursor": false, "claude": true },\n  "permissions": { "allow": ["Exec(a)"], "deny": ["Exec(b)"], },\n'
      + `  "hooks": { "UserPromptSubmit": [${JSON.stringify(mark('user-ups'))}], "Stop": [${JSON.stringify(mark('user-stop'))}] },\n`
      + '  /* 道具 */ "disabled_tools": ["exec", "web_search"],\n  "version": 1,\n}\n';
    const u = await userHome('overlay-user', userText);
    const part = devinTurnConfig({ hooksRuntime: { supplied: [{ hook: { command: 'pleiad-ups' }, d: { event: 'UserPromptSubmit' } }, { hook: { command: 'pleiad-pre' }, d: { event: 'PreToolUse', matcher: '^exec$' } }], stopImports: true }, nativeShellOff: true });
    const over = await prepareDevinLaunch({ command: ['fake'], cwd, env: u.env, dataDir: root, turnConfig: part });
    const merged = JSON.parse(await fs.readFile(over.command.at(-1), 'utf8'));
    t.ok('利用者の hooks を残し、Pleiad の hooks はイベントごとに後ろへ足す',
      JSON.stringify(merged.hooks) === JSON.stringify({ UserPromptSubmit: [mark('user-ups'), mark('pleiad-ups')], Stop: [mark('user-stop')], PreToolUse: [{ matcher: '^exec$', hooks: [{ type: 'command', command: 'pleiad-pre' }] }] }), JSON.stringify(merged.hooks));
    t.ok('利用者の権限・モデル・組織など、Pleiad が触らないキーはそのまま渡す',
      JSON.stringify(merged.permissions) === JSON.stringify({ allow: ['Exec(a)'], deny: ['Exec(b)'] }) && merged.agent.model === 'swe-2-flash-medium' && merged.devin.org_id === 'org-1' && merged.version === 1, JSON.stringify(merged));
    t.ok('取り込みは Pleiad が止めるものだけ false を重ね、利用者が止めたものは止めたまま',
      Object.values(merged.read_config_from).every(v => v === false) && merged.read_config_from.cursor === false && merged.read_config_from.claude === false, JSON.stringify(merged.read_config_from));
    t.ok('止める道具は利用者と Pleiad の和集合（重ねない）',
      JSON.stringify(merged.disabled_tools) === JSON.stringify(['exec', 'web_search', 'shell_command', 'write_to_process', 'kill_shell', 'get_output']), JSON.stringify(merged.disabled_tools));
    await over.cleanup();
    t.ok('利用者の config.json は読むだけで書き換えない', await fs.readFile(path.join(u.dir, 'config.json'), 'utf8') === userText && JSON.stringify(await fs.readdir(u.dir)) === '["config.json"]');
    // 取り込みを止めないターン（hooks だけ渡す）は、利用者の read_config_from に何も足さず、広げもしない
    const hooksOnly = await prepareDevinLaunch({ command: ['fake'], cwd, env: u.env, dataDir: root, turnConfig: devinTurnConfig({ hooksRuntime: { supplied: [{ hook: { command: 'p' }, d: { event: 'Stop' } }], stopImports: false } }) });
    const ho = JSON.parse(await fs.readFile(hooksOnly.command.at(-1), 'utf8'));
    await hooksOnly.cleanup();
    t.ok('取り込みを止めないターンは、利用者の read_config_from をそのまま渡す', JSON.stringify(ho.read_config_from) === JSON.stringify({ cursor: false, claude: true }) && !ho.disabled_tools?.includes('shell_command') && ho.hooks.Stop.length === 2, JSON.stringify(ho));
    const narrowed = overlayDevinConfig({ read_config_from: { cursor: false } }, { read_config_from: { cursor: true, zed: false } });
    t.ok('Pleiad の分に true があっても、利用者が止めた取り込みを広げない', narrowed.read_config_from.cursor === false && narrowed.read_config_from.zed === false, JSON.stringify(narrowed));
    const unknownEvent = devinTurnConfig({ hooksRuntime: { supplied: [{ hook: { command: 'a' }, d: { event: 'PostToolUseFailure' } }, { hook: { command: 'b' }, d: { event: 'Stop' } }], stopImports: false } });
    t.ok('Devin が知らないイベントの hook は渡さない（Devin が hooks を丸ごと捨て、利用者の hooks も外れるため）', JSON.stringify(Object.keys(unknownEvent.hooks)) === '["Stop"]', JSON.stringify(unknownEvent));
    // 利用者の設定が無い・空: Pleiad の分だけ（今までどおり）
    for (const [name, text] of [['overlay-none', undefined], ['overlay-empty', ' \n']]) {
      const h = await userHome(name, text);
      const l = await prepareDevinLaunch({ command: ['fake'], cwd, env: h.env, dataDir: root, turnConfig: part });
      const c = JSON.parse(await fs.readFile(l.command.at(-1), 'utf8'));
      await l.cleanup();
      t.ok(`利用者の設定が${text === undefined ? '無い' : '空の'}ときは Pleiad の分だけを渡す`, JSON.stringify(c) === JSON.stringify(part), JSON.stringify(c));
    }
    // 読めない・壊れている・Pleiad が足すキーの値を Devin が受け付けない: 黙って外さずに断る（中身は誤りの文に載せない。写しも作らない）
    const turnDirFiles = async () => (await fs.readdir(path.join(root, 'devin', 'turn-configs'))).filter(n => /^[0-9a-f-]{36}\.json$/.test(n) && n !== path.basename(fresh)).length;
    const before = await turnDirFiles();
    const refusals = [
      ['broken', '{ "hooks": { secret-value-123'],
      ['array', '[1, 2]'],
      ['bad-event', JSON.stringify({ hooks: { NoSuchEvent: [mark('secret-value-123')] } })],
      ['null-matcher', JSON.stringify({ hooks: { Stop: [{ matcher: null, hooks: [{ type: 'command', command: 'secret-value-123' }] }] } })],
      ['bad-timeout', JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'x', timeout: -1 }] }] } })],
      ['bad-imports', JSON.stringify({ read_config_from: { cursor: 'secret-value-123' } })],
      ['bad-tools', JSON.stringify({ disabled_tools: 'secret-value-123' })],
    ];
    for (const [name, text] of refusals) {
      const h = await userHome(`refuse-${name}`, text);
      await assert.rejects(prepareDevinLaunch({ command: ['fake'], cwd, env: h.env, dataDir: root, turnConfig: part }),
        e => e.code === 'DEVIN_USER_CONFIG_INVALID' && !e.message.includes('secret-value-123') && /config\.json/.test(e.message), name);
    }
    const unreadable = await userHome('refuse-unreadable');
    await fs.mkdir(path.join(unreadable.dir, 'config.json'));
    await assert.rejects(prepareDevinLaunch({ command: ['fake'], cwd, env: unreadable.env, dataDir: root, turnConfig: part }), { code: 'DEVIN_USER_CONFIG_INVALID' });
    t.ok('読めない・壊れている・足すキーの値を Devin が捨てる設定は、中身を出さずに断り、写しを作らない', (await turnDirFiles()) === before);
    // Devin が受け付ける形（余分な欄・matcher の省略・prompt の hook・timeout の null・未知の取り込み名・未知の道具名）は断らない。触らないキーの不正は Devin に任せる
    const lenient = { hooks: { Stop: [{ hooks: [{ type: 'prompt', prompt: 'p', extra: 1 }, { type: 'command', command: 'c', timeout: null }], note: 'x' }] },
      read_config_from: { cursor: null, future_tool: false }, disabled_tools: ['future_tool'], permissions: { allow: 'not-a-list' }, unknown_key: 1 };
    const lm = overlayDevinConfig(lenient, part);
    t.ok('Devin が受け付ける形は断らずに重ね、触らないキーは不正でもそのまま渡す', lm.hooks.Stop.length === 1 && lm.hooks.UserPromptSubmit.length === 1 && lm.permissions.allow === 'not-a-list' && lm.unknown_key === 1 && lm.read_config_from.future_tool === false && lm.disabled_tools[0] === 'future_tool', JSON.stringify(lm));
    t.ok('渡すものが無いターンは利用者の設定を読まない（--config を付けない）', (await prepareDevinLaunch({ command: ['fake'], cwd, env: (await userHome('refuse-broken-native', '{ broken')).env, dataDir: root })).command.length === 1);
    // MCP を止めるターン: 写しの置き場の config.json（mcpServers を mcp_config.json へ移した形）を土台にする
    if (canLinkMcpOffHome(root)) {
      const m = await userHome('overlay-mcp', JSON.stringify({ mcpServers: { a: { command: 'x' } }, permissions: { deny: ['Exec(b)'] } }));
      const off = await prepareDevinLaunch({ command: ['fake'], cwd, env: m.env, dataDir: root, turnConfig: part, mcpOff: ['a'] });
      const oc = JSON.parse(await fs.readFile(off.command.at(-1), 'utf8'));
      await off.cleanup();
      t.ok('MCP を止めるターンは写しの config.json を土台にし、移した mcpServers を戻さない', !Object.hasOwn(oc, 'mcpServers') && oc.permissions.deny[0] === 'Exec(b)' && off.env.DEVIN_CONFIG_HOME !== m.home, JSON.stringify(oc));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
