// Run with a fresh isolated fake session; no OS clipboard or external backend.
async (page, { screenshot } = {}) => {
 const checks=[], evidence=[], K=page.keyboard;
 const stable=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
 const check=(name,got,want=true)=>checks.push({name,passed:stable(got)===stable(want),got,want});
 const snap=()=>page.evaluate(async()=>{const p=document.querySelector('#prompt');const { posToOffset } = await import('/md-doc.mjs'), st0 = p.editor.getState(), lines0 = p.value.split('\n'); const lineAt = i => p.value.slice(0, posToOffset(st0.blocks, { b: i, v: 0 })).split('\n').length - 1; const sepOf = i => (i > 0 && lineAt(i) - lineAt(i - 1) > 1 ? lines0[lineAt(i) - 1] : null);return {active:document.activeElement?.id,disabled:p.disabled,readonly:p.readOnly,dialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.id),raw:p.value,rows:p.children.length,kinds:[...p.children].map(d=>d.dataset.k),before:[...p.children].map((d,i)=>sepOf(i)),sel:p.editor.getState().sel.s}});
 const reset=text=>page.evaluate(text=>{const p=document.querySelector('#prompt');p.value=text;p.focus();p.setSelectionRange(p.value.length,p.value.length)},text);
 const ready=async()=>{await page.waitForTimeout(3000);if(await page.evaluate(()=>!!document.querySelector('#onboardingDialog[open]'))){if(screenshot)await screenshot();await page.evaluate(()=>document.querySelector('#closeOnboarding').click())}await page.waitForTimeout(150)};
 const exit=async()=>{await reset('');await K.type('>');await K.press('Space');await K.type('保存');await K.press('Enter');await K.type('外');await K.press('Home');await K.press('Backspace')};
 await ready();await exit();await K.press('Control+Enter');await page.waitForTimeout(2400);
 const history=await page.evaluate(()=>{const b=[...document.querySelectorAll('#log .m.user .body')].find(b=>b.dataset.raw==='> 保存\n\n外');return b?{raw:b.dataset.raw,quote:b.querySelector('blockquote')?.textContent.trim(),outside:[...b.querySelectorAll('p')].some(p=>p.textContent==='外'&&!p.closest('blockquote'))}:null});
 check('実際の送信履歴でも引用外の段落になる',history,{raw:'> 保存\n\n外',quote:'保存',outside:true});
 await exit();await page.waitForTimeout(2000);
 const serverDraft=await page.evaluate(()=>{const key='agent-host-drafts-v1',drafts=JSON.parse(localStorage.getItem(key)||'[]');return drafts.filter(([id,d])=>id&&d.text==='> 保存\n\n外').map(([id,d])=>({hasId:!!id,hasEditing:!!d.editing,dirty:d.dirty}))});
 check('会話の下書き保存が完了し編集情報もある',serverDraft.some(d=>d.hasId&&d.hasEditing&&!d.dirty));
 await page.evaluate(()=>{const key='agent-host-drafts-v1',original=Storage.prototype.setItem;localStorage.removeItem(key);Storage.prototype.setItem=function(k,v){if(k!==key)return original.call(this,k,v)}});
 await page.reload();await ready();
 const server=await snap();evidence.push({name:'server-restored',...server});check('ブラウザーの下書き写し無しでもサーバーから2行復元',[server.raw,server.rows,server.before],['> 保存\n\n外',2,[null,'']]);
 // The recall controller restores the pending draft through the same host path.
 await page.evaluate(()=>{const p=document.querySelector('#prompt');p.focus();p.setSelectionRange(0,0)});await K.press('ArrowUp');await page.waitForTimeout(600);await K.press('Escape');
 check('履歴呼出しを閉じても境界つき下書きは2行',(await snap()).rows,2);
 await page.evaluate(()=>document.querySelector('#log .m.user .who-more').click());await page.waitForTimeout(200);
 const started=await page.evaluate(()=>{const b=[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.trim()==='編集して再送信');b?.click();return !!b});
 check('実発言を編集して再送信から再開できる',started);await page.waitForTimeout(300);
 await exit();await page.waitForTimeout(2000);await page.reload();await ready();
 check('編集中も再読込で2編集行と境界が復帰',[(await snap()).rows,!!(await page.evaluate(()=>document.querySelector('.edit-note')))], [2,true]);
 await page.evaluate(()=>[...document.querySelectorAll('.edit-note button')].find(b=>b.textContent==='取り消す')?.click());await page.waitForTimeout(150);
 check('編集取消で脇置き下書きの2行と境界を復帰',[(await snap()).raw,(await snap()).rows],['> 保存\n\n外',2]);
 await page.waitForTimeout(700);await reset('> > a\n> > b');evidence.push({name:'deep-reset',...await snap()});await K.press('Home');evidence.push({name:'deep-home',...await snap()});await K.press('Backspace');const deep=await snap();evidence.push({name:'deep-exit',...deep});check('多段引用は一段だけ解除',[deep.raw,deep.rows],['> > a\n>\n> b',2]);await K.press('Control+z');check('多段引用のUndo',(await snap()).raw,'> > a\n> > b');
 await reset('> - a\n> - b');await K.press('Home');await K.press('Backspace');check('引用内リスト解除は外側の引用を残す',[(await snap()).raw,(await snap()).rows],['> - a\n>\n> b',2]);
 await reset('- a\n- b');await K.press('Tab');check('Tabで親の項目に入る',(await snap()).raw,'- a\n  - b');await K.press('Shift+Tab');check('Shift+Tabで同段へ戻る',(await snap()).raw,'- a\n- b');await K.press('Shift+Enter');check('Shift+Enterは項目内改行',(await snap()).raw,'- a\n- b\n  ');
 await exit();await K.type('**太字**');check('解除行でインライン書式を付けても2行',(await snap()).rows,2);
 const composition=await page.evaluate(()=>{const p=document.querySelector('#prompt');p.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));const e=new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true,isComposing:true});p.dispatchEvent(e);const rows=p.children.length;p.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true}));return {rows,prevented:e.defaultPrevented}});check('変換中Enterは行を増やさない',composition,{rows:2,prevented:false});
 const mode=await page.evaluate(async()=>{const p=document.querySelector('#prompt'),raw=p.value,saved=p.editor.snapshotEditing(),{createMarkdownEditor}=await import('/md-editor.mjs');const root=document.createElement('div');document.body.append(root);let plain=false;const e=createMarkdownEditor(root,{resolve:()=>null,isPlain:()=>plain});e.restoreDraft(raw,saved);plain=true;e.modeChanged();const during=root.value;plain=false;e.modeChanged();const result={during,after:root.value,rows:root.children.length};e.destroy?.();root.remove();return result});check('平文モードの切替では原文・編集行を保持',[mode.during===mode.after,mode.rows],[true,2]);
 const perf=await page.evaluate(async()=>{const m=await import('/md-doc.mjs');const text=Array.from({length:2000},(_,i)=>'本文 '+i+' **太字**').join('\n'),blocks=m.markdownToDoc(text);const times=[];for(let i=0;i<8;i++){const start=performance.now();m.snapshotEditing(blocks);times.push(performance.now()-start)}return {lines:blocks.length,snapshotMs:times.slice(1),roundtrip:m.docToMarkdown(m.restoreEditing(text,m.snapshotEditing(blocks)))===text}});
 evidence.push({name:'performance',...perf});check('2000行の保存復元で原文を保つ',perf.roundtrip);
 await page.evaluate(()=>{const p=document.querySelector('#prompt');p.value=Array.from({length:300},(_,i)=>`本文 ${i} **太字**`).join('\n');p.focus();p.setSelectionRange(p.value.length,p.value.length)});
 await K.press('a');await page.waitForTimeout(80);
 await page.evaluate(()=>{const desc=Object.getOwnPropertyDescriptor(Node.prototype,'childNodes');window.__mdReads=0;window.__mdRestore=()=>Object.defineProperty(Node.prototype,'childNodes',desc);Object.defineProperty(Node.prototype,'childNodes',{configurable:true,get(){window.__mdReads++;return desc.get.call(this)}})});
 let reads;
 try{await K.press('b');await page.waitForTimeout(80);reads=await page.evaluate(()=>{const key=window.__mdReads,p=document.querySelector('#prompt');for(let i=0;i<5;i++){p.value;p.selectionStart;p.selectionEnd}return {oneKey:key,rereads:window.__mdReads-key}})}finally{await page.evaluate(()=>{window.__mdRestore();delete window.__mdRestore;delete window.__mdReads})}
 evidence.push({name:'dom-performance',...reads});check('300行の1文字入力は全行のDOMを読み直さない',reads.oneKey<50);check('同じ値の繰り返し読取はDOMを再走査しない',reads.rereads,0);
 await exit();
 await page.evaluate(()=>{const dt=new DataTransfer();dt.items.add(new File(['test'],'editing-state.txt',{type:'text/plain'}));document.querySelector('main').dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}))});
 await page.waitForTimeout(1600);
 const attached=await page.evaluate(async()=>{const p=document.querySelector('#prompt');const { posToOffset } = await import('/md-doc.mjs'), st0 = p.editor.getState(), lines0 = p.value.split('\n'); const lineAt = i => p.value.slice(0, posToOffset(st0.blocks, { b: i, v: 0 })).split('\n').length - 1; const sepOf = i => (i > 0 && lineAt(i) - lineAt(i - 1) > 1 ? lines0[lineAt(i) - 1] : null);return {rows:p.children.length,boundary:sepOf(1),atoms:p.querySelectorAll('.md-att[data-state=ok]').length,raw:p.value}});evidence.push({name:'attachment',...attached});check('解除した本文に添付しても境界を保つ',attached.atoms===1&&attached.boundary===''&&attached.raw.startsWith('> 保存\n\n[添付] ')&&attached.raw.endsWith('\n外')&&attached.rows===3);
 await page.reload();await ready();const attachmentRestored=await page.evaluate(async()=>{const p=document.querySelector('#prompt');const { posToOffset } = await import('/md-doc.mjs'), st0 = p.editor.getState(), lines0 = p.value.split('\n'); const lineAt = i => p.value.slice(0, posToOffset(st0.blocks, { b: i, v: 0 })).split('\n').length - 1; const sepOf = i => (i > 0 && lineAt(i) - lineAt(i - 1) > 1 ? lines0[lineAt(i) - 1] : null);return {raw:p.value,rows:p.children.length,boundary:sepOf(1),atoms:p.querySelectorAll('.md-att[data-state=ok]').length}});check('添付つき下書きも再読込で境界と実体を復元',[attachmentRestored.raw,attachmentRestored.boundary,attachmentRestored.atoms],[attached.raw,'',1]);
 await page.evaluate(()=>{const p=document.querySelector('#prompt');for(const key of p.editor.attachmentKeys())p.editor.removeAttachment(key)});
 const removed=await snap();check('添付削除後も本文は引用外・2編集行',[removed.raw,removed.rows,removed.before],['> 保存\n\n外',2,[null,'']]);
 await page.click('#prompt');await K.press('Control+z');check('添付削除Undoは境界つき添付を復帰',(await snap()).rows,3);
 await K.press('Control+Shift+z');check('添付削除Redoも本文境界を保持',(await snap()).raw,'> 保存\n\n外');
 await exit();await K.type('本文');
 return {checks,evidence,passed:checks.every(c=>c.passed)};
}
