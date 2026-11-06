import { setupGitPanel } from '../git-panel.mjs';
import { api, node, query, request, requestResult, sessionId, text } from './bridge.mjs';

// Keep the existing graph, keyboard navigation, worktrees and diff controls.
// The page supplies its transport and body; the browser supplies the outer title.
let holder, panel;
export async function renderGit(root) {
  if (holder) { root.append(holder); panel.reload(); return; }
  holder = node('div', 'git-page'); holder.id = 'filePreview';
  let worktreeRows = [];
  const commands = { gitPanel:'changes', gitDiff:'diff', gitCommit:'commit', gitHistory:'history', gitWorktrees:'worktrees', gitWorktree:'worktree', gitPrs:'prs' };
  const cmd = (command, args) => {
    const kind = commands[command];
    if (!kind) return Promise.reject(new Error('unsupported'));
    return api('git', { kind, ...Object.fromEntries(Object.entries(args).filter(([key, value]) => key !== 'sessionId' && value != null)) }).then(result => {
      if (kind === 'worktrees') worktreeRows = result.worktrees?.rows ?? [];
      return result;
    });
  };
  const hostAction = async (action, detail) => {
    return await requestResult('worktree', { action, ...detail });
  };
  // The shared leftovers component optimistically updates "keep" even when its
  // callback rejects. Handle those two buttons before that handler and reload
  // the authoritative list only after the host confirms a successful write.
  holder.addEventListener('click', async event => {
    const control = event.target.closest('button'), item = control?.closest('.wt-item');
    if (!item) return;
    const keep = item.querySelector('.wt-item-acts')?.lastElementChild === control;
    const undo = item.dataset.state === 'keep' && control.classList.contains('wt-undo');
    if (!keep && !undo) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const row = worktreeRows[Number(item.closest('[data-wd]')?.dataset.wd)];
    if (!row?.leftover?.id) return;
    control.disabled = true;
    try {
      const result = await hostAction('keep', { id:row.leftover.id, kept:keep });
      if (result === false || result == null) throw new Error('unavailable');
      panel.reload();
    } catch {
      item.querySelector('[role=alert]')?.remove();
      const error = node('p', 'error', text('errors.unavailable')); error.setAttribute('role', 'alert'); item.append(error);
    } finally { control.disabled = false; }
  }, true);
  panel = setupGitPanel({
    cmd, session:() => ({ id:sessionId }),
    jump:event => { request('jump', { event }); return true; },
    use:value => request('use-text', { text:value }),
    worktrees:{
      keep:(id, kept) => hostAction('keep', { id, kept }), ask:row => hostAction('ask', { row }),
      unask:ask => hostAction('unask', { ask }), archive:row => hostAction('archive', { row }),
      restore:(row, ref) => hostAction('restore', { row, ref }),
    },
    preview:{
      panelOpen:() => true,
      openPanel:({ body, head, toolbar }) => {
        const tools = node('div', 'git-page-tools'); tools.append(...toolbar);
        for (const { node:control } of head) tools.append(control);
        holder.replaceChildren(tools, body);
      },
      updatePanel:(_key, { title }) => { document.title = `${typeof title === 'string' ? title : title.textContent} · Pleiad`; },
      close:() => { location.href = `/_pleiad/s/${encodeURIComponent(sessionId)}/new`; },
    },
  });
  root.append(holder); panel.open(null, { range:query.get('range') });
}
