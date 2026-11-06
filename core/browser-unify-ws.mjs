// ブラウザーの一本化（ADR 0291〜0294）の WS のコマンドの受け口。旗が on のときだけ core/server.mjs がここへ渡す。
// S0 ではコマンドが無い。足す段は、コマンドを core/protocol.mjs の COMMANDS と操作の一覧（core/ops/）にも載せる（ops-coverage が見る）。

/** ここで受けるコマンドの名前 */
export const BROWSER_UNIFY_COMMANDS = new Set();

export function isBrowserUnifyCommand(command) {
  return BROWSER_UNIFY_COMMANDS.has(command);
}

/**
 * @param {object} deps サーバーから渡すもの（core/server.mjs が作る）
 * @param [deps.relay]  Chrome の中継（core/chrome/relay.mjs。無ければ null）
 * @param [deps.ports]  () => { main, pages, isolated }
 * @param [deps.log]    ログの 1 行
 * @returns {{ handle({ command, args, local, client }): Promise<any> }} client は { send(message) }（その接続へ出来事を送る）
 */
export function createBrowserUnifyWs(deps = {}) {
  void deps;
  return {
    async handle({ command }) { throw Object.assign(new Error(`unknown command: ${command}`), { code: 'UNKNOWN_COMMAND' }); },
  };
}
