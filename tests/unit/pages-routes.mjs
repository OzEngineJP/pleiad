import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createPagesRoutes } from '../../core/pages-routes.mjs';
import { resolveReference, PreviewError } from '../../core/file-preview.mjs';
import { createPageWatch } from '../../core/page-watch.mjs';

export const name = 'pages-routes';
export const title = 'Pleiad のページ: 会話の範囲・読み取り API・CSP・上限・共通の資材';

function pdfFile() {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '<< /Length 43 >>\nstream\nBT /F1 18 Tf 40 240 Td (Pleiad PDF) Tj ET\nendstream'];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const offset = body.length;
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
  return body;
}

/** A disposable host with real file policy and fake read-only git/context operations. */
export async function createFixture() {
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-pages-')));
  const cwd = path.join(scratch, 'work'), dataDir = path.join(scratch, 'data'), uploadDir = path.join(dataDir, 'uploads');
  await fs.mkdir(cwd); await fs.mkdir(uploadDir, { recursive:true }); await fs.mkdir(path.join(cwd, 'notes'));
  await Promise.all(Object.entries({
    'README.md':'# ブラウザー統合\n\nファイルと会話を同じ場所で扱います。\n\n## この変更でできること\n\n- ファイルをタブで開く\n- 作業フォルダーから探す\n\n```js\nconst preview = true;\n```\n\n[メモ](notes/note.md)\n\n[コード](app.mjs:2)\n\n<script>globalThis.untrusted = true</script>',
    'notes/note.md':'# 作業メモ\n\n確認が終わったファイルです。',
    'app.mjs':'export const ready = true;\nconsole.log(ready);',
    'long.txt':Array.from({ length:6001 }, (_, i) => `line ${i + 1}`).join('\n'),
    'table.csv':Array.from({ length:503 }, (_, i) => i ? `${i},タスク ${i},完了` : '番号,項目,状態').join('\n'),
    'table.tsv':'name\tvalue\nalpha\t2',
    'index.html':'<h1>isolated HTML</h1><script>parent.untrusted = true</script>',
    'shape.svg':'<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#5364aa"/><script>parent.untrusted = true</script></svg>',
    'manual.pdf':pdfFile(),
  }).map(([file, content]) => fs.writeFile(path.join(cwd, file), content)));
  await fs.writeFile(path.join(dataDir, 'secret.json'), '{"secret":"not public"}');
  await fs.writeFile(path.join(uploadDir, 'alpha.txt'), 'attachment alpha');
  await fs.writeFile(path.join(uploadDir, 'beta.txt'), 'attachment beta');
  const sessions = { alpha:{ title:'ブラウザー統合', cwd }, beta:{ cwd:scratch }, review:{ cwd } };
  const calls = [], issued = [], watched = [], vizCalls = [];
  const pageWatch = createPageWatch({ watch:() => ({ close() {} }) });
  const env = { lang:'ja', theme:'light' };
  const deps = {
    store:{ getAll:async () => sessions, getPrefs:async () => ({ theme:env.theme }) },
    fileRoots:() => [cwd],
    fileAccessFor:id => ({ dataDir, uploadDir, ...(id === 'review' ? { confine:cwd } : {}), guard:file => {
      if (path.basename(file) === 'beta.txt' && id !== 'beta') throw new PreviewError('access-denied', 'owner');
    } }),
    resolveSessionFile:async ({ path:raw, sessionId, base }) => ({ ...resolveReference(raw, base ? path.dirname(base) : sessions[sessionId].cwd), cwd:sessions[sessionId].cwd }),
    ports:() => ({ main:0, pages:0, isolated:49199 }), env:() => env,
    recentFiles:id => id === 'alpha' ? [{ path:path.join(cwd, 'README.md'), source:'edited' }, { path:path.join(dataDir, 'secret.json'), source:'read' }, { path:path.join(uploadDir, 'beta.txt'), source:'attached' }] : [],
    htmlKeys:{ issue:async args => { issued.push(args); return 'fixture-key'; } },
    watch:{ add:(...args) => { watched.push(args); pageWatch.add(...args); } },
    secret:crypto.randomBytes(32),
    visualizations:id => id === 'alpha' ? [
      { title:'図', url:'http://localhost:49199/viz/abc/index.html?embed=tab', hash:'a'.repeat(64), entry:'index.html', path:path.join(cwd, 'index.html'), at:'2026-11-06T00:10:00Z' },
      { title:'消えた', url:'http://localhost:49199/viz/def/index.html?embed=tab', hash:'b'.repeat(64), entry:'index.html', path:path.join(cwd, 'gone.html'), at:'2026-11-06T00:11:00Z' },
      { title:'元なし', url:'http://localhost:49199/viz/ghi/index.html?embed=tab', hash:'c'.repeat(64), entry:'index.html', at:'2026-11-06T00:12:00Z' },
      { title:'外', url:'http://localhost:5173/viz/abc/index.html' },
    ] : [],
    vizEntry:async (id, hash, entry) => { vizCalls.push([id, hash, entry]); return id === 'alpha' && hash === 'a'.repeat(64) && entry === 'index.html' ? '<h1>saved viz</h1>' : null; },
    ops:async (actor, id, input) => {
      calls.push({ actor, id, input });
      let result;
      if (id === 'git.status') result = { git:{ root:cwd, branch:'feat/browser-unify' } };
      else if (id === 'git.changes') result = { git:{ root:cwd, branch:'feat/browser-unify', head:'a'.repeat(40) }, changes:{ hasSession:true, files:[{ path:'app.mjs', state:'M', add:1, del:1 }], total:{ files:1, add:1, del:1 } } };
      else if (id === 'git.history') result = { history:{ root:cwd, head:'a'.repeat(40), next:null, session:null, commits:[{ hash:'a'.repeat(40), short:'aaaaaaa', parents:[], author:'Pleiad', at:Date.now(), refs:[{ kind:'head', name:'feat/browser-unify' }], subject:'ファイルをページで開く' }] } };
      else if (id === 'git.commit') result = { commit:{ commit:{ hash:input.hash, short:input.hash.slice(0, 7), subject:'ファイルをページで開く', author:'Pleiad', at:Date.now(), parents:[] }, files:[{ path:'app.mjs', state:'M', add:1, del:1 }], total:{ files:1, add:1, del:1 } } };
      else if (id === 'git.worktrees') result = { worktrees:{ total:2, partial:input.only === 'list', base:{ path:input.sessionId === 'review' ? dataDir : cwd, branch:'main' }, rows:[{ path:cwd, branch:'feat/browser-unify', exists:true, kind:'here', main:true, dirty:1 }, { path:path.join(cwd, 'notes'), branch:'feat/notes', exists:true, kind:'left', leftover:{ id:'notes', mergeSessionId:'alpha' } }] } };
      else if (id === 'git.worktree') result = { worktree:{ committed:{ files:[] }, uncommitted:{ files:[{ path:'app.mjs', state:'M' }] } } };
      else if (id === 'git.prs') result = { prs:[] };
      else if (id === 'git.diff') result = { diff:{ hunks:[{ oldStart:1, oldCount:1, newStart:1, newCount:1, lines:[{ t:'-', s:'export const ready = false;' }, { t:'+', s:'export const ready = true;' }] }] } };
      else if (id === 'context.session') result = { report:{ entries:[{ id:'instruction', kind:'instruction', path:path.join(cwd, 'README.md'), name:'作業の指示', status:'supplied', content:'private injected context' }, { id:'secret', kind:'instruction', path:path.join(dataDir, 'secret.json'), name:'secret', status:'supplied' }, { id:'skill', kind:'skill', name:'画面の確認', status:'supplied' }, { id:'mcp', kind:'mcp', name:'Pleiad', status:'connected', env:{ SECRET:'must not leak' } }] } };
      else result = { git:null };
      return { ok:true, result };
    },
  };
  const routes = createPagesRoutes(deps);
  const server = http.createServer((req, res) => routes.handle(req, res, { url:new URL(req.url, 'http://localhost'), via:req.headers['x-test-via'] === 'main' ? 'main' : 'pages' }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const url = (route, params = {}, id = 'alpha') => `${origin}/_pleiad/s/${id}/${route}?${new URLSearchParams(params)}`;
  const close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); pageWatch.close(); await fs.rm(scratch, { recursive:true, force:true }); };
  return { cwd, scratch, dataDir, uploadDir, origin, url, close, calls, issued, watched, vizCalls, env, sessions, pageWatch };
}

