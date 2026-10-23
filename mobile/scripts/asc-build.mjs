#!/usr/bin/env node
// TestFlight へ上げる前に、App Store Connect にアプリがあり、同じビルド番号がまだ無いことを確かめる
// （.github/workflows/ios-testflight.yml、docs/ios.md「TestFlight への自動の配布」）。依存なし（Node の組み込みだけ）。
//
//   node mobile/scripts/asc-build.mjs --bundle-id dev.pleiad.app --build 1234
//
// 環境変数: ASC_KEY_ID・ASC_ISSUER_ID・ASC_PRIVATE_KEY_BASE64（.p8 の Base64）。ASC_API_BASE は試験の偽物用
// （https か、loopback の http だけ）。GITHUB_OUTPUT があれば exists=true|false を書く。
// 終了コード: 0 = 確かめられた（exists の値を見る）、1 = アプリが無い・認証できない・入力の誤り。秘密はログに出さない。
import crypto from 'node:crypto';
import fs from 'node:fs';

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';

function fail(message) {
  console.log(`::error::${message} (docs/ios.md)`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] ?? '' : '';
}

function apiBase() {
  const raw = process.env.ASC_API_BASE || DEFAULT_BASE;
  let url;
  try { url = new URL(raw); } catch { fail('ASC_API_BASE is not a URL'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) fail('ASC_API_BASE must be https (or loopback http for tests)');
  return url.origin;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** App Store Connect API の JWT（ES256・20 分まで） */
function ascToken({ keyId, issuerId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(signature)}`;
}

async function get(base, token, pathAndQuery) {
  let res;
  try {
    res = await fetch(`${base}${pathAndQuery}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
  } catch (err) {
    fail(`App Store Connect API is unreachable: ${err.cause?.code ?? err.name}`);
  }
  if (res.status === 401 || res.status === 403) {
    fail(`App Store Connect API refused the key (HTTP ${res.status}). Check ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_BASE64 and the key's role`);
  }
  if (!res.ok) fail(`App Store Connect API returned HTTP ${res.status} for ${pathAndQuery.split('?')[0]}`);
  return res.json();
}

async function main() {
  const bundleId = arg('--bundle-id');
  const build = arg('--build');
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) fail('--bundle-id is missing or invalid');
  if (!/^[0-9]+(\.[0-9]+){0,2}$/.test(build)) fail('--build must be a build number like 1234');

  const keyId = process.env.ASC_KEY_ID ?? '';
  const issuerId = process.env.ASC_ISSUER_ID ?? '';
  const missing = ['ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY_BASE64'].filter((k) => !process.env[k]);
  if (missing.length) fail(`App Store Connect API key is not configured. Empty: ${missing.map((k) => `secrets.${k}`).join(' ')}`);
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey(Buffer.from(process.env.ASC_PRIVATE_KEY_BASE64, 'base64').toString('utf8'));
  } catch {
    fail('secrets.ASC_PRIVATE_KEY_BASE64 is not a Base64 of the .p8 private key');
  }
  if (privateKey.asymmetricKeyType !== 'ec') fail('secrets.ASC_PRIVATE_KEY_BASE64 is not an App Store Connect API key (EC P-256)');

  const base = apiBase();
  const token = ascToken({ keyId, issuerId, privateKey });
  const apps = await get(base, token, `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId&limit=200`);
  // filter[bundleId] は前方一致のことがあるので、完全に同じものを選ぶ
  const app = apps.data?.find((a) => a.attributes?.bundleId === bundleId);
  if (!app) fail(`No app with the Bundle ID ${bundleId} on App Store Connect for this key's team`);
  const builds = await get(base, token, `/v1/builds?filter[app]=${encodeURIComponent(app.id)}&filter[version]=${encodeURIComponent(build)}&fields[builds]=version&limit=1`);
  const exists = (builds.data?.length ?? 0) > 0;
  console.log(exists
    ? `Build ${build} of ${bundleId} is already on App Store Connect; nothing to upload.`
    : `Build ${build} of ${bundleId} is not on App Store Connect yet.`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `exists=${exists}\n`);
}

await main();
