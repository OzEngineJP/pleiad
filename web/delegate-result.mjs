/** Pleiad タスクへの委譲ツール（バックエンドに依らない共通の名前）。履歴で結果を切らない判定（core/backends/shared.mjs）にも使う */
export const isPlyDelegateToolName = (name) => /(^|[_./])ply_delegate$/.test(String(name ?? ''));

/** Parsed ply_delegate output. Input text is never a source of task identity. */
export function delegateResult(result) {
  const text = typeof result === 'string' ? result : typeof result?.text === 'string' ? result.text : '';
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export function delegateTaskId(result) {
  const id = delegateResult(result)?.taskId ?? cutTaskId(result);
  return typeof id === 'string' && /^ply-task-[0-9a-f-]{36}$/.test(id) ? id : null;
}

// 切られた結果（truncated。JSON として読めない）からは、最初の taskId のキーの値だけを拾う。依頼文の中の id はエスケープされた引用符の中にあるので当たらない
function cutTaskId(result) {
  if (!result?.truncated || typeof result.text !== 'string') return null;
  return result.text.match(/^\s*\{[^]*?"taskId":"(ply-task-[0-9a-f-]{36})"/)?.[1] ?? null;
}