export default async function (t) {
  const f = await createFixture();
  const get = async (route, params, id, headers) => { const r = await fetch(f.url(route, params, id), { headers }); return { status:r.status, body:await r.json(), headers:r.headers }; };
  try {
    const file = await get('api/preview', { path:'README.md' });
    t.ok('既存のプレビューで Markdown と取得時刻・大きさ・ツリーを返す', file.status === 200 && file.body.kind === 'markdown' && file.body.fetchedAt && file.body.size > 0 && file.body.tree.length === 1);
    const relative = await get('api/preview', { path:'note.md', base:path.join(f.cwd, 'notes/note.md') });
    t.ok('Markdown の資源は指定したファイルを基準に解決する', relative.body.name === 'note.md');
    const dir = await get('api/preview', { path:f.cwd });
    t.ok('フォルダーの一覧とツリーの読み取り', dir.body.kind === 'directory' && dir.body.items.some(i => i.name === 'notes'));
    const tree = await get('api/tree', { path:f.cwd });
    t.ok('遅延ツリー API は共通の検査とページングを使う', tree.status === 200 && tree.body.children.some(i => i.name === 'README.md'));
    await get('api/preview', { path:path.join(f.cwd, 'README.md'), watchOwner:'screen:1/page:preview' });
    await get('api/tree', { path:f.cwd, watchOwner:'screen:1/page:tree' });
    t.ok('ページ API はタブの所有者をファイル見張りへ渡す',
      f.watched.some(args => args[1] === path.join(f.cwd, 'README.md') && args[3] === 'screen:1/page:preview')
      && f.watched.some(args => args[1] === f.cwd && args[3] === 'screen:1/page:tree'));
    f.pageWatch.removeClient('screen:1');
    f.pageWatch.removeClient('·');
    const oldLocation = globalThis.location, oldFetch = globalThis.fetch, oldWindow = globalThis.window, oldMatchMedia = globalThis.matchMedia;
    try {
      globalThis.location = new URL(f.url('file', { path:path.join(f.cwd, 'README.md'), watchOwner:'screen:1/page:real' }));
      globalThis.fetch = (input, init) => oldFetch(new URL(input, f.origin), init);
      globalThis.window = { addEventListener() {} };
      globalThis.matchMedia = () => ({ matches:false, addEventListener() {} });
      const bridgeUrl = new URL('../../web/pages/bridge.mjs', import.meta.url); bridgeUrl.searchParams.set('test', String(Date.now()));
      const bridge = await import(bridgeUrl.href);
      const response = await bridge.api('preview', { path:path.join(f.cwd, 'README.md'), content:'raw' });
      t.ok('実ページの bridge.api → api/preview が URL の watchOwner を送り、タブ終了で見張りを外す',
        response.kind === 'markdown' && f.watched.some(args => args[1] === path.join(f.cwd, 'README.md') && args[3] === 'screen:1/page:real')
        && f.pageWatch.stats().targets === 1);
      f.pageWatch.remove('alpha', path.join(f.cwd, 'README.md'), 'file', 'screen:1/page:real');
      t.ok('ページのタブを閉じると、そのタブが作った見張りが 0 件になる', f.pageWatch.stats().targets === 0);
      globalThis.location = new URL(f.url('file', { path:path.join(f.cwd, 'README.md'), watchOwner:'screen:2/page:real' }));
      const otherBridgeUrl = new URL('../../web/pages/bridge.mjs', import.meta.url); otherBridgeUrl.searchParams.set('test', String(Date.now() + 1));
      const otherBridge = await import(otherBridgeUrl.href);
      await otherBridge.api('preview', { path:path.join(f.cwd, 'README.md'), content:'raw' });
      f.pageWatch.removeClient('screen:2');
      t.ok('画面を閉じるとその画面のページが作った見張りも 0 件になる', f.pageWatch.stats().targets === 0);
    } finally { globalThis.location = oldLocation; globalThis.fetch = oldFetch; globalThis.window = oldWindow; globalThis.matchMedia = oldMatchMedia; }
    for (const route of ['api/preview', 'api/raw', 'api/tree', 'api/html-key']) {
      const denied = await get(route, { path:path.join(f.dataDir, 'secret.json') });
      t.ok(`${route}: 保護されたデータを表示しない`, denied.status === 403 && denied.body.error.code === 'protected-data' && !JSON.stringify(denied.body).includes('not public'));
      const confined = await get(route, { path:path.join(f.uploadDir, 'alpha.txt') }, 'review');
      t.ok(`${route}: レビューの作業フォルダーに閉じ込める`, confined.status === 403);
    }
    const baseDenied = await get('api/preview', { path:'README.md', base:path.join(f.dataDir, 'secret.json') });
    t.ok('相対パスの基準にも会話の検査をかける', baseDenied.status === 403);
    const owner = await get('api/raw', { path:path.join(f.uploadDir, 'beta.txt') });
    t.ok('ほかの会話だけが使える添付を断る', owner.status === 403);
    const missing = await get('api/env', {}, 'missing');
    const mismatch = await get('api/env', { sessionId:'beta' });
    t.ok('存在しない会話と URL と異なる会話の指定を断る', missing.status === 404 && mismatch.status === 403);
    const method = await fetch(f.url('api/git'), { method:'POST' });
    t.ok('書き込みの HTTP メソッドを受けない', method.status === 405 && method.headers.get('allow') === 'GET, HEAD');
    const main = await fetch(f.url('file', { path:'README.md' }), { headers:{ 'x-test-via':'main' } });
    const page = await fetch(f.url('file', { path:'README.md' }));
    t.ok('同じページを配り入口で frame-ancestors を変える', main.status === 200 && page.status === 200 && main.headers.get('content-security-policy').includes("frame-ancestors 'self'") && page.headers.get('content-security-policy').includes("frame-ancestors 'none'") && await main.text() === await page.text());
    t.ok('CSP は隔離 origin だけを iframe に許す', page.headers.get('content-security-policy').includes('frame-src http://localhost:49199') && page.headers.get('referrer-policy') === 'no-referrer' && page.headers.get('x-content-type-options') === 'nosniff');
    const head = await fetch(f.url('file'), { method:'HEAD' });
    t.ok('HEAD はヘッダーだけを返す', head.status === 200 && await head.text() === '' && Number(head.headers.get('content-length')) > 0);
    const raw = await fetch(f.url('api/raw', { path:'index.html' }));
    t.ok('HTML の原本を同じ origin で実行しない', raw.headers.get('content-type') === 'application/octet-stream' && raw.headers.get('content-disposition').startsWith('attachment') && raw.headers.get('content-security-policy').includes('sandbox'));
    const key = await get('api/html-key', { path:'index.html' });
    t.ok('HTML は A3 の鍵とフォルダーの印の出どころの隔離 URL を返す', /^http:\/\/f[0-9a-f]{16}\.localhost:49199\/f\/fixture-key\/index\.html$/.test(key.body.url) && f.issued[0].sessionId === 'alpha');
    t.ok('鍵に会話のファイルの検査の範囲を渡す（隔離の側も同じ範囲で読む）', f.issued[0].access?.dataDir === f.dataDir && Array.isArray(f.issued[0].once) && f.issued[0].once.length === 0);
    const onceParams = new URLSearchParams([['path', 'index.html'], ...Array.from({ length:60 }, (_, i) => ['once', `https://cdn${i}.example`])]);
    await fetch(`${f.origin}/_pleiad/s/alpha/api/html-key?${onceParams}`);
    t.ok('「一度だけ読み込む」の出どころを鍵へ渡す（50 まで）', f.issued.length === 2 && f.issued[1].once.length === 50 && f.issued[1].once[0] === 'https://cdn0.example');
    const invalidKey = await get('api/html-key', { path:'README.md' });
    t.ok('HTML 以外に鍵を発行しない', invalidKey.status === 400 && f.issued.length === 2);
    const devicePorts = JSON.stringify({ main:43001, pages:43001, isolated:43002 });
    const deviceKey = await get('api/html-key', { path:'index.html' }, 'alpha', { 'x-test-via':'main', 'x-pleiad-page-ports':devicePorts });
    const deviceEnv = await get('api/env', {}, 'alpha', { 'x-test-via':'main', 'x-pleiad-page-ports':devicePorts });
    t.ok('スマホの道（本体の入口の x-pleiad-page-ports）: 隔離の URL と api/env を端末の port にする',
      deviceKey.body.url === 'http://localhost:43002/f/fixture-key/index.html' && deviceEnv.body.isolatedPort === 43002);
    const pagesHeader = await get('api/env', {}, 'alpha', { 'x-pleiad-page-ports':devicePorts });
    const malformed = await Promise.all([
      JSON.stringify({ main:43001, pages:43001 }), JSON.stringify({ main:43001, pages:43001, isolated:70000 }), JSON.stringify({ main:43001, pages:43001, isolated:43002, extra:1 }),
      JSON.stringify([43001, 43001, 43002]), JSON.stringify({ main:'43001', pages:43001, isolated:43002 }), '{', 'x'.repeat(300),
    ].map(value => get('api/env', {}, 'alpha', { 'x-test-via':'main', 'x-pleiad-page-ports':value })));
    t.ok('x-pleiad-page-ports は本体の入口でだけ読み、形の違うもの（欠け・範囲外・余分・文字列・壊れた JSON・長すぎ）は使わない',
      pagesHeader.body.isolatedPort === 49199 && malformed.every(r => r.status === 200 && r.body.isolatedPort === 49199));
    const metadata = await get('api/preview', { path:'shape.svg', content:'raw' });
    const textMetadata = await get('api/preview', { path:'README.md', content:'raw' });
    t.ok('ページの本文は JSON の base64・エスケープで膨らませず原本の口で読む', metadata.body.content.binary && metadata.body.content.text && !metadata.body.data && !metadata.body.text && textMetadata.body.content.text && !textMetadata.body.text);
    await get('api/git', { kind:'diff', path:'app.mjs', sessionId:'alpha', cwd:f.scratch });
    const call = f.calls.at(-1);
    t.ok('git は URL の会話と許可した読み取り引数だけを渡す', call.id === 'git.diff' && call.input.sessionId === 'alpha' && !Object.hasOwn(call.input, 'cwd'));
    const write = await get('api/git', { kind:'commitRun' });
    t.ok('git の書き込み操作を選べない', write.status === 400);
    const deleted = await get('api/git', { kind:'diff', path:'deleted/sub/file.mjs' });
    t.ok('削除済みのファイルも実在する親を検査して差分を読める', deleted.status === 200 && deleted.body.diff.hunks.length > 0);
    f.sessions.alpha.cwd = path.join(f.cwd, 'notes');
    const nested = await get('api/git', { kind:'diff', path:'app.mjs' });
    t.ok('会話の作業場所がサブフォルダーでも Git のルートから検査する', nested.status === 200);
    f.sessions.alpha.cwd = f.cwd;
    const traversal = await get('api/git', { kind:'diff', path:'../data/secret.json' });
    const confinedGit = await get('api/git', { kind:'diff', path:'../elsewhere/deleted.txt' }, 'review');
    t.ok('削除パスの検査でもリポジトリ外の参照を断る', traversal.status === 400 && confinedGit.status === 400);
    const rename = await get('api/git', { kind:'diff', path:'app.mjs', orig:'../data/secret.json' });
    const worktreeDenied = await get('api/git', { kind:'worktree', worktree:f.dataDir });
    const worktree = await get('api/git', { kind:'worktree', worktree:f.cwd });
    t.ok('改名前のパスと Worktree も会話のファイル検査を通す', rename.status === 400 && worktreeDenied.status === 403 && worktree.body.worktree.uncommitted.files.length === 1);
    const literal = [];
    for (const value of ['notes/[ab].md', '[id].mjs', '*.mjs', 'file?.mjs']) {
      const r = await get('api/git', { kind:'diff', path:value });
      literal.push(r.status === 200 && f.calls.at(-1).id === 'git.diff' && f.calls.at(-1).input.path === value);
    }
    t.ok('記号を含む名前はそのまま git へ渡す（core/git-info.mjs が GIT_LITERAL_PATHSPECS=1 で文字どおりに読む）', literal.every(Boolean));
    const specs = await Promise.all([':(glob)**', 'a:b', 'notes\\note.md'].map(value => get('api/git', { kind:'diff', path:value })));
    const origSpec = await get('api/git', { kind:'diff', path:'app.mjs', orig:':(glob)*' });
    t.ok('`:`（Windows のドライブ相対）とバックスラッシュの名前は断る', specs.every(r => r.status === 400) && origSpec.status === 400);
    const confinedWorktrees = await get('api/git', { kind:'worktrees' }, 'review');
    t.ok('Worktree の基準の場所も閉じ込めの範囲外なら隠す', confinedWorktrees.body.worktrees.base === null);
    await get('api/git', { kind:'changes', only:'light' });
    t.ok('git の初回表示から暗黙の Worktree 整理を起こさない', f.calls.at(-1).input.only === 'changes');
    const history = await get('api/git', { kind:'history', through:'true', cursor:'cursor' });
    t.ok('既存グラフの履歴の追加読み込み引数を渡す', history.status === 200 && f.calls.at(-1).input.through === true && f.calls.at(-1).input.cursor === 'cursor');
    const plugins = await get('api/plugins');
    t.ok('プラグインの一覧は保護されたパス・設定・注入した本文を返さない', plugins.body.report.entries.length === 3 && !JSON.stringify(plugins.body).includes('SECRET') && !JSON.stringify(plugins.body).includes('private injected'));
    const recent = await get('api/recent');
    t.ok('最近のファイルは会話の範囲を検査し重複を除く', recent.body.files.some(e => e.name === 'README.md' && e.source === 'edited') && recent.body.files.filter(e => e.name === 'README.md').length === 1 && !recent.body.files.some(e => ['beta.txt', 'secret.json'].includes(e.name)));
    t.ok('可視化はこの会話の隔離の origin のものだけ出す', recent.body.visualizations.length === 3 && recent.body.visualizations[0].url === 'http://localhost:49199/viz/abc/index.html?embed=tab');
    const [vizRow, goneRow, noPathRow] = recent.body.visualizations;
    const realIndex = await fs.realpath(path.join(f.cwd, 'index.html'));
    t.ok('可視化は束の印・入口・時刻と、検査した実体の元のパスを載せる',
      vizRow.hash === 'a'.repeat(64) && vizRow.entry === 'index.html' && vizRow.path === realIndex && vizRow.at === '2026-11-06T00:10:00Z' && vizRow.missing !== true, JSON.stringify(vizRow));
    t.ok('元のファイルが消えたものだけ missing を付けてパスを残す（元の記録が無いものは missing ではない）',
      goneRow.missing === true && goneRow.path === path.join(f.cwd, 'gone.html') && !Object.hasOwn(noPathRow, 'path') && noPathRow.missing !== true, JSON.stringify(recent.body.visualizations));
    const vizSave = await fetch(f.url('api/viz', { hash:'a'.repeat(64), entry:'index.html' }));
    t.ok('api/viz は会話の記録にある束の HTML を返す', vizSave.status === 200 && (await vizSave.text()) === '<h1>saved viz</h1>' && f.vizCalls[0][0] === 'alpha');
    const vizBad = await Promise.all([{ hash:'d'.repeat(64), entry:'index.html' }, { hash:'a'.repeat(64), entry:'other.html' }, { hash:'not-a-hash', entry:'index.html' }]
      .map(async params => (await fetch(f.url('api/viz', params))).status));
    const vizOther = await fetch(f.url('api/viz', { hash:'a'.repeat(64), entry:'index.html' }, 'beta'));
    t.ok('api/viz は形の外・ほかの会話の束を 404 で断る', vizBad.every(status => status === 404) && vizOther.status === 404);
    const deviceRecent = await get('api/recent', {}, 'alpha', { 'x-test-via':'main', 'x-pleiad-page-ports':JSON.stringify({ main:43001, pages:43001, isolated:43002 }) });
    t.ok('スマホの道では可視化の URL を端末の隔離の port にする', deviceRecent.body.visualizations[0].url === 'http://localhost:43002/viz/abc/index.html?embed=tab');
    const other = await get('api/recent', {}, 'beta');
    t.ok('最近開いたファイルをほかの会話に混ぜない', other.body.files.length === 0 && recent.body.folders[0].path === f.cwd);
    const big = path.join(f.cwd, 'large.txt'); await fs.writeFile(big, 'x'.repeat(8 * 1024 * 1024 + 1));
    const limit = await get('api/preview', { path:big });
    t.ok('テキストの 8 MiB 上限と翻訳前のコードを維持する', limit.body.kind === 'unsupported' && limit.body.reasonCode === 'over-limit' && !Object.hasOwn(limit.body, 'text') && !Object.hasOwn(limit.body, 'reason'));
    const huge = path.join(f.cwd, 'huge.bin'); const h = await fs.open(huge, 'w'); await h.truncate(32 * 1024 * 1024 + 1); await h.close();
    const rawLimit = await get('api/raw', { path:huge });
    t.ok('原本は 32 MiB を超えて読まない', rawLimit.status === 400);
    const network = await get('api/preview', { path:'//host/share/file' });
    t.ok('UNC を解決する前に断る', network.body.error.code === 'network-path');
    for (const asset of ['pages/app.mjs', 'pages/pages.css', 'file-preview-content.mjs', 'git-diff.mjs', 'locales/ja/pages.json']) {
      const result = await fetch(`${f.origin}/_pleiad/assets/${asset}`); assert.equal(result.status, 200);
    }
    const module = await fetch(`${f.origin}/_pleiad/assets/i18n.mjs`);
    t.ok('共通の i18n は自己 origin のモジュールとして配る', (await module.text()).includes("from '/_pleiad/vendor/i18next.mjs'"));
    for (const suffix of ['%2e%2e%2fcore%2fserver.mjs', 'pages/index.html', 'locales/ja/../../index.html']) {
      const r = await fetch(`${f.origin}/_pleiad/assets/${suffix}`); assert.notEqual(r.status, 200);
    }
    t.ok('公開モジュールの口は任意のファイルや HTML を配らない', true);
    f.env.lang = 'en'; f.env.theme = 'dark';
    const env = await get('api/env');
    t.ok('言語・テーマをページへ渡す', env.body.lang === 'en' && env.body.theme === 'dark');
  } finally { await f.close(); }
}
