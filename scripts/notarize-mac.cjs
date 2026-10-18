// electron-builder の afterSign。mac の公証（notarytool の提出 → staple）は Apple 側の
// 一時的な接続断で落ちることがあり、@electron/notarize 2.x の既定の再試行（合計数秒）では
// 拾えない。提出からやり直す再試行を長い間隔で重ねる（同一バイナリの重複提出は Apple が
// 普通に受け付ける。資格情報の間違い・公証の拒否のような戻らない失敗も同じ回数待つが、
// その場合の間隔は待ちの損失だけで、結果は変わらない）。
// 回数と間隔は PLY_NOTARIZE_ATTEMPTS / PLY_NOTARIZE_DELAY_MS で変えられる。
const fs = require('node:fs');
const path = require('node:path');
const { notarize } = require('@electron/notarize');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 資格情報の選び方は scripts/release-signing.cjs と同じ（Apple ID の変数が 1 つでもあれば
// そちらを使い、選んだ側がそろっていなければ止める）
function credentials(env) {
  const present = name => Boolean(env[name]?.trim());
  const appleId = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];
  const apiKey = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
  if (appleId.some(present)) {
    if (!appleId.every(present)) throw new Error(`Missing notarization settings: ${appleId.join(', ')}`);
    return { appleId: env.APPLE_ID.trim(), appleIdPassword: env.APPLE_APP_SPECIFIC_PASSWORD.trim(), teamId: env.APPLE_TEAM_ID.trim() };
  }
  if (!apiKey.every(present)) throw new Error(`Missing notarization settings: ${apiKey.join(', ')}`);
  return { appleApiKey: env.APPLE_API_KEY.trim(), appleApiKeyId: env.APPLE_API_KEY_ID.trim(), appleApiKeyIssuer: env.APPLE_API_ISSUER.trim() };
}

async function notarizeApp(context, { env = process.env, run = notarize, attempts, delayMs, wait = sleep } = {}) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = fs.readdirSync(context.appOutDir).find(name => name.endsWith('.app'));
  if (!app) throw new Error(`No .app in ${context.appOutDir}`);
  const tries = attempts ?? (Number(env.PLY_NOTARIZE_ATTEMPTS) || 5);
  const gap = delayMs ?? (Number(env.PLY_NOTARIZE_DELAY_MS) || 90_000);
  const opts = { appPath: path.join(context.appOutDir, app), ...credentials(env) };
  let last;
  for (let i = 1; i <= tries; i++) {
    try { await run(opts); return; }
    catch (err) {
      last = err;
      console.error(`notarize ${app}: attempt ${i}/${tries} failed (${err?.message ?? err})`);
      if (i < tries) await wait(gap);
    }
  }
  throw last;
}

module.exports = context => notarizeApp(context);
module.exports.notarizeApp = notarizeApp;
module.exports.credentials = credentials;
