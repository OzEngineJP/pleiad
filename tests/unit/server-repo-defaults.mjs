// リポジトリ別の既定を、実際の送信と新しい会話の作成を通して確かめる。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startServer, ROOT } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';
import * as store from '../../core/store.mjs';
import { rememberableRepoTurn } from '../../core/repo-defaults.mjs';

export const name = 'server-repo-defaults';
export const title = 'リポジトリ別の設定: 送信時の記録・同じ場所と別の場所の優先順位・上限・worktree の予約';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

export default async function(t) {
  t.ok('bot・委譲の子・内部ターンは記録しない',
    rememberableRepoTurn('s', {}, {}) && !rememberableRepoTurn('s', { bot: {} }, {})
    && !rememberableRepoTurn('s', { delegation: {} }, {}) && !rememberableRepoTurn('s', {}, { internal: true })
    && !rememberableRepoTurn('s', null, {}) && rememberableRepoTurn(null, null, {}));

  for (let i = 0; i < 52; i++) await store.rememberRepoDefault(`/repo-${i}`, { backend: 'fake', model: String(i) });
  const limited = (await store.getPrefs()).repoDefaults;
  t.ok('prefs の表は最後に使った 50 件だけ', Object.keys(limited).length === 50 && !limited['/repo-0'] && limited['/repo-51']);

  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-repo-defaults-')));
  const a = path.join(tmp, 'a'), b = path.join(tmp, 'b'), plain = path.join(tmp, 'plain');
  // Git のリポジトリのキーは git が返す / 区切りのパス（Windows でも）。Git 管理外は path.resolve のまま
  const aKey = a.replaceAll('\\', '/');
  await fs.mkdir(path.join(a, 'sub'), { recursive: true });
  await fs.mkdir(b);
  await fs.mkdir(plain);
  for (const dir of [a, b]) {
    git(dir, 'init', '-q', '-b', 'main');
    await fs.writeFile(path.join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', '.'); git(dir, 'commit', '-q', '-m', 'first');
  }
  const server = await startServer({ dataDir: path.join(tmp, 'data'), env: { AGENT_HOST_BACKENDS: 'fake,codex', AGENT_HOST_WORKTREES: 'on',
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"` } });
  const c = await open({ port: server.port, token: server.token, autoAllow: true });
  const row = async id => (await c.cmd('listSessions')).find(s => s.id === id);
  try {
    const first = (await c.cmd('newSession', { backend: 'fake', cwd: a })).sessionId;
    await c.cmd('setTurnSettings', { sessionId: first, model: 'fast', effort: 'low', mode: 'auto', rememberModel: true });
    t.ok('チップだけではリポジトリに記録しない', !(await c.cmd('prefs')).repoDefaults?.[aKey]);
    await c.runTurn({ sessionId: first, prompt: 'echo:a' });
    t.ok('送った値をリポジトリ本体へ記録', (await c.cmd('prefs')).repoDefaults?.[aKey]?.model === 'fast'
      && (await c.cmd('prefs')).repoDefaults?.[aKey]?.effort === 'low' && (await c.cmd('prefs')).repoDefaults?.[aKey]?.mode === 'auto');
    const sub = (await c.cmd('newSession', { cwd: path.join(a, 'sub') })).sessionId;
    t.ok('同じリポジトリのサブフォルダーは設定を使う', (await row(sub)).model === 'fast' && (await row(sub)).effort === 'low' && (await row(sub)).mode === 'auto');

    const other = (await c.cmd('newSession', { backend: 'fake', cwd: b })).sessionId;
    await c.cmd('setTurnSettings', { sessionId: other, model: 'smart', rememberModel: true });
    await c.runTurn({ sessionId: other, prompt: 'echo:b' });
    const cross = (await c.cmd('newSession', { sourceSessionId: other, cwd: a })).sessionId;
    t.ok('＋で別リポジトリへ移ると移動先の記録を優先', (await row(cross)).model === 'fast');
    const same = (await c.cmd('newSession', { sourceSessionId: other, cwd: b })).sessionId;
    t.ok('＋で同じリポジトリなら元の会話を継ぐ', (await row(same)).model === 'smart');
    await c.cmd('setTurnSettings', { sessionId: cross, model: 'smart' });
    await c.cmd('setTurnSettings', { sessionId: cross, cwd: b });
    t.ok('未送信の場所替えは手で選んだモデルを保持', (await row(cross)).nextSettings?.model === 'smart');
    await c.cmd('setTurnSettings', { sessionId: sub, cwd: b });
    t.ok('未送信の場所替えは移動先の設定を使う', (await row(sub)).nextSettings?.model === 'smart');

    const split = await c.cmd('worktreeSplit', { sessionId: first, cwd: a });
    await c.cmd('setTurnSettings', { sessionId: first, cwd: split.cwd });
    await c.runTurn({ sessionId: first, prompt: 'echo:worktree' });
    t.ok('worktree の送信も本体の同じキーに記録', (await c.cmd('prefs')).repoDefaults?.[aKey]?.worktree === true);
    const pending = (await c.cmd('newSession', { cwd: a })).sessionId;
    t.ok('新しい会話は送る前に worktree を予約し、まだ作らない', (await row(pending)).worktreePending === true);
    await c.cmd('setTurnSettings', { sessionId: pending, worktreePending: false });
    t.ok('× でその会話の予定だけを外す', !(await row(pending)).worktreePending);
    await c.cmd('setTurnSettings', { sessionId: pending, cwd: b });
    await c.cmd('setTurnSettings', { sessionId: pending, cwd: a });
    t.ok('× で外した会話は場所を選び直しても予定を戻さない', !(await row(pending)).worktreePending);
    await c.runTurn({ sessionId: pending, prompt: 'echo:original' });
    t.ok('元の場所から送ると worktree なしへ更新', (await c.cmd('prefs')).repoDefaults?.[aKey]?.worktree === false);

    const plainFirst = (await c.cmd('newSession', { backend: 'fake', cwd: plain })).sessionId;
    await c.cmd('setTurnSettings', { sessionId: plainFirst, model: 'fast' });
    await c.runTurn({ sessionId: plainFirst, prompt: 'echo:plain' });
    t.ok('Git 管理外はフォルダー自身をキーにする', (await c.cmd('prefs')).repoDefaults?.[plain]?.model === 'fast');
    const direct = path.join(tmp, 'direct');
    await fs.mkdir(direct);
    await c.runTurn({ backend: 'fake', cwd: direct, prompt: 'echo:direct' });
    t.ok('会話 ID を送信時に作る入口も作業場所を記録する', (await c.cmd('prefs')).repoDefaults?.[direct]?.backend === 'fake');

    const codex = (await c.cmd('newSession', { backend: 'codex', cwd: b })).sessionId;
    await c.runTurn({ sessionId: codex, prompt: 'codex' });
    const codexNew = (await c.cmd('newSession', { cwd: b })).sessionId;
    const backToA = (await c.cmd('newSession', { sourceSessionId: codex, cwd: a })).sessionId;
    t.ok('記録した backend を選び、＋で別リポジトリなら移動先の backend を選ぶ',
      (await row(codexNew)).backend === 'codex' && (await row(backToA)).backend === 'fake');
  } finally {
    c.close(); await server.stop();
  }

  // 記録の無い場所へ替えると全体の既定のエージェントになる。引いた既定の承認モード・モデルが替えた先に無ければ
  // 替えた先の既定に戻す（送れなくしない）。手で選んだものは今までどおり断る
  const fresh = path.join(tmp, 'fresh');
  await fs.mkdir(fresh);
  const dataDir = path.join(tmp, 'data-fallback');
  await fs.mkdir(dataDir);
  await fs.writeFile(path.join(dataDir, 'prefs.json'), JSON.stringify({ backend: 'codex', mode: 'bypass', model: 'fast', backends: { fake: { mode: 'bypass' }, codex: { mode: 'bypass', model: 'no-such-model' } },
    repoDefaults: { [aKey]: { backend: 'fake', mode: 'bypass', model: 'fast' } } }));
  const server2 = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake,codex',
    AGENT_HOST_CODEX_BIN: `node "${path.join(ROOT, 'tests/lib/fake-codex.mjs')}"` } });
  const c2 = await open({ port: server2.port, token: server2.token, autoAllow: true });
  try {
    const s = (await c2.cmd('newSession', { cwd: a })).sessionId;
    t.ok('記録した場所の会話は記録のエージェント・承認モード', (await c2.cmd('listSessions')).find(r => r.id === s)?.mode === 'bypass');
    const next = await c2.cmd('setTurnSettings', { sessionId: s, cwd: fresh });
    t.ok('記録の無い場所へ替えたとき、替えた先に無い承認モード・モデルは既定（Codex の最初の ask・既定のモデル）に戻す',
      next?.backend === 'codex' && next.cwd === fresh && next.mode === 'ask' && next.model === '');
    let refused = '';
    await c2.cmd('setTurnSettings', { sessionId: s, cwd: a }).catch(() => {});
    await c2.cmd('setTurnSettings', { sessionId: s, cwd: fresh, mode: 'bypass' }).catch(e => { refused = e.message; });
    t.ok('手で選んだ承認モードが替えた先に無ければ断る', /承認モード|mode/i.test(refused));
  } finally {
    c2.close(); await server2.stop();
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
