// 同期で運ぶもの（core/plus/sync/targets.mjs・settings.mjs、docs/plus.md「同期」）。論理名と実体の対応・入れないもの・1MB・リンク・
// sync: false の設定・全体の指示ファイルの場所が文脈の一覧（core/context-scan.mjs）と同じこと。LLM もネットワークも使わない。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSyncTargets, parseLogicalPath, skippedName, ITEM_LIMIT_BYTES } from '../../core/plus/sync/targets.mjs';
import { createSyncSettings } from '../../core/plus/sync/settings.mjs';
import { scanContext } from '../../core/context-scan.mjs';
import { createContextSettings, SOURCES } from '../../core/context-settings.mjs';

export const name = 'plus-sync-targets';
export const title = '同期で運ぶもの: 論理名と置き場・CLAUDE_CONFIG_DIR / CODEX_HOME・入れないもの・1MB・リンク・sync: false の設定・指示ファイルの場所が文脈の一覧と同じ';

export default async function (t) {
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ps-tg-')));
  const put = async (file, data) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); };
  try {
    const home = path.join(tmp, 'home'), data = path.join(tmp, 'data');

    // ---- 置き場（環境変数なし）
    const plain = createSyncTargets({ dataDir: data, home, env: {} });
    t.ok('既定の置き場: ~/.claude/skills・~/.agents/skills・<data>/skills',
      plain.skillRoots.claude === path.join(home, '.claude', 'skills') && plain.skillRoots.agents === path.join(home, '.agents', 'skills') && plain.skillRoots.pleiad === path.join(data, 'skills'));
    t.ok('既定の指示ファイル: ~/.claude/CLAUDE.md・~/.codex/AGENTS.md・~/.gemini/GEMINI.md',
      plain.instructions.claude === path.join(home, '.claude', 'CLAUDE.md') && plain.instructions.codex === path.join(home, '.codex', 'AGENTS.md') && plain.instructions.gemini === path.join(home, '.gemini', 'GEMINI.md'));

    // ---- CLAUDE_CONFIG_DIR・CODEX_HOME
    const cdir = path.join(tmp, 'claude-cfg'), xdir = path.join(tmp, 'codex-cfg');
    const env = { CLAUDE_CONFIG_DIR: cdir, CODEX_HOME: xdir };
    const tg = createSyncTargets({ dataDir: data, home, env });
    t.ok('CLAUDE_CONFIG_DIR があれば skills と CLAUDE.md はその下', tg.skillRoots.claude === path.join(cdir, 'skills') && tg.instructions.claude === path.join(cdir, 'CLAUDE.md'));
    t.ok('CODEX_HOME があれば AGENTS.md はその下', tg.instructions.codex === path.join(xdir, 'AGENTS.md'));
    t.ok('論理名 → 手元のファイル', tg.localFile('skills/claude/a/SKILL.md') === path.join(cdir, 'skills', 'a', 'SKILL.md')
      && tg.localFile('instructions/codex') === path.join(xdir, 'AGENTS.md') && tg.localFile('settings/locale') === null);

    // 指示ファイルの場所は、文脈の一覧（scanContext のユーザーの段）が読む場所と同じ
    for (const [file, text] of [[tg.instructions.claude, 'c'], [tg.instructions.codex, 'x'], [tg.instructions.gemini, 'g']]) await put(file, text);
    const ctxSettings = createContextSettings(path.join(tmp, 'ctx'), home);
    await fs.mkdir(path.join(tmp, 'work'), { recursive: true });
    const ctxPlan = await ctxSettings.get(path.join(tmp, 'work'), { level: 'default' });
    ctxPlan.plan.user.kinds.instruction.sources = [...SOURCES];   // 既定で探さない読み込み元（GEMINI.md など）も入れて照らす
    const scanned = await scanContext(ctxPlan, { home, claudeHome: cdir, codexHome: xdir, geminiHome: path.join(home, '.gemini'), scopes: ['user'] });
    const userInstr = scanned.entries.filter(e => e.kind === 'instruction' && e.scope === 'user').map(e => e.path);
    t.ok('全体の指示ファイルの 3 つの場所は、文脈の一覧（ユーザーの段）が読む場所と同じ',
      Object.values(tg.instructions).every(p => userInstr.includes(p)), JSON.stringify({ userInstr, mine: tg.instructions }));

    // ---- 運ぶもの・入れないもの
    const sk = tg.skillRoots;
    const crlfBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('---\r\nname: demo\r\n---\r\n本文\r\n', 'utf8')]);
    await put(path.join(sk.claude, 'demo', 'SKILL.md'), crlfBom);
    await put(path.join(sk.claude, 'demo', 'scripts', 'run.py'), 'print(1)\n');
    await put(path.join(sk.agents, 'other', 'SKILL.md'), 'agents skill');
    await put(path.join(sk.pleiad, 'mine', 'SKILL.md'), 'pleiad skill');
    const excluded = [
      'demo/.env', 'demo/.env.local', 'demo/my-secret.txt', 'demo/SECRETS.md', 'demo/api-keys.json', 'demo/claude-accounts.json', 'demo/compat-endpoints.json',
      'demo/context-scans.json', 'demo/.git/config', 'demo/node_modules/x/index.js', 'demo/__pycache__/a.pyc', 'demo/logs/today.txt', 'demo/run.log',
      'demo/backups/old.md', 'demo/SKILL.md.bak', 'demo/context-snapshots/s.json', 'demo/handoff-123.json', 'demo/pleiad.db', 'demo/pleiad.db-wal',
    ];
    for (const rel of excluded) await put(path.join(sk.claude, ...rel.split('/')), 'must not travel');
    await put(path.join(sk.claude, 'demo', 'big.bin'), Buffer.alloc(ITEM_LIMIT_BYTES + 1, 1));
    await put(path.join(sk.claude, 'demo', 'edge.bin'), Buffer.alloc(ITEM_LIMIT_BYTES, 2));
    // <data> の直下の秘密の置き場（秘密情報と変数・Plus の鍵）は skill の置き場の外なので読まない
    for (const f of ['secrets.json', 'secret-values.json', 'plus-secrets.json', 'api-key-secrets.json', 'mcp-secrets.json']) await put(path.join(data, f), 'outside');

    const got = await tg.scan();
    const keys = [...got.keys()].sort();
    t.ok('skill の 3 つの置き場と指示ファイル 3 つを論理名で読む',
      ['skills/claude/demo/SKILL.md', 'skills/claude/demo/scripts/run.py', 'skills/agents/other/SKILL.md', 'skills/pleiad/mine/SKILL.md', 'instructions/claude', 'instructions/codex', 'instructions/gemini']
        .every(k => got.has(k)), keys.join('\n'));
    t.ok('中身はバイト列のまま（BOM・CRLF を変えない）', got.get('skills/claude/demo/SKILL.md').content.equals(crlfBom));
    const leaked = keys.filter(k => excluded.some(rel => k === `skills/claude/${rel}`) || /secret|\.env|api-keys|node_modules|\.git\/|\.log$|\.bak$|pleiad\.db|handoff-|backups|context-/i.test(k));
    t.ok('秘密の名前・.env・.git・node_modules・__pycache__・ログ・バックアップ・文脈のキャッシュ・DB を入れない', leaked.length === 0, leaked.join());
    t.ok('<data> の直下（秘密情報と変数の secrets.json・secret-values.json、plus-secrets.json など）は読まない', !keys.some(k => !k.startsWith('skills/') && !k.startsWith('instructions/') && !k.startsWith('settings/')));
    const allContent = Buffer.concat([...got.values()].map(v => v.content)).toString('latin1');
    t.ok('入れないファイルの中身は 1 つも読まない', !allContent.includes('must not travel') && !allContent.includes('outside'));
    t.ok('1MB を超えるファイルは運ばない（ちょうど 1MB は運ぶ）', !got.has('skills/claude/demo/big.bin') && got.get('skills/claude/demo/edge.bin')?.content.length === ITEM_LIMIT_BYTES);
    for (const n of ['secret-values.json', 'secrets.json', 'plus-secrets.json', 'Secret.md', '.env', '.env.production', 'api-keys.json', 'x.log', 'a.bak', 'pleiad.db-shm', 'handoff-1.json', 'node_modules', '.git']) {
      t.ok(`skippedName(${n})`, skippedName(n) === true);
    }
    t.ok('ふつうの名前は運ぶ', ['SKILL.md', 'run.py', 'README.md', 'secretary'.replace('secret', 'sec-ret')].every(n => !skippedName(n)));

    // ---- 論理名の形
    for (const bad of ['', '/abs', 'skills/claude', 'skills/claude/../x', 'skills\\claude\\x', 'skills/other/x', 'skills/claude/.env', 'skills/claude/a/secret.txt',
      'skills/claude/con', 'skills/claude/a:b', 'skills/claude/trail.', 'instructions/opencode', 'instructions/claude/x', 'settings/../x', 'settings/a/b', 'settings/Upper', 'other/x']) {
      t.ok(`形の違う論理名を読まない（${JSON.stringify(bad)}）`, parseLogicalPath(bad) === null);
    }
    t.ok('正しい論理名を読む', parseLogicalPath('settings/composer.historyRecall')?.key === 'composer.historyRecall'
      && parseLogicalPath('skills/pleiad/a/b.md')?.rel.join('/') === 'a/b.md' && parseLogicalPath('instructions/gemini')?.source === 'gemini');

    // ---- 書く・消す
    const written = Buffer.from('a\r\nb\né', 'latin1');
    t.ok('受けた中身を書ける', await tg.write('skills/pleiad/new/deep/f.md', written, '2026-02-03T04:05:06.000Z'));
    const back = await fs.readFile(path.join(sk.pleiad, 'new', 'deep', 'f.md'));
    const st = await fs.stat(path.join(sk.pleiad, 'new', 'deep', 'f.md'));
    t.ok('書いた中身は同じバイト列、mtime は受けた時刻', back.equals(written) && Math.abs(st.mtimeMs - Date.parse('2026-02-03T04:05:06.000Z')) < 2000);
    t.ok('形の違う論理名には書かない', !(await tg.write('skills/pleiad/../escape.md', written, 0)) && !(await tg.write('skills/pleiad/.env', written, 0)));
    t.ok('1MB を超える中身は書かない', !(await tg.write('skills/pleiad/big.bin', Buffer.alloc(ITEM_LIMIT_BYTES + 1), 0)));
    t.ok('消せる（空のフォルダーは置き場の根の手前まで畳む）', await tg.remove('skills/pleiad/new/deep/f.md')
      && !(await fs.stat(path.join(sk.pleiad, 'new')).then(() => true, () => false)) && (await fs.stat(sk.pleiad).then(() => true, () => false)));

    // ---- リンク（Windows は junction、ほかは symlink）
    const outside = path.join(tmp, 'outside');
    await put(path.join(outside, 'SKILL.md'), 'outside skill');
    await put(path.join(outside, 'file.md'), 'outside file');
    const linkDir = path.join(sk.agents, 'linked');
    await fs.symlink(outside, linkDir, process.platform === 'win32' ? 'junction' : 'dir');
    let fileLink = false;
    try { await fs.symlink(path.join(outside, 'file.md'), path.join(sk.agents, 'other', 'link.md'), 'file'); fileLink = true; } catch {}
    const linkedScan = await tg.scan();
    t.ok('リンクのフォルダー（junction・symlink）とその先は運ばない', ![...linkedScan.keys()].some(k => k.startsWith('skills/agents/linked/')));
    if (fileLink) t.ok('ファイルの symlink は運ばない', !linkedScan.has('skills/agents/other/link.md'));
    const logs = [];
    const tgLog = createSyncTargets({ dataDir: data, home, env, log: l => logs.push(l) });
    t.ok('リンクの先へは書かない（ログに残す）', !(await tgLog.write('skills/agents/linked/SKILL.md', Buffer.from('overwrite'), 0))
      && (await fs.readFile(path.join(outside, 'SKILL.md'), 'utf8')) === 'outside skill' && logs.some(l => l.includes('link')));
    t.ok('リンクの先のものは消さない', !(await tgLog.remove('skills/agents/linked/file.md')) && (await fs.readFile(path.join(outside, 'file.md'), 'utf8')) === 'outside file');
    // 置き場自体がリンク
    const rootLinkHome = path.join(tmp, 'home2');
    await fs.mkdir(path.join(rootLinkHome, '.agents'), { recursive: true });
    await fs.symlink(outside, path.join(rootLinkHome, '.agents', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
    const tgRoot = createSyncTargets({ dataDir: path.join(tmp, 'data2'), home: rootLinkHome, env: {} });
    t.ok('skill の置き場自体がリンクなら運ばない・書かない', ![...(await tgRoot.scan()).keys()].some(k => k.startsWith('skills/agents/'))
      && !(await tgRoot.write('skills/agents/new.md', Buffer.from('x'), 0)));
    // 指示ファイル自体がリンク
    if (fileLink) {
      const ilHome = path.join(tmp, 'home3');
      await fs.mkdir(path.join(ilHome, '.claude'), { recursive: true });
      await fs.symlink(path.join(outside, 'file.md'), path.join(ilHome, '.claude', 'CLAUDE.md'), 'file');
      const tgIl = createSyncTargets({ dataDir: path.join(tmp, 'data3'), home: ilHome, env: {} });
      t.ok('指示ファイル自体がリンクなら運ばない・書かない', !(await tgIl.scan()).has('instructions/claude') && !(await tgIl.write('instructions/claude', Buffer.from('x'), 0)));
    }

    // ---- 設定（defineSetting の形の作り物）
    const store = { colorish: 'blue', plainSync: 7, notSynced: 'machine', readOnlyOne: 'ro' };
    const def = (key, extra) => ({
      key, sync: true, default: null, read: async () => store[key] ?? null,
      write: async (_c, value) => { store[key] = value; }, ...extra,
    });
    const stubSettings = [
      def('colorish', { default: 'red', normalize: async (_c, v) => { if (!['red', 'blue', 'green'].includes(v)) throw Object.assign(new Error('bad'), { code: 'invalid' }); return { after: v }; } }),
      def('plainSync', { default: 7 }),
      def('notSynced', { sync: false }),
      def('readOnlyOne', { readOnly: true }),
      def('otherSync', {}),
    ];
    const written2 = [];
    const ss = createSyncSettings({ settings: stubSettings, ctx: () => ({}), onWritten: k => written2.push(...k) });
    const listed = await ss.list();
    t.ok('sync の設定のうち既定でないものだけを運ぶ（sync: false・読むだけ・既定の値・未設定は運ばない）',
      JSON.stringify(listed) === JSON.stringify([{ key: 'colorish', value: 'blue' }]), JSON.stringify(listed));
    t.ok('sync: false・読むだけの設定は受けても書かない', !ss.has('notSynced') && !ss.has('readOnlyOne') && !(await ss.write('notSynced', 'x')) && store.notSynced === 'machine');
    t.ok('受けた値は normalize を通して書く', (await ss.write('colorish', 'green')) && store.colorish === 'green' && written2.includes('colorish'));
    t.ok('normalize で落ちる値は書かない', !(await ss.write('colorish', 'purple')) && store.colorish === 'green');
    t.ok('既定に戻す', (await ss.reset('colorish')) && store.colorish === 'red');
    const tgS = createSyncTargets({ dataDir: path.join(tmp, 'data4'), home: path.join(tmp, 'home4'), env: {}, settings: ss });
    store.colorish = 'blue';
    const sScan = await tgS.scan();
    t.ok('設定は settings/<key> に JSON で載る', sScan.get('settings/colorish')?.content.toString() === '"blue"' && sScan.get('settings/colorish').kind === 'setting' && !sScan.has('settings/notSynced'));
    t.ok('settings/<sync: false の key> を受けても書かない', !(await tgS.write('settings/notSynced', Buffer.from('"x"'), 0)) && store.notSynced === 'machine');
    t.ok('settings/<key> は normalize を通して書く', (await tgS.write('settings/colorish', Buffer.from('"green"'), 0)) && store.colorish === 'green');
    t.ok('壊れた JSON は書かない', !(await tgS.write('settings/colorish', Buffer.from('{oops'), 0)) && store.colorish === 'green');
    t.ok('消した設定を受けると既定に戻す', (await tgS.remove('settings/colorish')) && store.colorish === 'red');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}
