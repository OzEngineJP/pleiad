import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DOC_AGENTS_VERSION, MAX_PLACES, docItemKey } from '../../core/context-agents.mjs';
import { pathKey } from '../../core/context-settings.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'context-agents-pruned';
export const title = '上限で外した数が、サーバーの戻り値と保存の知らせの文まで届く（3 回目のレビュー S-2）';

export default async function (t) {
  // ---- 画面: 保存の知らせの文
  const i18n = await import('../../web/i18n.mjs');
  const { savedText } = await import('../../web/context-matrix.mjs');
  const before = i18n.lang;
  try {
    await i18n.setLanguage('ja');
    const plain = savedText(false, null);
    const places = savedText(false, { places: 2, keys: 0 });
    const keys = savedText(false, { places: 0, keys: 3 });
    const both = savedText(false, { places: 2, keys: 3 });
    t.ok('外した数が無いとき・0 のときは、上限の知らせを足さない',
      plain === '保存しました' && savedText(false, { places: 0, keys: 0 }) === '保存しました' && !plain.includes('上限'), plain);
    t.ok('場所だけ外したとき: 前の文の句点を重ねず、場所の数を言う',
      places === '保存しました。上限に届いたため、もう無いフォルダーの設定を 2 か所外しました', places);
    t.ok('キーだけ外したとき: ファイルの設定の数を言う',
      keys === '保存しました。上限に届いたため、もう無いファイルの設定を 3 件外しました', keys);
    t.ok('場所とキーの両方を外したとき: 「上限に届いたため」は 1 回だけ',
      both === '保存しました。上限に届いたため、もう無いフォルダーの設定を 2 か所、もう無いファイルの設定を 3 件外しました'
      && both.split('上限に届いたため').length === 2, both);
    await i18n.setLanguage('en');
    const enBoth = savedText(false, { places: 1, keys: 1 });
    t.ok('英語でも、無いときは足さず、両方のときは 1 文にまとめる',
      savedText(false, null) === 'Saved' && enBoth.split('limit was reached').length === 2 && /\(1\).*\(1\)/.test(enBoth), `${savedText(false, null)} | ${enBoth}`);
  } finally { await i18n.setLanguage(before); }

  // ---- サーバー: setDocRow・setDocAgent の戻り値の pruned
  const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-ctx-pruned-')));
  const home = path.join(tmp, 'home'), dataDir = path.join(tmp, 'data');
  const write = async (p, s) => { await fs.mkdir(path.dirname(p), { recursive: true }); await fs.writeFile(p, s); };
  const mkRepo = async (name) => {
    const repo = path.join(tmp, name);
    await fs.mkdir(path.join(repo, '.git'), { recursive: true });
    await write(path.join(repo, 'CLAUDE.md'), 'CLAUDE_INST');
    await write(path.join(repo, 'GEMINI.md'), 'GEMINI_INST');
    return repo;
  };
  let host, client;
  try {
    await fs.mkdir(path.join(home, '.claude'), { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    // 100 か所: 先頭 4 つはもう無いフォルダー、残りは在る。無い場所には 1 件ずつキーがある
    const places = {};
    const gone = [0, 1, 2, 3].map((i) => pathKey(path.join(tmp, 'gone', `g${i}`)));
    for (const g of gone) places[g] = { instruction: { agents: { 'file:x': { off: ['claude'], spread: [] } } } };
    for (let i = 0; i < MAX_PLACES - gone.length; i++) {
      const p = path.join(tmp, 'real', `r${i}`);
      await fs.mkdir(p, { recursive: true });
      places[pathKey(p)] = { instruction: { agents: {} } };
    }
    await fs.writeFile(path.join(dataDir, 'context-agents.json'), JSON.stringify({ version: DOC_AGENTS_VERSION, defaults: {}, places }, null, 2));
    host = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake', HOME: path.join(tmp, 'oshome'), USERPROFILE: path.join(tmp, 'oshome'), PLEIAD_SCAN_HOME: home } });
    client = await open(host);

    const repo1 = await mkRepo('repo1');
    const m1 = await client.cmd('docMatrix', { kind: 'instruction', cwd: repo1, place: repo1 });
    const row1 = m1.rows.find((r) => r.name === 'GEMINI.md');
    const claude1 = m1.rows.find((r) => r.name === 'CLAUDE.md');
    const r1 = await client.cmd('setDocRow', { kind: 'instruction', key: docItemKey(row1), on: false, place: repo1, cwd: repo1 });
    t.ok('setDocRow: 101 か所目の場所を書くと、外した場所 1 つ・キー 0 を pruned で返す',
      r1?.pruned?.places === 1 && r1?.pruned?.keys === 0, JSON.stringify(r1?.pruned));
    const disk = JSON.parse(await fs.readFile(path.join(dataDir, 'context-agents.json'), 'utf8'));
    t.ok('保存は 100 か所で、先頭の無い場所だけが外れ、新しい場所は残る',
      Object.keys(disk.places).length === MAX_PLACES && !(gone[0] in disk.places) && gone[1] in disk.places && pathKey(repo1) in disk.places);

    const r2 = await client.cmd('setDocAgent', { kind: 'instruction', key: claude1.key, agent: 'codex', on: true, place: repo1, cwd: repo1 });
    t.ok('setDocAgent: 今ある場所への書き込みは、外した数 0・0', r2?.pruned?.places === 0 && r2?.pruned?.keys === 0, JSON.stringify(r2?.pruned));

    const repo2 = await mkRepo('repo2');
    const m2 = await client.cmd('docMatrix', { kind: 'instruction', cwd: repo2, place: repo2 });
    const row2 = m2.rows.find((r) => r.name === 'CLAUDE.md');
    const r3 = await client.cmd('setDocAgent', { kind: 'instruction', key: row2.key, agent: 'codex', on: true, place: repo2, cwd: repo2 });
    t.ok('setDocAgent: 別の新しい場所を足すと、外した場所 1 つを pruned で返す', r3?.pruned?.places === 1 && r3?.pruned?.keys === 0, JSON.stringify(r3?.pruned));
  } finally {
    try { client?.close?.(); } catch {}
    try { await host?.stop?.(); } catch {}
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}
