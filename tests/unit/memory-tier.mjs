// 記憶の段と作業場所（tier / workspace。記憶の段 2 の実装単位 1）: markdown の読み書き（tier / ws）・作業場所の canonical（git の本体・worktree は本体・git の外は null）・
// service の既定（人は always・bot/AI は会話の cwd に git の本体があれば workspace）・明示 tier=workspace で場所不明は MEMORY_REJECTED・
// 段・作業場所だけの直しは updatedAt を進めない（null で外す）・memory.edit の承認（人の行の段・作業場所を AI が変えるときは guarded）。配送の挙動は変えない。
import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MemoryError } from '../../core/memory/guard.mjs';
import { createMemoryService } from '../../core/memory/service.mjs';
import { createMemoryStore, parseLayer, renderLayer, isWorkspace, WORKSPACE_MAX } from '../../core/memory/store.mjs';
import { canonicalWorkspace, GIT_IO, slashPath } from '../../core/git-root.mjs';
import { registry } from '../../core/ops/index.mjs';

export const name = 'memory-tier';
export const title = '記憶の段と作業場所: tier / ws の読み書き・canonical・既定・updatedAt を進めない直し・承認';

const BOT = 'b_owl12345';
const HUMAN = { kind: 'human' };
const BOT_AUTHOR = { kind: 'bot', botId: BOT };
const Q_FRI = '金曜に出さないでほしい';
const code = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof MemoryError ? `${e.code}:${e.reason}` : `ERR:${e.message}`; } };

