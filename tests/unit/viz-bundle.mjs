// 可視化の束（ADR 0295 の 3 の 4。core/viz-bundle.mjs）と、記録の行の束（core/history.mjs）と、束を作る集め役（core/visualize.mjs）。
//   - HTML と同じフォルダーの下を束にする。ドットで始まる名前・node_modules・ジャンクションは入れない。データ置き場の中のものは入れない（ADR 0050）
//   - 上限（200 ファイル・32 MiB・1 ファイル 8 MiB）を超えたら HTML だけの束にして、行に理由を残す
//   - 中身は sha256 の名前で 1 つだけ。目録のハッシュが束のハッシュ。名前と中身が合わない目録は読まない
//   - 起動の片付け: 記録に名前が出ない束を消す（猶予の内は残す。記録が読めなければ何もしない）
//   - 前の版の記録（束の無い行）は、読むときに HTML だけの束を付ける（記録は書き換えない）
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BLOB_DIR, BUNDLE_LIMITS, blobPath, cleanBundle, collectBundle, entryName, htmlOnlyBundle, manifestText, readManifest, sweepVizBlobs } from '../../core/viz-bundle.mjs';
import { createVisualizationCollector } from '../../core/visualize.mjs';
import * as history from '../../core/history.mjs';
import { VISUALIZE_START as S, VISUALIZE_END as E } from '../../web/visualize-reference.mjs';

export const name = 'viz-bundle';
export const title = '可視化の束（同じフォルダーの下・除くもの・上限・同じ中身は 1 つ・片付け・前の版の記録）';

const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const paths = bundle => bundle.files.map(file => file.path).join(',');

