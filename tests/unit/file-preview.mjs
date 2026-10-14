import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileReference } from '../../web/file-reference.mjs';
import { parseTable } from '../../web/file-preview-content.mjs';
import { renderMarkdown } from '../../web/render.mjs';
import { startServer } from '../lib/server.mjs';
export const name = 'file-preview';
export const title = 'ファイル参照・作業場所・認証・表示上限・ダウンロード';

export default async function(t) {
  assert.deepEqual(fileReference('D:/日本語/a b.ts:42:9'), {path:'D:/日本語/a b.ts',line:42});
  assert.deepEqual(fileReference('./docs/readme.md#L12'), {path:'./docs/readme.md',line:12});
  assert.deepEqual(fileReference('code.mjs:42'), {path:'code.mjs',line:42});
  assert.deepEqual(fileReference('LICENSE'), {path:'LICENSE',line:null});
  assert(renderMarkdown('[code](code.mjs:42)').includes('data-file-line="42"'));
  assert.deepEqual(fileReference('file:///D:/a%20b.md'), {path:'D:/a b.md',line:null});
  assert.deepEqual(fileReference('/D:/a.md'), {path:'D:/a.md',line:null});
  for (const input of ['https://example.com/a.md','//host/a','\\\\host\\a','javascript:alert(1)','data:text/html,x','#heading','a\0.md']) assert.equal(fileReference(input),null,input);
  const markdown = renderMarkdown('[file](<D:/a b.ts:42>) [site](https://example.com)');
  assert(markdown.includes('data-file-line="42"')); assert.equal((markdown.match(/target="_blank"/g)||[]).length,1);
  t.ok('Windows・空白・日本語・行指定を保持し、Webリンクと危険なスキームを分離',true);
  assert.deepEqual(parseTable('a,b\r\n"x,y","one\ntwo"\r\n"a""b",',',').rows,[['a','b'],['x,y','one\ntwo'],['a"b','']]);
  assert.equal(parseTable('a\nb\nc',',',2).truncated,true);
  assert.deepEqual(parseTable('a\tb\n1\t2','\t').rows,[['a','b'],['1','2']]);
  t.ok('CSVの引用符・改行・TSV・表示上限を扱う',true);

  const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'ply-preview-'));
  const one=path.join(scratch,'one'),two=path.join(scratch,'two'),data=path.join(scratch,'data');
  await Promise.all([one,two,data].map(p=>fs.mkdir(p)));
  await fs.writeFile(path.join(one,'日本語 file.md'),'# old workspace\n\n|a|b|\n|---|---|\n|1|2|');
  await fs.writeFile(path.join(two,'日本語 file.md'),'# new workspace');
  await fs.writeFile(path.join(one,'unsafe.html'),'<script>parent.evil=true</script><h1>Test</h1>');
  await fs.writeFile(path.join(one,'cover.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  await fs.writeFile(path.join(one,'binary.zip'),Buffer.from([0,1,2,3]));
  await fs.writeFile(path.join(one,'large.md'),'a'.repeat(8*1024*1024+1));
  await fs.writeFile(path.join(one,'empty.txt'),'');
  await fs.writeFile(path.join(one,'large.css'),' '.repeat(600*1024));
  await fs.writeFile(path.join(scratch,'secret.txt'),'private');
  await fs.writeFile(path.join(data,'sessions.json'),JSON.stringify({fixture:{cwd:two,backend:'fake',history:[{field:'cwd',at:'2026-09-15T12:00:00Z',from:one,to:two}]}}));
  const server=await startServer({dataDir:data,env:{AGENT_HOST_BACKENDS:'fake'}});
  const origin=`http://127.0.0.1:${server.port}`,auth={headers:{cookie:`agent_host_token=${server.token}`}};
  const url=(file,extra={})=>`${origin}/file-preview?${new URLSearchParams({path:file,sessionId:'fixture',...extra})}`;
  try {
    assert.equal((await fetch(url('日本語 file.md'))).status,401);
    const old=await (await fetch(url('日本語 file.md:2',{at:'2026-09-15T11:00:00Z'}),auth)).json();
    assert.equal(old.kind,'markdown'); assert.equal(old.line,2); assert.equal(old.path,await fs.realpath(path.join(one,'日本語 file.md'))); assert(old.text.includes('old workspace'));
    const current=await (await fetch(url('日本語 file.md',{at:'2026-09-15T13:00:00Z'}),auth)).json();
    assert(current.text.includes('new workspace'));
    const ambiguous=await (await fetch(url('日本語 file.md'),auth)).json(); assert.equal(ambiguous.error.code,'cwd-unknown');
    const nested=await (await fetch(url('日本語 file.md',{base:path.join(one,'unsafe.html')}),auth)).json(); assert(nested.text.includes('old workspace'));
    t.ok('認証が必要。作業場所変更後も発言時点と文書内リンクの基準を保持',true);
    const html=await (await fetch(url(path.join(one,'unsafe.html')),auth)).json(); assert.equal(html.kind,'html'); assert(html.text.includes('<script>'));
    const svg=await (await fetch(url(path.join(one,'cover.svg')),auth)).json(); assert.equal(svg.mime,'image/svg+xml'); assert(svg.data);
    const empty=await (await fetch(url(path.join(one,'empty.txt')),auth)).json(); assert.equal(empty.text,'');
    const binary=await (await fetch(url(path.join(one,'binary.zip')),auth)).json(); assert.equal(binary.kind,'unsupported'); assert(!binary.text); assert(binary.downloadable);
    const large=await (await fetch(url(path.join(one,'large.md')),auth)).json(); assert.equal(large.kind,'unsupported'); assert(!large.text); assert(large.downloadable);
    const resource=await (await fetch(url(path.join(one,'large.css'),{resource:'1'}),auth)).json(); assert.equal(resource.kind,'unsupported'); assert(!resource.text);
    const missing=await fetch(url(path.join(one,'missing.md')),auth); assert.equal(missing.status,404); assert.equal((await missing.json()).error.code,'not-found');
    const directory=await (await fetch(url(one),auth)).json();
    assert.equal(directory.kind,'directory');
    assert.equal(directory.downloadable,false);
    assert(Array.isArray(directory.items));
    assert(directory.items.some(it=>it.name==='日本語 file.md'&&it.kind==='file'));
    assert(Array.isArray(directory.tree));
    const outsideDir=await (await fetch(url(scratch),auth)).json(); assert.equal(outsideDir.kind,'directory');
    assert(!outsideDir.items.some(item => item.name === 'data'));
    assert(!JSON.stringify(outsideDir.tree).includes('pleiad.db'));
    const outside=await (await fetch(url(path.join(scratch,'secret.txt')),auth)).json(); assert.equal(outside.text,'private');
    await fs.symlink(scratch,path.join(one,'escape'),process.platform==='win32'?'junction':'dir');
    const symlink=await (await fetch(url(path.join(one,'escape/secret.txt')),auth)).json(); assert.equal(symlink.text,'private');
    const based=await (await fetch(url('secret.txt',{base:path.join(scratch,'secret.txt')}),auth)).json(); assert.equal(based.text,'private');
    for (const target of [data, path.join(data,'pleiad.db'), path.join(one,'escape/data/pleiad.db')]) {
      const denied=await (await fetch(url(target),auth)).json(); assert.equal(denied.error.code,'protected-data');
    }
    const deniedBase=await (await fetch(url('secret.txt',{base:path.join(data,'pleiad.db')}),auth)).json(); assert.equal(deniedBase.error.code,'protected-data');
    const upload=path.join(data,'uploads','attachment.txt');
    await fs.mkdir(path.dirname(upload),{recursive:true}); await fs.writeFile(upload,'attachment');
    const attachment=await (await fetch(url(upload),auth)).json(); assert.equal(attachment.text,'attachment');
    t.ok('種類・上限・欠損と相対解決を維持し、作業場所外は許可、データ置き場はリンク経由も拒否、添付は許可',true);
    const download=await fetch(`${origin}/local-file?${new URLSearchParams({path:path.join(one,'unsafe.html'),download:'1'})}`,auth);
    assert(download.headers.get('content-disposition').startsWith('attachment')); assert.equal(download.headers.get('content-type'),'application/octet-stream');
    assert.equal((await fetch(`${origin}/vendor/pdfjs/build/pdf.mjs`)).status,401);
    assert.equal((await fetch(`${origin}/vendor/pdfjs/build/pdf.mjs`,auth)).status,200);
    assert.equal((await fetch(`${origin}/vendor/pdfjs/package.json`,auth)).status,404);
    t.ok('保存は添付として配信。PDFブラウザー資源にも認証が必要',true);
  } finally {await server.stop();await fs.rm(scratch,{recursive:true,force:true});}
}
