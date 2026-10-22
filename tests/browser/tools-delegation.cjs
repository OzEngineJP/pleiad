// Open a completed fake delegation card; pass true for a dirty worktree child.
async (isolated = false) => {
  const card = document.querySelector('.tc[data-tool$=ply_delegate]');
  if (!card?.dataset.taskId) throw Error('Open a linked delegation card first');
  if (!card.querySelector('.tc-details')?.open) throw Error('Open the delegation card first');
  if (!card.querySelector('.tc-pane-main.on') || !card.querySelector('.rt-where')) throw Error('Delegation must open on its request and routing details');
  if (Boolean(card.querySelector('.wt-delegate')) !== isolated) throw Error('Unexpected workspace type');
  if (Boolean(card.querySelector('.git-delegate')) !== isolated) throw Error('Changes must appear only for the dirty worktree child');
  return { passed: 3, isolated };
}
