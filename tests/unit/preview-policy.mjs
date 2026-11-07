// プレビューの CSP と確認（ADR 0295 の 3 の 2・3。core/preview-policy.mjs）。
//   - core/ から読む previewPolicy / previewCsp は web/browser-confirm-policy.mjs と同じ関数（会話の枠と隔離の応答が同じ決まりで作る）
//   - 作る CSP の文字列は今までと同じ（設定の 3 つの形で固定する）
//   - 隔離の応答の CSP: sandbox・束（鍵）のパスだけの読み先・WASM・埋め込める親。eval は足さない
//   - 「一度だけ読み込む」の印: https だけ・10 分・形の違う印は引けない
import * as core from '../../core/preview-policy.mjs';
import * as web from '../../web/browser-confirm-policy.mjs';

export const name = 'preview-policy';
export const title = 'プレビューの CSP（core と web で同じ・文字列は今までと同じ・隔離の応答の CSP・一度だけの印）';

const PINNED = [
  [{}, "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src https: data: blob:; font-src https: data: blob:; connect-src https:; frame-src https:; media-src https: data: blob:; worker-src https: blob:; object-src 'none'; base-uri 'none'; form-action 'none'"],
  [{ confirm: true }, "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; media-src data: blob:; worker-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'"],
  [{ confirm: true, origins: ['https://a.example', 'http://b.example', 'https://c.example/x'] }, "default-src 'none'; script-src 'unsafe-inline' https://a.example https://c.example; style-src 'unsafe-inline' https://a.example https://c.example; img-src https://a.example https://c.example data: blob:; font-src https://a.example https://c.example data: blob:; connect-src https://a.example https://c.example; frame-src https://a.example https://c.example; media-src https://a.example https://c.example data: blob:; worker-src https://a.example https://c.example blob:; object-src 'none'; base-uri 'none'; form-action 'none'"],
];

const directive = (csp, name) => csp.split('; ').find(part => part === name || part.startsWith(`${name} `)) ?? '';

export default async function (t) {
  t.ok('core の previewPolicy / previewCsp / externalOrigin は web の関数そのもの',
    core.previewPolicy === web.previewPolicy && core.previewCsp === web.previewCsp && core.externalOrigin === web.externalOrigin);
  t.ok('作る CSP の文字列は今までと同じ（確認なし・確認あり・許した出どころ）', PINNED.every(([policy, csp]) => core.previewCsp(policy) === csp));
  const prefs = { confirmExternalLoads: true, externalSitePermissions: [{ origin: 'https://a.example', mode: 'always' }, { origin: 'https://b.example', mode: 'ask' }] };
  t.ok('設定から作る決まり（always だけ・一度だけの出どころを足す）', JSON.stringify(core.previewPolicy(prefs, ['https://o.example']))
    === JSON.stringify({ confirm: true, origins: ['https://a.example', 'https://o.example'] }));

  const self = 'http://localhost:*/viz/' + 'a'.repeat(64) + '/';
  const viz = core.isolatedCsp({ confirm: true }, { sandbox: core.VIZ_SANDBOX, self });
  t.ok('隔離の CSP はアプリの sandbox（専用の出どころで動くので allow-same-origin を含む。top-navigation は付けない）で始まる',
    viz.startsWith(`sandbox ${core.APP_SANDBOX}; `) && viz.includes('allow-same-origin') && !viz.includes('allow-top-navigation'));
  t.ok('束のパスだけを読み先に足す（img・connect・script・frame など。none を置き換える）。読み先は localhost と印の出どころの列でも足せる',
    directive(viz, 'img-src') === `img-src ${self} data: blob:` && directive(viz, 'connect-src') === `connect-src ${self}`
    && directive(viz, 'frame-src') === `frame-src ${self}` && directive(viz, 'worker-src') === `worker-src ${self} blob:`);
  const marked = core.isolatedCsp({ confirm: true }, { sandbox: core.VIZ_SANDBOX, self: [self, 'http://*.localhost:*/viz/x/'] });
  t.ok('self の列は出どころの列になる', directive(marked, 'connect-src') === `connect-src ${self} http://*.localhost:*/viz/x/`);
  t.ok("script-src に 'wasm-unsafe-eval' を足し、'unsafe-eval' は足さない",
    directive(viz, 'script-src') === `script-src ${self} 'unsafe-inline' 'wasm-unsafe-eval'` && !viz.includes("'unsafe-eval'"));
  t.ok('default-src・object-src・base-uri は none のまま。form-action は自分と許した出どころ。埋め込める親は本体・ファイルのページ・アプリ同士',
    directive(viz, 'default-src') === "default-src 'none'" && directive(viz, 'object-src') === "object-src 'none'"
    && directive(viz, 'base-uri') === "base-uri 'none'" && directive(viz, 'form-action') === "form-action 'self'"
    && viz.endsWith('; frame-ancestors http://127.0.0.1:* http://localhost:* http://*.localhost:*'));
  const open = core.isolatedCsp({}, { sandbox: core.HTML_SANDBOX, self: 'http://localhost:*/f/k/' });
  t.ok('確認なしなら https: も残し、form-action にも https: が出る',
    open.startsWith(`sandbox ${core.APP_SANDBOX}; `) && directive(open, 'connect-src') === 'connect-src http://localhost:*/f/k/ https:'
    && directive(open, 'form-action') === "form-action 'self' https:");
  const headers = core.isolatedHeaders({ policy: {}, sandbox: core.VIZ_SANDBOX, self });
  t.ok('隔離の応答のヘッダー（CORP cross-origin・Permissions-Policy・資格なしの CORS）',
    headers['cross-origin-resource-policy'] === 'cross-origin' && headers['permissions-policy'] === core.PERMISSIONS_POLICY
    && headers['access-control-allow-origin'] === '*' && !('access-control-allow-credentials' in headers));

  let clock = 1_000_000;
  const once = core.createOnceTokens({ now: () => clock });
  const token = once.mint(['https://a.example/x', 'http://b.example', 'nope']);
  t.ok('一度だけの印は https の出どころだけを持ち、12 文字', /^[A-Za-z0-9_-]{12}$/.test(token) && JSON.stringify(once.take(token)) === '["https://a.example"]');
  t.ok('https が 1 つも無ければ印を作らない', once.mint(['http://b.example']) === null && once.mint('x') === null);
  t.ok('引いても消えない（枠の読み直し）。形の違う印・知らない印は引けない',
    once.take(token) !== null && once.take('a'.repeat(12)) === null && once.take(`${token}x`) === null && once.take(null) === null);
  clock += 10 * 60 * 1000;
  t.ok('10 分で消える', once.take(token) === null);
}
