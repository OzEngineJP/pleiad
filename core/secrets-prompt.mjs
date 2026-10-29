// エージェントに渡す「秘密情報と変数」の一覧の文（ADR 0217「AI への見せ方」）。名前・種類・メモ・サイトだけで、値は書かない（変数の値も書かない）。
// 一覧が空なら null（何も足さない。指示の量を増やさない）。文はエージェントの言語（agentT）。
const clip = (value, max) => (String(value ?? '').length > max ? `${String(value).slice(0, max - 1)}…` : String(value ?? ''));

/**
 * @param {object} o
 * @param {Array<{ name, kind, label, note?, secret }>} o.entries  この会話のシェルへ渡す環境変数（core/secrets.mjs の envFor）
 * @param {Array<{ id, label, username, sites, note? }>} o.logins  サイトで入力できるログイン情報（agentList の login）
 * @param {string[]} [o.unreadable]  値を読めず渡していない名前
 * @param {boolean} [o.browser]  このターンにエージェントのブラウザー（ply_browser）を渡すか。無ければログイン情報は書かない
 * @param {boolean} [o.envFile]  秘密情報を env file 経由で渡すエージェント（traits.secretsViaEnvFile。Claude）。
 *   値ファイルを読むスクリプトが Bash のシェルにだけ届くので、エージェントの PowerShell ツールには渡らないことを文に書く
 * @param {(locale: string, key: string, params?: object) => string} o.agentT
 * @param {string} o.locale
 */
export function secretsPrompt({ entries = [], logins = [], unreadable = [], browser = false, envFile = false, agentT, locale }) {
  // i18n-dynamic: agent:secrets.prompt.
  const tr = (key, params) => agentT(locale, `secrets.prompt.${key}`, params);
  const shown = browser ? logins.filter(l => l.sites?.length) : [];
  if (!entries.length && !shown.length && !unreadable.length) return null;
  const lines = [tr('head')];
  const note = value => (value ? tr('note', { note: clip(value, 120) }) : '');
  if (entries.length) {
    // i18n-dynamic: agent:secrets.prompt.kind.
    const list = entries.map(e => tr('envItem', { name: e.name, kind: tr(`kind.${e.kind}`), note: note(e.note) })).join(tr('separator'));
    lines.push(tr(envFile ? 'envFile' : 'env', { list }));
  }
  if (shown.length) {
    const list = shown.map(l => tr('loginItem', { label: clip(l.label, 60), id: l.id, sites: l.sites.join(', '),
      user: l.username ? tr('username', { name: clip(l.username, 60) }) : '', note: note(l.note) })).join(tr('separator'));
    lines.push(tr('logins', { list }));
  }
  if (unreadable.length) lines.push(tr('unreadable', { list: unreadable.join(', ') }));
  return lines.join('\n');
}
