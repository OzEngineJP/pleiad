#!/usr/bin/env node
// TestFlight に上げるための App ID・Push 通知の有効化・App Store プロファイルを App Store Connect API で整える
// （.github/workflows/ios-provision.yml、docs/ios.md「TestFlight への自動の配布」）。依存なし（Node の組み込みだけ）。
//
//   node mobile/scripts/asc-provision.mjs --bundle-id dev.pleiad.app [--out-dir profiles]
//
// 整えるもの（全部冪等。すでにあれば触らない）:
//   - App ID <bundleId>（Push 通知の capability 付き）と App ID <bundleId>.notify（通知拡張）
//   - それぞれの App Store プロファイル。名前は "Pleiad <bundleId>" / "Pleiad <bundleId>.notify"。
//     期限切れのものは作り直す。配布証明書は Team のものを全部含める
// --out-dir を付けると出来上がった 2 つの .mobileprovision を書き出す。
//
//   node mobile/scripts/asc-provision.mjs --bundle-id dev.pleiad.app --fetch --out-dir profiles
//
// --fetch は名前で既存のプロファイル 2 つを取ってくるだけ（作成はしない）。ビルドのたびに
// ios-testflight.sh が呼び、取れなければ Secrets のプロファイルに戻る。終了コード: 0 = 取れた、1 = 無い。
//
// 環境変数: ASC_KEY_ID・ASC_ISSUER_ID・ASC_PRIVATE_KEY_BASE64（.p8 の Base64）。ASC_API_BASE は試験の偽物用
// （https か、loopback の http だけ）。秘密はログに出さない。
// 終了コード: 0 = 整った / 取れた、1 = 権限が足りない・入力の誤り・見つからない。
// ASC キーの役割が足りない（403/401）ときは人が Developer のサイトで作る —— その手順は docs/ios.md。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

/** App Store Connect API の JWT（ES256・20 分まで）。asc-build.mjs と同じ */
function ascToken({ keyId, issuerId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iss: issuerId, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${header}.${payload}.${b64url(signature)}`;
}

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

/** 権限が足りないかの判定のため status も返す */
async function get(base, token, pathAndQuery) {
  const r = await send('GET', base, token, pathAndQuery);
  if (r.unreachable) fail(`App Store Connect API is unreachable: ${r.error.cause?.code ?? r.error.name}`);
  if (r.status === 401 || r.status === 403) {
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  if (!r.ok) fail(`App Store Connect API returned HTTP ${r.status} for ${pathAndQuery.split('?')[0]}`);
  return r.json;
}

async function post(base, token, pathAndQuery, body) {
  const r = await send('POST', base, token, pathAndQuery, body);
  if (r.unreachable) fail(`App Store Connect API is unreachable: ${r.error.cause?.code ?? r.error.name}`);
  if (!r.ok) {
    const err = new Error(`HTTP ${r.status}`);
    err.status = r.status;
    err.detail = r.json?.errors?.map((e) => e.detail ?? e.title).join('; ') ?? '';
    throw err;
  }
  return r.json;
}

async function del(base, token, pathAndQuery) {
  const r = await send('DELETE', base, token, pathAndQuery);
  if (r.unreachable) fail(`App Store Connect API is unreachable: ${r.error.cause?.code ?? r.error.name}`);
  return r.ok;
}

const profileName = (bundle) => `Pleiad ${bundle}`;

/** App ID を取る。無ければ作る。403 なら権限不足で投げる */
async function ensureBundleId(base, token, identifier, name) {
  const found = await get(base, token, `/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=200`);
  const hit = (found.data ?? []).find((b) => b.attributes?.identifier === identifier);
  if (hit) return hit.id;
  const created = await post(base, token, '/v1/bundleIds', {
    data: { type: 'bundleIds', attributes: { identifier, name, platform: 'IOS' } },
  });
  console.log(`Created the App ID ${identifier}.`);
  return created.data?.id ?? fail(`Could not create the App ID ${identifier}`);
}

/** Push 通知の capability を付ける。付いていれば触らない */
async function ensurePush(base, token, bundleId, identifier) {
  const caps = await get(base, token, `/v1/bundleIds/${encodeURIComponent(bundleId)}/bundleIdCapabilities?limit=200`);
  if ((caps.data ?? []).some((c) => c.attributes?.capabilityType === 'PUSH_NOTIFICATIONS')) return;
  await post(base, token, '/v1/bundleIdCapabilities', {
    data: {
      type: 'bundleIdCapabilities',
      attributes: { capabilityType: 'PUSH_NOTIFICATIONS', settings: [] },
      relationships: { bundleId: { data: { type: 'bundleIds', id: bundleId } } },
    },
  });
  console.log(`Enabled Push Notifications on ${identifier}.`);
}

/** 配布証明書の id を全部（どの鍵で署名しても通るように） */
async function distributionCerts(base, token) {
  const certs = await get(base, token, '/v1/certificates?limit=200');
  const ids = (certs.data ?? [])
    .filter((c) => /DISTRIBUTION|APP_STORE/.test(c.attributes?.certificateType ?? ''))
    .map((c) => c.id);
  if (!ids.length) fail('No distribution certificate on App Store Connect. Create an "Apple Distribution" certificate first (docs/ios.md)');
  return ids;
}

/** 名前つきの有効な App Store プロファイル。期限切れ・無効は作り直す */
async function ensureProfile(base, token, bundleId, identifier, certIds) {
  const name = profileName(identifier);
  const list = await get(base, token,
    `/v1/profiles?filter[bundleId]=${encodeURIComponent(bundleId)}&filter[profileType]=IOS_APP_STORE&filter[name]=${encodeURIComponent(name)}&limit=200`);
  const mine = (list.data ?? []).filter((p) => p.attributes?.name === name);
  const fresh = mine.find((p) => p.attributes?.profileState === 'ACTIVE'
    && (!p.attributes?.expirationDate || Date.parse(p.attributes.expirationDate) > Date.now() + 7 * 86400_000));
  if (fresh) return fresh;
  for (const stale of mine) await del(base, token, `/v1/profiles/${encodeURIComponent(stale.id)}`);
  const created = await post(base, token, '/v1/profiles', {
    data: {
      type: 'profiles',
      attributes: { name, profileType: 'IOS_APP_STORE' },
      relationships: {
        bundleId: { data: { type: 'bundleIds', id: bundleId } },
        certificates: { data: certIds.map((id) => ({ type: 'certificates', id })) },
      },
    },
  });
  console.log(`Created the App Store profile "${name}".`);
  return created.data;
}

/** 名前で既存のプロファイルを取る（作らない）。無ければ null */
async function fetchProfile(base, token, bundleId, identifier) {
  const name = profileName(identifier);
  const list = await get(base, token,
    `/v1/profiles?filter[bundleId]=${encodeURIComponent(bundleId)}&filter[profileType]=IOS_APP_STORE&filter[name]=${encodeURIComponent(name)}&limit=200`);
  const mine = (list.data ?? []).filter((p) => p.attributes?.name === name && p.attributes?.profileState === 'ACTIVE');
  return mine[0] ?? null;
}

function writeProfile(dir, tag, profile) {
  const content = profile?.attributes?.profileContent;
  if (!content) return false;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${tag}.mobileprovision`), Buffer.from(content, 'base64'));
  fs.writeFileSync(path.join(dir, `${tag}.profile-name`), profile.attributes.name);
  return true;
}

