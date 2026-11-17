// 登録した Claude アカウントで claude.ai のコネクターを使う入口（ADR 0339。段 1: 既定オフ・画面なし・書き込みなし）。
// 入口はアカウントごとに 1 つのスイッチ。未設定・読めない・知らない版・知らない値はすべてオフ。
//   <データ置き場>/claude-account-connectors.json = { version: 1, accounts: { <アカウント id>: { enabled: true } } }
//   （秘密を含まない。claude-accounts.json の版は上げない。claude-connectors.json は設定 › 外部 MCP のコネクターの一覧の覚えで別のもの）
//   コネクターの名前ごとのオフは、同じアカウントの項目に後から足せる（今は読まない。知らない項目は無視する）
// 入口は gate(account) の 1 か所（core/server.mjs の accountResolve）。オフ・対象外のときは同じ account をそのまま返し、新しい認証の解決へ入らない。
// オンのときだけ resolveAuth(account) を呼ぶ。段 1 の resolveAuth は「まだ使えない」（null）を返し、本物の資格情報を読まず、旧い経路のまま会話を始める。
// 段 2 で、resolveAuth が使えるときに account を返し、使えないときの止める条件の通知を足す
import fs from 'node:fs/promises';
import path from 'node:path';

export const CONNECTORS_FILE = 'claude-account-connectors.json';
export const CONNECTORS_VERSION = 1;

/** 段 1 の認証の解決: まだ使えない。何も読まず、何も始めない */
export const authNotAvailableYet = async () => null;

/**
 * 入口の設定の読み取り（書き込みは無い）。read(id) = そのアカウントの入口の設定。壊れていても投げない
 *   戻り: { enabled: boolean }。enabled が true の項目だけオン
 */
export function createClaudeConnectorSettings({ dataDir }) {
  const file = path.join(dataDir, CONNECTORS_FILE);
  return {
    file,
    async read(accountId) {
      try {
        const raw = JSON.parse(await fs.readFile(file, 'utf8'));
        if (raw?.version !== CONNECTORS_VERSION || !raw.accounts || typeof raw.accounts !== 'object' || Array.isArray(raw.accounts)) return { enabled: false };
        const entry = Object.hasOwn(raw.accounts, accountId) ? raw.accounts[accountId] : null;
        return { enabled: entry?.enabled === true };
      } catch { return { enabled: false }; }
    },
  };
}

/**
 * 入口。gate(account) は、会話が使うアカウント（claudeAccounts.resolve の結果）を、入口がオンのときだけ resolveAuth に通す。
 *   account が無い（ログイン中のアカウント・アカウントの指定なし）・id が無い → 設定を読まずにそのまま返す
 *   オフ → 設定を 1 回だけ読み、同じ account をそのまま返す（resolveAuth は呼ばない）
 *   オン → resolveAuth(account) を呼ぶ。結果の account があればそれを、無ければ（段 1 は常に無い）同じ account を返す
 * 互換の接続先の会話は、server が accountResolve を呼ぶ前に分かれている（接続先の会話はアカウントを引かない）ので、ここへ来ない
 */
export function createClaudeConnectorsGate({ dataDir, resolveAuth = authNotAvailableYet, settings = createClaudeConnectorSettings({ dataDir }) }) {
  return {
    settings,
    async gate(account) {
      if (!account?.id) return account;
      if (!(await settings.read(account.id)).enabled) return account;
      const result = await resolveAuth(account);
      return result?.account ?? account;
    },
  };
}

/** キャッシュのキーに足す識別子の接尾辞。オフ（識別子なし）は空で、キーは今までの文字列のまま */
export const identitySuffix = identity => identity ? `:cn:${identity}` : '';