export default async function (t) {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-viz-bundle-')));
  const dataDir = path.join(scratch, 'data');
  const access = { dataDir, uploadDir: path.join(dataDir, 'uploads') };
  try {
    await fs.mkdir(access.uploadDir, { recursive: true });
    const work = path.join(scratch, 'work');
    await fs.mkdir(path.join(work, 'assets', 'deep'), { recursive: true });
    await fs.mkdir(path.join(work, '.git'), { recursive: true });
    await fs.mkdir(path.join(work, 'node_modules', 'x'), { recursive: true });
    const entry = path.join(work, 'chart.html');
    await fs.writeFile(entry, '<img src="assets/a.png">');
    await fs.writeFile(path.join(work, 'assets', 'a.png'), 'PNG');
    await fs.writeFile(path.join(work, 'assets', 'deep', 'b.json'), '{"b":1}');
    await fs.writeFile(path.join(work, '.env'), 'SECRET=1');
    await fs.writeFile(path.join(work, '.git', 'config'), 'x');
    await fs.writeFile(path.join(work, 'node_modules', 'x', 'index.js'), 'x');
    // データ置き場の中を指すジャンクション（たどらない）と、置き場の中の秘密
    await fs.writeFile(path.join(dataDir, 'secret.txt'), 'secret');
    await fs.symlink(dataDir, path.join(work, 'linked'), 'junction');

    const bundle = await collectBundle(entry, access, { dataDir, entryBody: '<img src="assets/a.png">' });
    t.ok('HTML と同じフォルダーの下を束にし、ドットで始まる名前・node_modules・ジャンクションの先は入れない',
      bundle.htmlOnly === false && bundle.entry === 'chart.html' && paths(bundle) === 'assets/a.png,assets/deep/b.json,chart.html', paths(bundle));
    const manifest = await readManifest(dataDir, bundle.hash);
    t.ok('束のハッシュは目録の sha256 で、目録は相対パス → 中身の sha256',
      manifest && manifest['assets/a.png'] === sha('PNG') && sha(manifestText(manifest)) === bundle.hash);
    t.ok('中身は viz-blobs/<sha256> にあり、名前どおりの中身', (await fs.readFile(blobPath(dataDir, sha('PNG')), 'utf8')) === 'PNG');

    const before = (await fs.readdir(path.join(dataDir, BLOB_DIR))).length;
    const again = await collectBundle(entry, access, { dataDir, entryBody: '<img src="assets/a.png">' });
    t.ok('同じ中身はもう一度書かない（同じ束のハッシュ・ファイルの数が増えない）',
      again.hash === bundle.hash && (await fs.readdir(path.join(dataDir, BLOB_DIR))).length === before);
    const edited = await collectBundle(entry, access, { dataDir, entryBody: '<p>会話に載せた版</p>' });
    t.ok('入口はファイルを読み直さず、会話の行と同じ中身（entryBody）を使う',
      edited.hash !== bundle.hash && (await fs.readFile(blobPath(dataDir, edited.files.find(f => f.path === 'chart.html').sha256), 'utf8')) === '<p>会話に載せた版</p>');

    // 束の中のファイルも 1 つずつ ADR 0050 の検査をかける（データ置き場のアップロードの外は守られる）
    const insideData = path.join(dataDir, 'viz');
    await fs.mkdir(insideData);
    await fs.writeFile(path.join(insideData, 'x.html'), '<p>x</p>');
    let rejected = null;
    await collectBundle(path.join(insideData, 'x.html'), access, { dataDir, entryBody: '<p>x</p>' }).catch(error => { rejected = error; });
    t.ok('データ置き場の中の HTML は束にしない（protected-data）', rejected?.code === 'protected-data', rejected?.code);
    const upload = path.join(access.uploadDir, 'u');
    await fs.mkdir(upload);
    await fs.writeFile(path.join(upload, 'u.html'), '<p>u</p>');
    await fs.writeFile(path.join(upload, 'u.css'), 'p{}');
    const uploaded = await collectBundle(path.join(upload, 'u.html'), access, { dataDir, entryBody: '<p>u</p>' });
    t.ok('アップロードの中の HTML は、隣のファイルごと束にできる', paths(uploaded) === 'u.css,u.html');

    // 上限
    const many = path.join(scratch, 'many');
    await fs.mkdir(many);
    await fs.writeFile(path.join(many, 'index.html'), '<p>many</p>');
    for (let i = 0; i < 5; i++) await fs.writeFile(path.join(many, `f${i}.txt`), String(i));
    const tooMany = await collectBundle(path.join(many, 'index.html'), access, { dataDir, entryBody: '<p>many</p>', limits: { ...BUNDLE_LIMITS, files: 3 } });
    const tooLarge = await collectBundle(path.join(many, 'index.html'), access, { dataDir, entryBody: '<p>many</p>', limits: { ...BUNDLE_LIMITS, bytes: 8 } });
    await fs.writeFile(path.join(many, 'big.bin'), Buffer.alloc(64));
    const fileTooLarge = await collectBundle(path.join(many, 'index.html'), access, { dataDir, entryBody: '<p>many</p>', limits: { ...BUNDLE_LIMITS, file: 32 } });
    t.ok('上限を超えたら HTML だけの束にし、理由を残す（ファイルの数・合計・1 ファイル）',
      tooMany.htmlOnly && tooMany.reason === 'too-many-files' && paths(tooMany) === 'index.html'
      && tooLarge.htmlOnly && tooLarge.reason === 'too-large' && fileTooLarge.htmlOnly && fileTooLarge.reason === 'file-too-large');
    t.ok('既定の上限は 200 ファイル・32 MiB・1 ファイル 8 MiB',
      BUNDLE_LIMITS.files === 200 && BUNDLE_LIMITS.bytes === 32 * 1024 * 1024 && BUNDLE_LIMITS.file === 8 * 1024 * 1024);

    t.ok('入口の名前は HTML の名前だけ（区切り・ドット・HTML でないものは index.html）',
      entryName('C:/x/a b.html') === 'a b.html' && entryName('/x/.hidden.html') === 'index.html' && entryName('/x/a.txt') === 'index.html' && entryName(null) === 'index.html');
    const clean = cleanBundle({ ...bundle, extra: 'x', reason: 'Evil Reason!', files: [...bundle.files, { path: 'x', sha256: 'nothex' }] });
    t.ok('記録に残す束の形は決まった項目だけ（知らない項目・形の違うファイル・理由の形の違いを落とす）',
      clean && !('extra' in clean) && !('reason' in clean) && clean.files.length === bundle.files.length && cleanBundle({ hash: 'x' }) === null);

    // 目録の名前と中身が合わなければ読まない
    await fs.writeFile(path.join(dataDir, BLOB_DIR, 'f'.repeat(64)), manifestText({ 'a.html': sha('x') }));
    t.ok('名前と中身のハッシュが合わない目録は読まない', (await readManifest(dataDir, 'f'.repeat(64))) === null && (await readManifest(dataDir, '../x')) === null);

    // 片付け: presents/*.jsonl に名前が出る束だけ残す
    await fs.mkdir(path.join(dataDir, 'presents'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'presents', 's1.jsonl'), JSON.stringify({ kind: 'visualization', bundle: cleanBundle(bundle) }) + '\n');
    const tempName = `${'e'.repeat(64)}.${'0'.repeat(12)}.tmp`;
    await fs.writeFile(path.join(dataDir, BLOB_DIR, tempName), 'half');
    const inGrace = await sweepVizBlobs({ dataDir });
    t.ok('猶予（1 時間）の内のものは消さない', inGrace.removed === 0);
    const later = () => Date.now() + 2 * 60 * 60 * 1000;
    const swept = await sweepVizBlobs({ dataDir, now: later });
    const left = await fs.readdir(path.join(dataDir, BLOB_DIR));
    const kept = new Set([bundle.hash, ...Object.values(manifest)]);
    t.ok('猶予を過ぎた、記録に名前が出ない束と書きかけの一時ファイルを消し、記録にある束（目録と中身）は残す',
      swept.removed > 0 && left.length === kept.size && left.every(name => kept.has(name)), `${left.length} / ${kept.size}`);
    await fs.rm(path.join(dataDir, 'presents'), { recursive: true });
    await fs.mkdir(path.join(dataDir, 'presents', 'unreadable.jsonl'), { recursive: true });
    const unreadable = await sweepVizBlobs({ dataDir, now: later });
    t.ok('記録が読めなければ片付けない', unreadable.removed === 0 && (await fs.readdir(path.join(dataDir, BLOB_DIR))).length === kept.size);

    // 前の版の記録（束の無い行）。読むときに HTML だけの束を付ける
    const sessionId = `viz-bundle-${Date.now()}`;
    await history.recordPresent(sessionId, { kind: 'visualization', caption: 'c', path: 'C:/w/old.html', content: '<p>old</p>' });
    try {
      const onRows = (await history.loadTranscript(sessionId, null)).presents;
      const onAgain = (await history.loadTranscript(sessionId, null)).presents;
      const stored = await history.readPresents(sessionId);
      t.ok('前の版の行に HTML だけの束（legacy）を付け、記録の行は書き換えない',
        onRows[0].bundle?.htmlOnly === true && onRows[0].bundle.reason === 'legacy' && onRows[0].bundle.entry === 'old.html'
        && onAgain[0].bundle.hash === onRows[0].bundle.hash && !stored[0].bundle);
    } finally {
      await history.forgetPresents(sessionId).catch(() => {});
    }

    // 集め役（core/visualize.mjs）: dataDir があるときだけ束を作って行に載せる
    const ref = `${S}${JSON.stringify({ path: entry, title: 't' })}${E}`;
    const run = async deps => {
      const saved = [];
      const collector = createVisualizationCollector({ access, publish: p => saved.push(p), ...deps });
      collector.accept({ type: 'text.delta', text: ref }); collector.accept({ type: 'text.end' });
      await collector.close();
      return saved[0];
    };
    const withDir = await run({ dataDir });
    const withoutDir = await run({});
    t.ok('集め役は dataDir があるときだけ束を作って行に載せる（無ければ今のまま）',
      withDir.bundle?.entry === 'chart.html' && paths(withDir.bundle) === 'assets/a.png,assets/deep/b.json,chart.html' && !('bundle' in withoutDir));
    const recorded = await history.recordPresent(`${sessionId}-2`, withDir);
    t.ok('記録の行は束を持つ（決まった形で）', recorded.bundle?.hash === withDir.bundle.hash && recorded.bundle.files.length === 3);
    await history.forgetPresents(`${sessionId}-2`).catch(() => {});
    const failing = await run({ dataDir: path.join(scratch, 'not-a-dir', '\u0000') });
    t.ok('束を作れなくても可視化は出す（束は無し）', typeof failing.content === 'string' && !failing.error && !('bundle' in failing));
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}
