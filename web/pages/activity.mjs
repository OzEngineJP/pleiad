/** Install in an isolated document. Reports interaction only; never accepts app commands. */
export function installPageActivity(win = window) {
  if (win.parent === win) return () => {};
  let receiver = null, touched = false, dirty = false;
  const send = () => { if (receiver) win.parent.postMessage({ type:'pleiad:page-activity', input:dirty }, receiver); };
  const activity = event => {
    if (!event.isTrusted) return;
    const input = event.type === 'input' || event.type === 'change';
    if (touched && (!input || dirty)) return;
    touched = true; dirty ||= input; send();
  };
  const init = event => {
    if (event.source !== win.parent || event.data?.type !== 'pleiad:page-activity-init' || !/^https?:\/\//.test(event.origin)) return;
    receiver = event.origin; if (touched) send();
  };
  const types = ['pointerdown', 'scroll', 'selectionchange', 'input', 'change'];
  for (const type of types) win.document.addEventListener(type, activity, { capture:true, passive:true });
  win.addEventListener('message', init);
  return () => { for (const type of types) win.document.removeEventListener(type, activity, true); win.removeEventListener('message', init); };
}
