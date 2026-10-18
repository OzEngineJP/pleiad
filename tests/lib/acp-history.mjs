// ACP（Devin・Grok）の server 試験で共通に見る、履歴の行と出来事の照合

// ターンの最後の text.end の発言の id が、読み直した履歴の返答の行に当たるか（通知の飛び先・画面の行の照合）
export const anchored = (turn, messages) => {
  const end = turn.events.filter(e => e.type === 'text.end').at(-1);
  return Boolean(end?.uuid) && messages.some(m => m.uuid === end.uuid && m.role === 'assistant');
};

// 発言が送った原文のまま 1 回ずつ、返答と交互に並び、uuid が重ならないか
export const sameRows = (messages, prompts) => messages.length === prompts.length * 2 && new Set(messages.map(m => m.uuid)).size === messages.length
  && prompts.every((prompt, i) => messages[i * 2].role === 'user' && messages[i * 2].text === prompt && messages[i * 2 + 1].role === 'assistant');
