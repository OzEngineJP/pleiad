/** 人が送った通常のターンだけを、次の会話の既定として覚える。 */
export function rememberableRepoTurn(sessionId, meta, hooks) {
  return Boolean((!sessionId || meta) && !hooks?.compact && !hooks?.internal && !meta?.bot && !meta?.delegation);
}
