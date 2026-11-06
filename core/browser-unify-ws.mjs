// ブラウザーの一本化（ADR 0291〜0294）の WS のコマンドの受け口。旗が on のときだけ core/server.mjs がここへ渡す。
// 足す段は、コマンドを core/protocol.mjs の COMMANDS と操作の一覧（core/ops/）か tests/ops-baseline.json にも載せる（ops-coverage が見る）。
// 審査モードで通すかは core/review-mode.mjs に書く（載せ忘れは断る側に倒れる）。

/** ここで受けるコマンドの名前 */
export const BROWSER_UNIFY_COMMANDS = new Set(['vizOnce']);

export function isBrowserUnifyCommand(command) {
  return BROWSER_UNIFY_COMMANDS.has(command);
}

/**
 * @param {object} deps サーバーから渡すもの（core/server.mjs が作る）
 * @param [deps.relay]  Chrome の中継（core/chrome/relay.mjs。無ければ null）
 * @param [deps.ports]  () => { main, pages, isolated }
 * @param [deps.isolatedRoutes] 隔離の origin の経路（core/isolated-routes.mjs。once(origins) で「一度だけ読み込む」の印を作る）
 * @param [deps.log]    ログの 1 行
 * @returns {{ handle({ command, args, local, client }): Promise<any> }} client は { send(message) }（その接続へ出来事を送る）
 */
export function createBrowserUnifyWs(deps = {}) {
  const invalid = message => Object.assign(new Error(message), { code: 'INVALID' });
  return {
    async handle({ command, args }) {
      switch (command) {
        case 'vizOnce': {
          // 印が許すのは、人が確認の札で選んだ外の https の出どころを、隔離の origin の枠で 10 分読むことだけ（ファイルは読めない）
          const origins = args?.origins;
          if (!Array.isArray(origins) || origins.length > 50 || !origins.every(o => typeof o === 'string' && o.length <= 2048)) throw invalid('origins must be up to 50 strings');
          return { token: deps.isolatedRoutes?.once(origins) ?? null };
        }
        default: throw Object.assign(new Error(`unknown command: ${command}`), { code: 'UNKNOWN_COMMAND' });
      }
    },
  };
}
