/** Parsed ply_delegate output. Input text is never a source of task identity. */
export function delegateResult(result) {
  const text = typeof result === 'string' ? result : typeof result?.text === 'string' ? result.text : '';
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

export function delegateTaskId(result) {
  const id = delegateResult(result)?.taskId;
  return typeof id === 'string' && /^ply-task-[0-9a-f-]{36}$/.test(id) ? id : null;
}