const channels = {
  list: async () => [{ id: 'c_dev0001', name: 'dev' }],
  read: async () => ({ posts: [{ id: 'p_human01', channelId: 'c_dev0001', text: 'デプロイは金曜に出さないでほしい。週末に直せないから', at: 100, author: { kind: 'human' } }], nextBefore: null }),
};
const sessions = { read: async () => null, get: async () => null };
const botOfSession = async (id) => (id === 'sbot' ? { botId: BOT, kind: 'thread' } : null);
const grounds = [{ kind: 'post', channelId: 'c_dev0001', postId: 'p_human01', quote: Q_FRI }];

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-tier-'));
  try {
    // ---- 作業場所の canonical（core/git-root.mjs。claude-connectors-auth.mjs の gitRootOf / canonicalRoot と同じ規則）
    const main = path.join(root, 'main'), sub = path.join(main, 'src', 'deep'), wt = path.join(root, 'wt1'), plain = path.join(root, 'plain');
    await fs.mkdir(path.join(main, '.git', 'worktrees', 'wt1'), { recursive: true });
    await fs.mkdir(sub, { recursive: true });
    await fs.mkdir(wt, { recursive: true });
    await fs.mkdir(plain, { recursive: true });
    const gitDir = path.join(main, '.git', 'worktrees', 'wt1');
    await fs.writeFile(path.join(gitDir, 'commondir'), '../..\n');
    await fs.writeFile(path.join(gitDir, 'gitdir'), `${path.join(wt, '.git')}\n`);
    await fs.writeFile(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
    const mainSlash = slashPath(await GIT_IO.realpath(main));
    t.ok('canonical: リポジトリの中のフォルダは git の本体（スラッシュ形・末尾なし）', await canonicalWorkspace(sub) === mainSlash && !mainSlash.includes('\\') && !mainSlash.endsWith('/'), `${await canonicalWorkspace(sub)} / ${mainSlash}`);
    t.ok('canonical: worktree は本体の作業ツリーへ寄せる', await canonicalWorkspace(wt) === mainSlash);
    t.ok('canonical: git の外のフォルダ・存在しない場所は null', await canonicalWorkspace(plain) === null && await canonicalWorkspace(path.join(plain, 'nothing', 'here')) === null);
    t.ok('canonical: 空・非文字列・相対は null', await canonicalWorkspace('') === null && await canonicalWorkspace(null) === null && await canonicalWorkspace('relative/dir') === null);
    const fakeIo = { ...GIT_IO, lstat: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } };
    t.ok('canonical: .git が無ければ（io が見つけられなければ）null', await canonicalWorkspace(sub, { io: fakeIo }) === null);
    t.ok('slashPath: \\ を / にし、末尾の / を落とす（ルートは残す）', slashPath('D:\\dev\\app\\') === 'D:/dev/app' && slashPath('/a/b//') === '/a/b' && slashPath('/') === '/' && slashPath('C:\\') === 'C:/');
    t.ok('isWorkspace: スラッシュ形・末尾なし・500 字まで', isWorkspace('D:/dev/app') && isWorkspace('/home/u/app') && isWorkspace('/') && !isWorkspace('D:\\dev\\app') && !isWorkspace('/a/b/') && !isWorkspace('')
      && !isWorkspace(`/${'a'.repeat(WORKSPACE_MAX)}`) && isWorkspace(`/${'a'.repeat(WORKSPACE_MAX - 1)}`) && !isWorkspace(null));

    // ---- store: markdown の読み書き
    const FUTURE = '- 古い形の行 <!-- {"id":"m_0old000000001","at":1,"up":1,"by":{"kind":"human"},"src":[]} -->';
    const MD = [
      '<!-- pleiad-memory v1 layer=user -->', '# あなたについて', '',
      FUTURE,
      '- 段つきの行 <!-- {"id":"m_0tier0000001","at":2,"up":2,"by":{"kind":"human"},"src":[],"tier":"workspace","ws":"D:/dev/app","future":{"x":1}} -->',
      '- 正しくない段・場所の行 <!-- {"id":"m_0tier0000002","at":3,"up":3,"by":{"kind":"human"},"src":[],"tier":"everything","ws":"D:\\\\dev\\\\app\\\\"} -->',
      '',
    ].join('\n');
    const parsed = parseLayer(MD, 'user');
    t.ok('tier / ws の無い古い行は未振り分けのまま読める', !('tier' in parsed[0]) && !('workspace' in parsed[0]));
    t.ok('tier / ws を tier / workspace として読む（extraMeta には入れない）', parsed[1].tier === 'workspace' && parsed[1].workspace === 'D:/dev/app' && parsed[1].extraMeta.future.x === 1 && !('tier' in parsed[1].extraMeta) && !('ws' in parsed[1].extraMeta));
    t.ok('正しくない段・\\ や末尾 / の作業場所は無いものとして読む', !('tier' in parsed[2]) && !('workspace' in parsed[2]));
    const rendered = renderLayer('user', parsed, 'あなたについて');
    t.ok('書き直しても tier / ws と知らないキーが残る', rendered.includes('"tier":"workspace"') && rendered.includes('"ws":"D:/dev/app"') && rendered.includes('"future":{"x":1}'));
    const again = parseLayer(rendered, 'user');
    t.ok('書き直した形を読み戻すと同じ', again[1].tier === 'workspace' && again[1].workspace === 'D:/dev/app' && !('tier' in again[0]));

    // ---- store: add / edit
    const dir = path.join(root, 'store');
    let clock = 1_000;
    const store = createMemoryStore({ dir, now: () => ++clock, titleOf: () => 'あなたについて' });
    await store.init();
    const added = await store.add({ layer: 'user', text: '段つきで足す行', by: HUMAN, tier: 'workspace', workspace: 'D:/dev/app' });
    t.ok('add は tier / workspace を入れて、markdown にも残す', added.entry.tier === 'workspace' && added.entry.workspace === 'D:/dev/app' && (await fs.readFile(path.join(dir, 'user.md'), 'utf8')).includes('"ws":"D:/dev/app"'));
    const plainAdd = await store.add({ layer: 'user', text: '段なしで足す行', by: HUMAN });
    t.ok('tier を渡さない add は段なし（未振り分け）のまま', !('tier' in plainAdd.entry) && !('workspace' in plainAdd.entry));
    const before = store.get(added.entry.id);
    const placed = await store.edit({ id: added.entry.id, tier: 'archive', by: BOT_AUTHOR });
    t.ok('tier だけの edit は updatedAt を進めず、by も替えない', placed.entry.tier === 'archive' && placed.entry.updatedAt === before.updatedAt && placed.entry.by.kind === 'human' && !placed.entry.origBy);
    t.ok('tier だけの edit も log.jsonl に edit として残る', store.recordsSince(0).at(-1).op === 'edit' && store.recordsSince(0).at(-1).id === added.entry.id);
    const cleared = await store.edit({ id: added.entry.id, workspace: null, by: HUMAN });
    t.ok('workspace は null で外れる（updatedAt は進まない）', !('workspace' in cleared.entry) && cleared.entry.tier === 'archive' && cleared.entry.updatedAt === before.updatedAt && !(await fs.readFile(path.join(dir, 'user.md'), 'utf8')).includes('"ws"'));
    const both = await store.edit({ id: added.entry.id, tier: null, by: HUMAN });
    t.ok('tier は null で外れて未振り分けに戻る', !('tier' in both.entry));
    const withText = await store.edit({ id: added.entry.id, tier: 'always', text: '本文も変える', by: HUMAN });
    t.ok('本文・理由なども一緒の edit は updatedAt を進める', withText.entry.tier === 'always' && withText.entry.updatedAt > before.updatedAt);
    const why = await store.edit({ id: added.entry.id, why: '理由だけ', by: HUMAN });
    t.ok('理由だけの edit は従来どおり updatedAt を進め、tier を保つ', why.entry.updatedAt > withText.entry.updatedAt && why.entry.tier === 'always');
    t.ok('正しくない tier・workspace を渡しても段・場所は入らない（無いものとして扱う）', await (async () => {
      const e = await store.add({ layer: 'user', text: '正しくない段の行', by: HUMAN, tier: 'nope', workspace: 'D:\\dev' });
      return !('tier' in e.entry) && !('workspace' in e.entry);
    })());
    const reopened = createMemoryStore({ dir, now: () => ++clock, titleOf: () => 'あなたについて' });
    await reopened.init();
    t.ok('再起動しても tier / workspace が残る', reopened.get(added.entry.id).tier === 'always' && reopened.get(plainAdd.entry.id).tier === undefined);
    const hash = reopened.hash();
    await reopened.edit({ id: plainAdd.entry.id, tier: 'always', by: HUMAN });
    t.ok('tier だけの直しでも索引の印（hash）は変わる（search に新しい段を出すため）', reopened.hash() !== hash);

    // ---- service: 既定・検査
    const svc = createMemoryService({ dataDir: path.join(root, 'svc'), channels, now: (() => { let c = 5_000; return () => ++c; })() });
    await svc.start();
    const botCtx = (cwd, n) => ({ sessions, botOfSession, sessionId: `sbot-${n}`, sessionCwd: cwd });
    const h = await svc.write({ layer: 'user', text: '人が書く行は always' }, HUMAN, {});
    t.ok('人の新規は always（場所なし）', h.tier === 'always' && !('workspace' in h));
    const hCwd = await svc.write({ layer: 'user', text: '人が書く行は cwd があっても always' }, HUMAN, { sessionCwd: sub });
    t.ok('人の新規は会話の cwd があっても always', hCwd.tier === 'always' && !('workspace' in hCwd));
    const b1 = await svc.write({ layer: BOT, text: 'bot が書く行はリポジトリなら workspace', sources: grounds }, BOT_AUTHOR, botCtx(sub, 1));
    t.ok('bot の新規は、会話の cwd に git の本体があれば workspace + その場所', b1.tier === 'workspace' && b1.workspace === mainSlash, JSON.stringify(b1));
    const b2 = await svc.write({ layer: BOT, text: 'worktree の会話で書く行は本体の場所', sources: grounds }, BOT_AUTHOR, botCtx(wt, 2));
    t.ok('worktree の会話は本体の場所になる', b2.tier === 'workspace' && b2.workspace === mainSlash);
    const b3 = await svc.write({ layer: BOT, text: 'git の外の会話で書く行は always', sources: grounds }, BOT_AUTHOR, botCtx(plain, 3));
    const b4 = await svc.write({ layer: BOT, text: 'cwd の無い会話で書く行も always', sources: grounds }, BOT_AUTHOR, botCtx(null, 4));
    t.ok('git の外・cwd なしの bot の新規は always（場所なし）', b3.tier === 'always' && !('workspace' in b3) && b4.tier === 'always' && !('workspace' in b4));
    const ag = await svc.write({ layer: 'user', text: '別の会話の AI も cwd で決まる', sources: grounds }, { kind: 'agent', sessionId: 'sx' }, { sessions, botOfSession, sessionId: 'sx', sessionCwd: sub });
    t.ok('bot でない AI の新規も同じ規則', ag.tier === 'workspace' && ag.workspace === mainSlash);
    t.ok('明示 tier=workspace で場所が決まらなければ MEMORY_REJECTED（workspaceUnknown）', await code(() => svc.write({ layer: BOT, text: '場所が決まらない行', sources: grounds, tier: 'workspace' }, BOT_AUTHOR, botCtx(plain, 5))) === 'MEMORY_REJECTED:workspaceUnknown'
      && await code(() => svc.write({ layer: 'user', text: '人が場所なしで workspace を選ぶ' , tier: 'workspace' }, HUMAN, {})) === 'MEMORY_REJECTED:workspaceUnknown');
    t.ok('断られた書き込みは何も書かない', !svc.store.entries().some((e) => ['場所が決まらない行', '人が場所なしで workspace を選ぶ'].includes(e.text)));
    const explicit = await svc.write({ layer: 'user', text: '場所を渡した行です', tier: 'workspace', workspace: 'D:\\dev\\other\\' }, HUMAN, {});
    t.ok('明示の workspace は \\ を / へ・末尾の / を落として入る', explicit.tier === 'workspace' && explicit.workspace === 'D:/dev/other');
    const onlyWs = await svc.write({ layer: 'user', text: '場所だけ渡した行です', workspace: '/home/u/app' }, HUMAN, {});
    t.ok('workspace だけ渡すと tier は workspace', onlyWs.tier === 'workspace' && onlyWs.workspace === '/home/u/app');
    const arch = await svc.write({ layer: 'user', text: '保存だけの行です', tier: 'archive', workspace: '/ignored' }, HUMAN, {});
    t.ok('tier=archive・always には作業場所を入れない', arch.tier === 'archive' && !('workspace' in arch));
    t.ok('正しくない tier・workspace は MEMORY_REJECTED（tier / workspace）', await code(() => svc.write({ layer: 'user', text: '段が変な行です', tier: 'nope' }, HUMAN, {})) === 'MEMORY_REJECTED:tier'
      && await code(() => svc.write({ layer: 'user', text: '場所が長すぎる行です', workspace: `/${'a'.repeat(WORKSPACE_MAX)}` }, HUMAN, {})) === 'MEMORY_REJECTED:workspace');

    // ---- service: edit / list / get / search
    const clock0 = svc.store.get(h.id).updatedAt;
    const moved = await svc.edit({ id: h.id, tier: 'workspace', workspace: 'D:/dev/app/' }, HUMAN, {});
    t.ok('edit: tier + workspace の振り分け（場所は正規化。updatedAt は進まない）', moved.tier === 'workspace' && moved.workspace === 'D:/dev/app' && moved.updatedAt === clock0);
    const noop = await svc.edit({ id: h.id, tier: 'workspace', workspace: 'D:/dev/app' }, HUMAN, {});
    t.ok('edit: 何も変わらない振り分けは記録を足さない', noop.updatedAt === clock0 && svc.rev() === svc.store.rev() && svc.store.recordsSince(0).filter((r) => r.id === h.id && r.op === 'edit').length === 1);
    const toAlways = await svc.edit({ id: h.id, tier: 'always' }, HUMAN, {});
    t.ok('edit: workspace の段から always へ（場所は残してよいが、段は always）', toAlways.tier === 'always' && toAlways.updatedAt === clock0);
    t.ok('edit: workspace の段にするとき場所が決まらなければ MEMORY_REJECTED。会話の cwd があればそれを使う',
      await code(() => svc.edit({ id: b3.id, tier: 'workspace' }, BOT_AUTHOR, botCtx(plain, 6))) === 'MEMORY_REJECTED:workspaceUnknown'
      && (await svc.edit({ id: b3.id, tier: 'workspace' }, BOT_AUTHOR, botCtx(sub, 7))).workspace === mainSlash);
    t.ok('edit: workspace を null で外せる（workspace の段でないとき）', await (async () => {
      const e = await svc.edit({ id: h.id, workspace: null }, HUMAN, {});
      return !('workspace' in e) && e.tier === 'always';
    })());
    t.ok('edit: 正しくない tier は MEMORY_REJECTED', await code(() => svc.edit({ id: h.id, tier: 'nope' }, HUMAN, {})) === 'MEMORY_REJECTED:tier');
    const listed = (await svc.list({ layer: 'user' })).find((e) => e.id === explicit.id);
    t.ok('list の行に tier / workspace（と強さ）が付く', listed.tier === 'workspace' && listed.workspace === 'D:/dev/other' && typeof listed.strength === 'number');
    t.ok('get に tier / workspace が付く', (await svc.get({ id: explicit.id })).workspace === 'D:/dev/other');
    const found = (await svc.search({ query: '場所を渡した行', layer: 'user' })).find((e) => e.id === explicit.id);
    t.ok('search の行にも tier / workspace が付く（段を直した後の search にも最新が出る）', found?.tier === 'workspace' && found.workspace === 'D:/dev/other');
    await svc.edit({ id: explicit.id, tier: 'archive' }, HUMAN, {});
    t.ok('search は段を直した後の最新を返す', (await svc.search({ query: '場所を渡した行', layer: 'user' })).find((e) => e.id === explicit.id)?.tier === 'archive');
    svc.stop();

    // ---- ops: memory.edit の承認・memory.write の既定・memory.list の出力
    const svc2 = createMemoryService({ dataDir: path.join(root, 'ops'), channels });
    await svc2.start();
    const humanLine = (await svc2.write({ layer: 'user', text: '人が書いた行です' }, HUMAN, {})).id;
    const botLine = (await svc2.write({ layer: 'user', text: 'bot が書いた行です', sources: grounds }, BOT_AUTHOR, botCtx(null, 8))).id;
    const asked = [];
    const deps = { locale: 'ja', memory: svc2, sessions, botOfSession, modeOf: async () => ({ scope: 'workspace', autonomy: 'ask' }), audit: () => {},
      sessionCwd: async (id) => (id === 'sbot' ? sub : null),
      approve: async (req) => { asked.push(req); return { pending: true, requestId: `r${asked.length}` }; } };
    const agentP = (sessionId) => ({ by: 'agent', via: 'mcp', sessionId });
    const UI = { by: 'human', via: 'ui', local: true };
    const edit = (p, args) => registry.invoke(p, 'memory.edit', args, deps);

    const pending = await edit(agentP('sbot'), { id: humanLine, tier: 'archive' });
    t.ok('AI が人の行の段を変えるのは承認（カードに tier の行）。許可前は変わらない', pending.pending === true && asked.length === 1
      && asked[0].change.rows.some((r) => r.path === 'tier' && r.after === 'archive' && r.before === 'always') && svc2.store.get(humanLine).tier === 'always');
    await asked[0].proceed();
    t.ok('許可されたら段が変わる（updatedAt は進まない）', svc2.store.get(humanLine).tier === 'archive');
    const pendingWs = await edit(agentP('sbot'), { id: humanLine, workspace: 'D:/dev/app' });
    t.ok('AI が人の行の作業場所を変えるのも承認（カードに workspace の行）', pendingWs.pending === true && asked.length === 2 && asked[1].change.rows.some((r) => r.path === 'workspace' && r.after === 'D:/dev/app'));
    t.ok('今と同じ段・作業場所の指定は承認なし', (await edit(agentP('sbot'), { id: humanLine, tier: 'archive' })).ok === true && asked.length === 2);
    t.ok('AI が書いた行の段・作業場所の直し・人の直しは承認なし', (await edit(agentP('sbot'), { id: botLine, tier: 'archive' })).ok === true && asked.length === 2
      && (await edit(UI, { id: humanLine, tier: 'always' })).ok === true && asked.length === 2 && svc2.store.get(humanLine).tier === 'always');
    t.ok('memory.edit の入力に tier / workspace がある（workspace は 500 字まで・tier は列挙）', (await edit(UI, { id: humanLine, tier: 'nope' })).ok !== true
      && (await edit(UI, { id: humanLine, workspace: 'a'.repeat(WORKSPACE_MAX + 1) })).ok !== true);

    const written = await registry.invoke(agentP('sbot'), 'memory.write', { layer: 'self', text: 'ops 経由で bot が書く行です', sources: grounds }, deps);
    t.ok('memory.write: bot の会話の cwd（ctx.sessionCwd）から workspace + 本体の場所が既定になる', written.ok === true && written.result.tier === 'workspace' && written.result.workspace === mainSlash, JSON.stringify(written));
    const humanWrite = await registry.invoke(UI, 'memory.write', { layer: 'user', text: '画面から人が書く行です' }, deps);
    t.ok('memory.write: 人（画面）の既定は always', humanWrite.ok === true && humanWrite.result.tier === 'always');
    const rejected = await registry.invoke(agentP('sbot'), 'memory.write', { layer: 'self', text: '場所が決まらない ops の行です', sources: grounds, tier: 'workspace' }, { ...deps, sessionCwd: async () => plain });
    t.ok('memory.write: 明示 tier=workspace で場所不明は MEMORY_REJECTED', rejected.code === 'MEMORY_REJECTED');
    const listedOps = await registry.invoke(UI, 'memory.list', { layer: 'user' }, deps);
    t.ok('memory.list の行に tier / workspace が出る（出力の形に入っている）', listedOps.ok === true && listedOps.result.some((e) => e.tier === 'always') && listedOps.result.every((e) => e.tier === undefined || ['always', 'workspace', 'archive'].includes(e.tier)));
    const searchedOps = await registry.invoke(UI, 'memory.search', { query: '画面から人が書く', layer: 'user' }, deps);
    t.ok('memory.search の行にも tier が出る', searchedOps.ok === true && searchedOps.result[0]?.tier === 'always');
    svc2.stop();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
