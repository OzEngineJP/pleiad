import { inputCommands, createPageInput } from '../../core/chrome/input.mjs';
import { access, readFile } from 'node:fs/promises';
export const name = 'chrome-input';
export const title = '映像からの入力: IME・ドラッグ・隔離した入力欄・ダイアログ・ファイル選択';
export default async function (t) {
  const composition = inputCommands({ type: 'composition', text: 'にほん' });
  t.ok('変換中は確定せず imeSetComposition に送る', composition[0][0] === 'Input.imeSetComposition' && composition[0][1].selectionEnd === 3);
  t.ok('空の変換は変換の取り消し、長すぎる変換は断る', inputCommands({ type: 'composition', text: '' }).length === 1 && !inputCommands({ type: 'composition', text: 'a'.repeat(2001) }).length);
  t.ok('右クリックとドラッグの押下・移動・解放', inputCommands({ type: 'context', x: 1, y: 2 })[0][1].button === 'right' && ['start', 'move', 'end'].map(phase => inputCommands({ type: 'drag', phase, x: 10, y: 20 })[0][1].type).join() === 'mousePressed,mouseMoved,mouseReleased');
  t.ok('不正なドラッグを送らない', !inputCommands({ type: 'drag', phase: 'move', x: NaN, y: 3 }).length);
  const calls = [], messages = [];
  const send = async (method, params) => {
    calls.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'frame' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 41 };
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script' };
    return { result: { value: true } };
  };
  const input = createPageInput({ send, emit: message => messages.push(message) });
  try {
    await input.start();
    t.ok('ページの main world に入力用の binding を出さない', calls.find(call => call.method === 'Runtime.addBinding').params.executionContextName === 'ply-input');
    input.event('Runtime.bindingCalled', { name: 'plyInput', executionContextId: 9, payload: '{"type":"fields","fields":[]}' });
    t.ok('別の world からの出来事を受け取らない', messages.length === 0);
    input.event('Runtime.bindingCalled', { name: 'plyInput', executionContextId: 41, payload: '{"type":"fields","fields":[]}' });
    t.ok('隔離した world の入力欄の位置を受け取る', messages.at(-1).type === 'fields');
    t.ok('ページが出していないダイアログに応答しない', !await input.input({ type: 'dialog', accept: true }));
    input.event('Page.javascriptDialogOpening', { type: 'prompt', message: '<script>page</script>', defaultPrompt: 'initial' });
    t.ok('ページの prompt をシート用のデータにする', messages.at(-1).dialogType === 'prompt' && messages.at(-1).defaultPrompt === 'initial');
    await input.input({ type: 'dialog', accept: true, text: '日本語' });
    t.ok('prompt の確定を CDP に渡す', calls.at(-1).method === 'Page.handleJavaScriptDialog' && calls.at(-1).params.promptText === '日本語');
    t.ok('選択欄は番号だけ受け、不正な式を受けない', await input.input({ type: 'select', id: 2, selected: [0, 3] }) && !await input.input({ type: 'select', id: '2);bad()', selected: [1] }));
    t.ok('ファイルの要求が無ければ、ホストへのファイル作成をしない', !await input.input({ type: 'files', files: [{ name: 'note.txt', data: 'YQ==' }] }));
    input.event('Page.fileChooserOpened', { backendNodeId: 37, mode: 'selectMultiple' });
    t.ok('ファイルのシートにホストのパスを渡さない', messages.at(-1).type === 'file' && !('backendNodeId' in messages.at(-1)));
    const unsafe = await input.input({ type: 'files', files: [{ name: '../note.txt', data: 'YQ==' }] }).then(() => false, error => error.message === 'invalid-input');
    t.ok('端末から渡されたパスを断る', unsafe);
    await input.input({ type: 'files', files: [{ name: '日本語.txt', data: Buffer.from('選んだ内容').toString('base64') }] });
    const selected = calls.find(call => call.method === 'DOM.setFileInputFiles');
    t.ok('選んだ内容を一時ファイルにして要求元の要素へ渡す', selected.params.backendNodeId === 37 && await readFile(selected.params.files[0], 'utf8') === '選んだ内容');
    await input.dispose();
    t.ok('入力セッションを閉じるとアップロードを消す', await access(selected.params.files[0]).then(() => false, () => true));
  } finally { await input.dispose(); }
}