async function main() {
  const bundleId = arg('--bundle-id');
  const outDir = arg('--out-dir');
  const fetchOnly = process.argv.includes('--fetch');
  if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) fail('--bundle-id is missing or invalid');

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
  const nse = `${bundleId}.notify`;

  // 権限不足（401/403）は「人がやる」の合図。役割不足のまま進まない
  let appId, nseId;
  try {
    if (fetchOnly) {
      const found = await get(base, token, `/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&limit=200`);
      appId = (found.data ?? []).find((b) => b.attributes?.identifier === bundleId)?.id;
      const foundN = await get(base, token, `/v1/bundleIds?filter[identifier]=${encodeURIComponent(nse)}&limit=200`);
      nseId = (foundN.data ?? []).find((b) => b.attributes?.identifier === nse)?.id;
      if (!appId || !nseId) fail(`The App IDs ${bundleId} / ${nse} are not on App Store Connect yet. Run the iOS provisioning workflow first`);
    } else {
      appId = await ensureBundleId(base, token, bundleId, 'Pleiad');
      await ensurePush(base, token, appId, bundleId);
      nseId = await ensureBundleId(base, token, nse, 'Pleiad Notify');
    }
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      fail(`App Store Connect API refused the key (HTTP ${e.status}). Give the ASC key a role that can manage profiles (App Manager or above), or create the App IDs and profiles on the Developer site by hand (docs/ios.md)`);
    }
    throw e;
  }

  const certIds = fetchOnly ? [] : await distributionCerts(base, token);
  let appProfile, nseProfile;
  try {
    appProfile = fetchOnly ? await fetchProfile(base, token, appId, bundleId)
      : await ensureProfile(base, token, appId, bundleId, certIds);
    nseProfile = fetchOnly ? await fetchProfile(base, token, nseId, nse)
      : await ensureProfile(base, token, nseId, nse, certIds);
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      fail(`App Store Connect API refused the key (HTTP ${e.status}). Create the profiles on the Developer site by hand and store them in secrets (docs/ios.md)`);
    }
    throw e;
  }
  if (!appProfile || !nseProfile) {
    fail(`The App Store profiles "${profileName(bundleId)}" / "${profileName(nse)}" are missing. Run the iOS provisioning workflow, or store IOS_PROVISION_PROFILE_BASE64 / IOS_NSE_PROVISION_PROFILE_BASE64 (docs/ios.md)`);
  }

  if (outDir) {
    if (!writeProfile(outDir, 'app', appProfile) || !writeProfile(outDir, 'nse', nseProfile)) {
      fail('The API did not return the profile contents');
    }
    console.log(`Wrote profiles to ${outDir} (app.mobileprovision, nse.mobileprovision).`);
  }
  console.log(`App Store provisioning is ready: ${bundleId} + ${nse} (${appProfile.attributes?.name}, ${nseProfile.attributes?.name}).`);
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT,
      `app-profile-name=${appProfile.attributes?.name}\nnse-profile-name=${nseProfile.attributes?.name}\n`);
  }
}

await main();
