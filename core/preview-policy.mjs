// プレビューの CSP と確認（ADR 0295 の 3 の 2・3）。会話の枠の srcdoc（web/visualize-document.mjs）と、
// 隔離の origin の応答のヘッダー（core/isolated-routes.mjs）が同じ決まりで CSP を作る。
// previewPolicy / previewCsp の本体は web/browser-confirm-policy.mjs に置いたまま、ここから再輸出する。
// 画面のコードは web/ の下しか配られない（core/server.mjs）ので、本体を core/ へ移すと画面が読めなくなる。どちらも DOM を使わない純粋な関数。
import crypto from 'node:crypto';
import { externalOrigin, previewCsp, previewPolicy } from '../web/browser-confirm-policy.mjs';
export { externalOrigin, previewCsp, previewPolicy };

/**
 * アプリ（可視化・HTML のファイル）の sandbox（応答のヘッダーと iframe の側の両方に書く）。
 * アプリごとの専用の出どころ（<印>.localhost。core/isolated-origins.mjs）で動くので allow-same-origin を付け、
 * 相対の資源・fetch・localStorage・フォーム・別タブ（popup は sandbox を引き継ぐ）をふつうのページと同じにする。
 * 人を惑わす残りだけ止める: 親（Pleiad の画面）の移動（allow-top-navigation は付けない）と、
 * 画面の外へのダウンロードの自動の連打以外の権限は Permissions-Policy で止める
 */
export const APP_SANDBOX = 'allow-scripts allow-same-origin allow-downloads allow-forms allow-modals allow-popups allow-pointer-lock';
export const VIZ_SANDBOX = APP_SANDBOX;
export const HTML_SANDBOX = APP_SANDBOX;
/** 埋め込める親（会話の画面の本体の port と、ファイルのページの port と、アプリ同士の専用の出どころ） */
export const FRAME_ANCESTORS = 'http://127.0.0.1:* http://localhost:* http://*.localhost:*';
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=()';

// 束の中のファイルを読む指示。srcdoc では読む先が無かったので、プレビューの CSP には無い
const SELF_DIRECTIVES = ['script-src', 'style-src', 'img-src', 'font-src', 'connect-src', 'media-src', 'worker-src', 'frame-src'];

/**
 * 隔離の応答の CSP（ヘッダー）。プレビューの CSP に、その束（鍵）のパスだけを読み先として足す。
 * self は束（鍵）のパスで終わる出どころの列（例: `http://localhost:` と port の `*` の後に `/viz/<ハッシュ>/`、と印の付いた出どころ）。
 * port は * にする（端末のプロキシの 2 つ目のリスナーを通ると port が変わる。ADR 0295 の 5 の 3）。
 * フォームは自分の origin と、読み込みを許した出どころへ出せる（ふつうのページと同じ）。
 * WASM（束の中の .wasm）を動かすため script-src に 'wasm-unsafe-eval' を足す（eval は足さない）
 */
export function isolatedCsp(policy, { sandbox, self }) {
  const selves = (Array.isArray(self) ? self : [self]).filter(Boolean);
  const directives = previewCsp(policy).split('; ').map(directive => {
    const [name, ...sources] = directive.split(' ');
    if (!SELF_DIRECTIVES.includes(name) || !selves.length) return directive;
    const kept = sources.filter(source => source !== "'none'");
    if (name === 'script-src') kept.push("'wasm-unsafe-eval'");
    return [name, ...selves, ...kept].join(' ');
  });
  const remote = (directives.find(directive => directive.startsWith('connect-src ')) ?? '')
    .split(' ').slice(1).filter(source => !selves.includes(source) && source !== "'none'");
  const rest = directives.filter(directive => !directive.startsWith('form-action'));
  return `sandbox ${sandbox}; ${rest.join('; ')}; form-action 'self'${remote.length ? ` ${remote.join(' ')}` : ''}; frame-ancestors ${FRAME_ANCESTORS}`;
}

/** 隔離の応答に付けるヘッダー（Referrer-Policy・nosniff は core/page-listener.mjs が全部の応答に付ける） */
export function isolatedHeaders({ policy, sandbox, self }) {
  return {
    'content-security-policy': isolatedCsp(policy, { sandbox, self }),
    'cross-origin-resource-policy': 'cross-origin',
    'permissions-policy': PERMISSIONS_POLICY,
    // 束の中の fetch・module・WASM が隔離の port の別の origin（印の違い・localhost 直）を読むとき用。資格は送らせない（Cookie を使わない）
    'access-control-allow-origin': '*',
  };
}

/**
 * 可視化の「一度だけ読み込む」の印（`?once=<短い乱数>`）。サーバーのメモリにだけ持ち、10 分で消える。
 * 枠の中のスクリプトは自分の URL を書き換えられるので、許す出どころを URL に直に載せず、画面（認証された WS）が作った印でだけ引く
 */
export function createOnceTokens({ now = Date.now, ttlMs = 10 * 60 * 1000, max = 500 } = {}) {
  const tokens = new Map();   // token -> { origins, until }
  const prune = () => {
    const at = now();
    for (const [token, entry] of tokens) if (entry.until <= at) tokens.delete(token);
  };
  return {
    /** https の出どころだけを残す。1 つも無ければ null */
    mint(origins) {
      const kept = [...new Set((Array.isArray(origins) ? origins : []).slice(0, 500).map(externalOrigin).filter(Boolean))];
      if (!kept.length) return null;
      prune();
      while (tokens.size >= max) tokens.delete(tokens.keys().next().value);
      const token = crypto.randomBytes(9).toString('base64url');
      tokens.set(token, { origins: kept, until: now() + ttlMs });
      return token;
    },
    /** 期限の内なら出どころの一覧。読み直し（枠の再描画）でも使えるよう、引いても消さない */
    take(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(token)) return null;
      const entry = tokens.get(token);
      if (!entry) return null;
      if (entry.until <= now()) { tokens.delete(token); return null; }
      return [...entry.origins];
    },
    clear() { tokens.clear(); },
  };
}
