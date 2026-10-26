#!/usr/bin/env node
// TestFlight へ上げる前に、App Store Connect にアプリがあり、同じビルド番号がまだ無いことを確かめる
// （.github/workflows/ios-testflight.yml、docs/ios.md「TestFlight への自動の配布」）。依存なし（Node の組み込みだけ）。
//
//   node mobile/scripts/asc-build.mjs --bundle-id dev.pleiad.app --build 1234
//
// 上げた後に TestFlight の「テスト内容（What to Test）」を書くときは --whats-new を付ける:
//
//   node mobile/scripts/asc-build.mjs --bundle-id dev.pleiad.app --build 1234 --whats-new <本文のファイル> [--locale ja] [--wait 600]
//
// 環境変数: ASC_KEY_ID・ASC_ISSUER_ID・ASC_PRIVATE_KEY_BASE64（.p8 の Base64）。ASC_API_BASE は試験の偽物用
// （https か、loopback の http だけ）。GITHUB_OUTPUT があれば exists=true|false を書く。
// 終了コード: 0 = 確かめられた（exists の値を見る）、1 = アプリが無い・認証できない・入力の誤り。秘密はログに出さない。
// --whats-new のときだけ、ノートの失敗でリリースを止めないよう、API の失敗・ビルドが見えない・本文が空でも
// ::warning:: を出して終了コード 0 にする（ビルド自体はもう上がっている）。引数の誤りは変わらず 1。
import crypto from 'node:crypto';
import fs from 'node:fs';

const DEFAULT_BASE = 'https://api.appstoreconnect.apple.com';

function fail(message) {
  console.log(`::error::${message} (docs/ios.md)`);
  process.exit(1);
}

/** --whats-new の失敗はリリースを止めない（ビルドはもう上がっている） */
function warn(message) {
  console.log(`::warning::${message}`);
  process.exit(0);
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

/** API へ送る。届かないときは { unreachable }、HTTP の応答は { status, json }。ここでは止めない */
async function send(method, base, token, pathAndQuery, body) {
  let res;
  try {
    res = await fetch(`${base}${pathAndQuery}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { unreachable: true, error: err };
  }
  let json = null;
  try { json = await res.json(); } catch { /* 応答の無い 204 など */ }
  return { status: res.status, ok: res.ok, json };
}

async function get(base, token, pathAndQuery) {
  const r = await send('GET', base, token, pathAndQuery);
  if (r.unreachable) {
    fail(`App Store Connect API is unreachable: ${r.error.cause?.code ?? r.error.name}`);
  }
  if (r.status === 401 || r.status === 403) {
    fail(`App Store Connect API refused the key (HTTP ${r.status}). Check ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY_BASE64 and the key's role`);
  }
  if (!r.ok) fail(`App Store Connect API returned HTTP ${r.status} for ${pathAndQuery.split('?')[0]}`);
  return r.json;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** --whats-new のときの GET。失敗は警告で終える */
async function getSoft(base, token, pathAndQuery) {
  const r = await send('GET', base, token, pathAndQuery);
  if (r.unreachable) warn(`App Store Connect API is unreachable: ${r.error.cause?.code ?? r.error.name}. The What to Test notes were not set`);
  if (!r.ok) warn(`App Store Connect API returned HTTP ${r.status} for ${pathAndQuery.split('?')[0]}. The What to Test notes were not set`);
  return r.json;
}

/** 上げたビルドが App Store Connect に見えるまで待ち、「テスト内容」を書く */
async function setWhatsNew({ base, token, bundleId, build, file, locale, waitSec }) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8').trim(); } catch { /* 無ければ空と同じ */ }
  if (!text) {
    console.log('No release notes; nothing to set on the build.');
    return;
  }

  const apps = await getSoft(base, token, `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId&limit=200`);
  const app = apps.data?.find((a) => a.attributes?.bundleId === bundleId);
  if (!app) warn(`No app with the Bundle ID ${bundleId} on App Store Connect for this key's team`);

  // 書き出し直後のビルドは一覧に出るまで時間がかかることがあるので、見えるまで待つ
  const deadline = Date.now() + waitSec * 1000;
  let found = null;
  do {
    const builds = await getSoft(base, token, `/v1/builds?filter[app]=${encodeURIComponent(app.id)}&filter[version]=${encodeURIComponent(build)}&fields[builds]=version&limit=1`);
    if (builds.data?.length) { found = builds.data[0]; break; }
    if (Date.now() < deadline) await sleep(15_000);
  } while (Date.now() < deadline);
  if (!found) warn(`Build ${build} of ${bundleId} did not appear on App Store Connect in ${waitSec}s. The What to Test notes were not set`);

  const locs = await getSoft(base, token, `/v1/builds/${encodeURIComponent(found.id)}/betaBuildLocalizations?limit=200`);
  const existing = (locs.data ?? []).find((l) => l.attributes?.locale === locale);
  let r;
  if (existing) {
    r = await send('PATCH', base, token, `/v1/betaBuildLocalizations/${encodeURIComponent(existing.id)}`, {
      data: { type: 'betaBuildLocalizations', id: existing.id, attributes: { whatsNew: text } },
    });
  } else {
    r = await send('POST', base, token, '/v1/betaBuildLocalizations', {
      data: {
        type: 'betaBuildLocalizations',
        attributes: { locale, whatsNew: text },
        relationships: { build: { data: { type: 'builds', id: found.id } } },
      },
    });
  }
  if (r.unreachable) warn(`App Store Connect API is unreachable: ${r.error.cause?.code ?? r.error.name}. The What to Test notes were not set`);
  if (!r.ok) warn(`App Store Connect API returned HTTP ${r.status} while setting the What to Test notes`);
  console.log(`Set the What to Test notes of build ${build} (${existing ? `updated the ${locale} notes` : `created the ${locale} notes`}).`);
}

async function main() {
  const bundleId = arg('--bundle-id');
  const build = arg('--build');
  const whatsNew = process.argv.includes('--whats-new');
  const whatsNewFile = arg('--whats-new');
  const locale = arg('--locale') || 'ja';
  const waitSec = Number(arg('--wait') || '600');
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) fail('--bundle-id is missing or invalid');
  if (!/^[0-9]+(\.[0-9]+){0,2}$/.test(build)) fail('--build must be a build number like 1234');
  if (whatsNew && !whatsNewFile) fail('--whats-new needs a file with the notes');
  if (whatsNew && !/^[A-Za-z-]+$/.test(locale)) fail('--locale must be a language code like ja or en-US');
  if (whatsNew && (!Number.isFinite(waitSec) || waitSec < 0)) fail('--wait must be seconds (0 to check only once)');

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

  if (whatsNew) {
    await setWhatsNew({ base, token, bundleId, build, file: whatsNewFile, locale, waitSec });
    return;
  }

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
