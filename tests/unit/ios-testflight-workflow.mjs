// TestFlight へ上げるワークフロー（.github/workflows/ios-testflight.yml、docs/ios.md「TestFlight への自動の配布」）。
// 起動の条件・試験の後に上げること・版の決め方が Android の流れと同じことを突き合わせ、Secrets の確かめを bash で流し、
// App Store Connect の確かめ（mobile/scripts/asc-build.mjs）を偽の API へ向けて動かす。Apple も GitHub も呼ばない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const name = 'ios-testflight-workflow';
export const title = 'TestFlight へ上げるワークフローは main の iOS の変更と手動で動き、試験の後に Android と同じ版の決め方で上げ、同じビルド番号は二度上げない';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const FLIGHT = parse(read('.github/workflows/ios-testflight.yml'));
const APP = parse(read('.github/workflows/ios-app.yml'));
const APK = parse(read('.github/workflows/android-release.yml'));
const steps = FLIGHT.jobs.upload.steps;
const step = (n) => steps.find((s) => s.name === n);
const ASC_SCRIPT = path.join(ROOT, 'mobile/scripts/asc-build.mjs');
const PROV_SCRIPT = path.join(ROOT, 'mobile/scripts/asc-provision.mjs');
const PROV = parse(read('.github/workflows/ios-provision.yml'));
const SECRETS = ['IOS_TEAM_ID', 'IOS_DISTRIBUTION_P12_BASE64', 'IOS_DISTRIBUTION_P12_PASSWORD', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY_BASE64'];
// プロファイルは ASC API で毎回取る（ios-provision.yml）。Secrets は取れなかったときの任意の代替なので必須ではない
const PROFILE_SECRETS = ['IOS_PROVISION_PROFILE_BASE64', 'IOS_NSE_PROVISION_PROFILE_BASE64'];

/** Git for Windows の bash（Windows の PATH の bash は WSL のことがある）。無ければ null */
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
    const bash = path.resolve(exec, '../../../bin/bash.exe');
    return fs.existsSync(bash) ? bash : null;
  } catch { return null; }
}

/** App Store Connect API の偽物。JWT を検証し、apps・builds・betaBuildLocalizations に答える */
function fakeAsc({ publicKey, keyId, issuerId, apps, builds, localizations = {} }) {
  const requests = [];
  const writes = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push(`${url.pathname}?${decodeURIComponent(url.search.slice(1))}`);
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const readBody = () => new Promise((done) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => done(body));
    });
    const [h, p, sig] = (req.headers.authorization ?? '').replace(/^Bearer /, '').split('.');
    let header, payload;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url'));
      payload = JSON.parse(Buffer.from(p, 'base64url'));
    } catch { return send(401, { errors: [{ status: '401' }] }); }
    const valid = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    const now = Math.floor(Date.now() / 1000);
    if (!valid || header.alg !== 'ES256' || header.kid !== keyId || payload.iss !== issuerId || payload.aud !== 'appstoreconnect-v1'
      || payload.exp - payload.iat > 20 * 60 || payload.exp <= now) return send(401, { errors: [{ status: '401' }] });
    if (url.pathname === '/v1/apps') {
      const prefix = url.searchParams.get('filter[bundleId]');
      return send(200, { data: apps.filter((a) => a.bundleId.startsWith(prefix)).map((a) => ({ type: 'apps', id: a.id, attributes: { bundleId: a.bundleId } })) });
    }
    if (url.pathname === '/v1/builds') {
      const found = builds.filter((b) => b.app === url.searchParams.get('filter[app]') && b.version === url.searchParams.get('filter[version]'));
      return send(200, { data: found.map((b) => ({ type: 'builds', id: `b-${b.version}`, attributes: { version: b.version } })) });
    }
    const locsMatch = url.pathname.match(/^\/v1\/builds\/([^/]+)\/betaBuildLocalizations$/);
    if (req.method === 'GET' && locsMatch) {
      const list = localizations[locsMatch[1]] ?? [];
      return send(200, { data: list.map((l) => ({ type: 'betaBuildLocalizations', id: l.id, attributes: { locale: l.locale, whatsNew: l.whatsNew } })) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/betaBuildLocalizations') {
      return readBody().then((body) => {
        writes.push({ method: 'POST', path: url.pathname, body: JSON.parse(body) });
        send(201, { data: { type: 'betaBuildLocalizations', id: 'loc-new', attributes: {} } });
      });
    }
    const patchMatch = url.pathname.match(/^\/v1\/betaBuildLocalizations\/([^/]+)$/);
    if (req.method === 'PATCH' && patchMatch) {
      return readBody().then((body) => {
        writes.push({ method: 'PATCH', path: url.pathname, body: JSON.parse(body) });
        send(200, { data: { type: 'betaBuildLocalizations', id: patchMatch[1], attributes: {} } });
      });
    }
    return send(404, { errors: [{ status: '404' }] });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, writes, base: `http://127.0.0.1:${server.address().port}` })));
}

function runScript(script, args, env) {
  return new Promise((resolve) => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-asc-out-')), 'out');
    fs.writeFileSync(out, '');
    const child = spawn(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env }, windowsHide: true });
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.on('close', (code) => {
      const output = fs.readFileSync(out, 'utf8');
      fs.rmSync(path.dirname(out), { recursive: true, force: true });
      resolve({ code, log, output });
    });
  });
}

const runAsc = (args, env) => runScript(ASC_SCRIPT, args, env);

/** プロビジョニングの API の偽物。JWT を検証し、bundleIds・bundleIdCapabilities・certificates・profiles に答える */
function fakeAscProvision({ publicKey, keyId, issuerId }) {
  const state = {
    bundleIds: [],            // {id, identifier, name}
    caps: {},                 // bundleId -> [capabilityType]
    profiles: [],             // {id, name, bundleId, profileState, profileContent, expirationDate}
    certs: [{ id: 'cert-1', certificateType: 'DISTRIBUTION' }, { id: 'cert-2', certificateType: 'APPLE_DISTRIBUTION' }],
    forbidden: false,
  };
  const created = { bundleIds: [], capabilities: [], profiles: [] };
  const deleted = [];
  const writes = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const body = await new Promise((done) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => done(b ? JSON.parse(b) : null)); });
    const [h, p, sig] = (req.headers.authorization ?? '').replace(/^Bearer /, '').split('.');
    let header, payload;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url'));
      payload = JSON.parse(Buffer.from(p, 'base64url'));
    } catch { return send(401, { errors: [{ status: '401' }] }); }
    const valid = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    const now = Math.floor(Date.now() / 1000);
    if (!valid || header.kid !== keyId || payload.iss !== issuerId || state.forbidden || payload.exp <= now) {
      return send(401, { errors: [{ status: '401' }] });
    }
    if (req.method === 'GET' && url.pathname === '/v1/bundleIds') {
      const idf = url.searchParams.get('filter[identifier]');
      return send(200, { data: state.bundleIds.filter((b) => b.identifier === idf).map((b) => ({ type: 'bundleIds', id: b.id, attributes: { identifier: b.identifier, name: b.name } })) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/bundleIds') {
      const a = body.data.attributes;
      const b = { id: `bid-${a.identifier}`, identifier: a.identifier, name: a.name };
      state.bundleIds.push(b);
      created.bundleIds.push(a.identifier);
      writes.push({ method: 'POST', path: url.pathname, body });
      return send(201, { data: { type: 'bundleIds', id: b.id, attributes: { identifier: b.identifier } } });
    }
    const capsMatch = url.pathname.match(/^\/v1\/bundleIds\/([^/]+)\/bundleIdCapabilities$/);
    if (req.method === 'GET' && capsMatch) {
      return send(200, { data: (state.caps[capsMatch[1]] ?? []).map((c) => ({ type: 'bundleIdCapabilities', id: `cap-${c}`, attributes: { capabilityType: c } })) });
    }
    if (req.method === 'POST' && url.pathname === '/v1/bundleIdCapabilities') {
      const d = body.data;
      (state.caps[d.relationships.bundleId.data.id] ??= []).push(d.attributes.capabilityType);
      created.capabilities.push(d);
      writes.push({ method: 'POST', path: url.pathname, body });
      return send(201, { data: { type: 'bundleIdCapabilities', id: 'cap-new' } });
    }
    if (req.method === 'GET' && url.pathname === '/v1/certificates') {
      return send(200, { data: state.certs.map((c) => ({ type: 'certificates', id: c.id, attributes: { certificateType: c.certificateType } })) });
    }
    if (req.method === 'GET' && url.pathname === '/v1/profiles') {
      const bid = url.searchParams.get('filter[bundleId]');
      const name = url.searchParams.get('filter[name]');
      const type = url.searchParams.get('filter[profileType]');
      return send(200, {
        data: state.profiles
          .filter((r) => r.bundleId === bid && (!name || r.name === name) && (!type || r.profileType === type))
          .map((r) => ({ type: 'profiles', id: r.id, attributes: { name: r.name, profileType: r.profileType, profileState: r.profileState, expirationDate: r.expirationDate, profileContent: r.profileContent } })),
      });
    }
    if (req.method === 'POST' && url.pathname === '/v1/profiles') {
      const d = body.data;
      const pr = {
        id: `prof-${d.attributes.name}`, name: d.attributes.name, bundleId: d.relationships.bundleId.data.id,
        profileType: d.attributes.profileType, profileState: 'ACTIVE',
        expirationDate: new Date(Date.now() + 300 * 86400_000).toISOString(),
        profileContent: Buffer.from(d.relationships.bundleId.data.id === 'bid-dev.pleiad.app' ? 'APP-PROVISION-BYTES' : 'NSE-PROVISION-BYTES').toString('base64'),
      };
      state.profiles.push(pr);
      created.profiles.push(d);
      writes.push({ method: 'POST', path: url.pathname, body });
      return send(201, { data: { type: 'profiles', id: pr.id, attributes: { name: pr.name, profileType: pr.profileType, profileState: 'ACTIVE', profileContent: pr.profileContent } } });
    }
    const delMatch = url.pathname.match(/^\/v1\/profiles\/([^/]+)$/);
    if (req.method === 'DELETE' && delMatch) {
      const i = state.profiles.findIndex((r) => r.id === decodeURIComponent(delMatch[1]));
      if (i >= 0) { deleted.push(state.profiles[i].name); state.profiles.splice(i, 1); }
      return send(204, {});
    }
    return send(404, { errors: [{ status: '404' }] });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, created, deleted, writes, certs: state.certs, profiles: state.profiles, base: `http://127.0.0.1:${server.address().port}` })));
}

export default async function (t) {
  // ===== 形: 起動の条件・試験の後に上げる・版の決め方 =====
  t.ok('起動は push と workflow_dispatch だけ', Object.keys(FLIGHT.on).sort().join(',') === 'push,workflow_dispatch', JSON.stringify(FLIGHT.on));
  t.ok('push は main だけ', JSON.stringify(FLIGHT.on.push.branches) === '["main"]');
  const paths = FLIGHT.on.push.paths;
  const apkPaths = APK.on.push.paths;
  t.ok('iOS の殻と、Android と同じ共有の場所（www・設定・package）の変更で動く',
    ['mobile/ios/**', 'mobile/www/**', 'mobile/capacitor.config.json', 'mobile/package.json', 'mobile/package-lock.json'].every((p) => paths.includes(p))
      && ['mobile/www/**', 'mobile/capacitor.config.json', 'mobile/package.json', 'mobile/package-lock.json'].every((p) => apkPaths.includes(p)), JSON.stringify(paths));
  t.ok('試験だけの変更では上げない', paths.includes('!mobile/ios/App/AppTests/**') && paths.includes('!mobile/ios/remote-core/Tests/**'), JSON.stringify(paths));
  t.ok('上げる道具（スクリプト）の変更でも動く', ['mobile/scripts/ios-testflight.sh', 'mobile/scripts/asc-build.mjs', 'mobile/scripts/asc-provision.mjs', '.github/workflows/ios-testflight.yml'].every((p) => paths.includes(p)));
  t.ok('上げるジョブは ios-v* のタグを push する分の権限だけ持つ（contents: write。ほかは read）',
    FLIGHT.permissions?.contents === 'read' && Object.keys(FLIGHT.jobs.upload.permissions ?? {}).join(',') === 'contents' && FLIGHT.jobs.upload.permissions.contents === 'write',
    JSON.stringify(FLIGHT.jobs.upload.permissions));
  t.ok('1 つずつ順に走る', FLIGHT.concurrency?.group === 'ios-testflight' && FLIGHT.concurrency?.['cancel-in-progress'] === false);

  t.ok('先に ios-app.yml の試験を呼ぶ（main のときだけ）', FLIGHT.jobs.test?.uses === './.github/workflows/ios-app.yml' && FLIGHT.jobs.test?.if === "github.ref == 'refs/heads/main'",
    JSON.stringify(FLIGHT.jobs.test));
  t.ok('ios-app.yml は呼び出せる（workflow_call）', 'workflow_call' in APP.on, JSON.stringify(Object.keys(APP.on)));
  t.ok('ios-app.yml には配布のジョブも Secrets も残っていない', Object.keys(APP.jobs).join(',') === 'simulator' && !read('.github/workflows/ios-app.yml').includes('secrets.'),
    JSON.stringify(Object.keys(APP.jobs)));
  t.ok('ios-app.yml の並びの組は呼び出し元で分かれる（単独の実行と待ち合って取り消されない）', APP.concurrency?.group?.includes('${{ github.workflow }}'), APP.concurrency?.group);
  t.ok('上げるのは試験の後', FLIGHT.jobs.upload.needs === 'test');
  t.ok('Secrets は Environment「release」から読む（ADR 0214）', FLIGHT.jobs.upload.environment === 'release');
  t.ok('Xcode は ios-app.yml と同じ', FLIGHT.env?.DEVELOPER_DIR === APP.env?.DEVELOPER_DIR && FLIGHT.jobs.upload['runs-on'] === APP.jobs.simulator['runs-on'],
    `${FLIGHT.env?.DEVELOPER_DIR} / ${APP.env?.DEVELOPER_DIR}`);

  const loose = steps.filter((s) => s.uses && !/@[0-9a-f]{40}$/.test(s.uses)).map((s) => s.uses);
  t.ok('アクションはすべて commit の SHA で固定', loose.length === 0, JSON.stringify(loose));
  const apkUses = new Map(APK.jobs.release.steps.filter((s) => s.uses).map((s) => [s.uses.split('@')[0], s.uses]));
  const drift = steps.filter((s) => s.uses && apkUses.has(s.uses.split('@')[0]) && apkUses.get(s.uses.split('@')[0]) !== s.uses).map((s) => s.uses);
  t.ok('checkout・setup-node は Android の流れと同じ版', drift.length === 0, JSON.stringify(drift));
  t.ok('履歴を全部取る（fetch-depth: 0。浅いとビルド番号が小さくなる）', steps.find((s) => s.uses?.startsWith('actions/checkout@'))?.with?.['fetch-depth'] === 0);

  const versionLines = (s) => s.run.split('\n').map((l) => l.trim()).filter((l) => /^(code|base)=/.test(l));
  const iosVersion = versionLines(step('Decide version'));
  const apkVersion = versionLines(APK.jobs.release.steps.find((s) => s.name === 'Decide version'));
  t.ok('ビルド番号と版の決め方は Android の versionCode・versionName の頭と同じ行', iosVersion.length === 2 && JSON.stringify(iosVersion) === JSON.stringify(apkVersion), JSON.stringify(iosVersion));
  t.ok('Bundle ID は capacitor.config.json の appId', /^bundle=\$\(node -p "require\('\.\/mobile\/capacitor\.config\.json'\)\.appId"\)$/m.test(step('Decide version').run.replace(/^\s+/gm, '')));

  const order = steps.map((s) => s.name ?? s.uses.split('@')[0]);
  t.ok('Secrets の確かめが最初、App Store Connect の確かめは重いビルドの前', order[0] === 'Check secrets'
    && order.indexOf('Check App Store Connect') < order.indexOf('Install and sync') && order.indexOf('Install and sync') < order.indexOf('Archive and upload to TestFlight'), JSON.stringify(order));
  t.ok('もうあるビルド番号ならビルドも上げもしない', ['Install and sync', 'Archive and upload to TestFlight'].every((n) => step(n).if === "steps.asc.outputs.exists != 'true'"));
  const upload = step('Archive and upload to TestFlight');
  t.ok('版・ビルド番号・Bundle ID を ios-testflight.sh へ渡す', upload.run === 'bash mobile/scripts/ios-testflight.sh'
    && upload.env.IOS_BUILD_NUMBER === '${{ steps.version.outputs.code }}' && upload.env.IOS_MARKETING_VERSION === '${{ steps.version.outputs.base }}'
    && upload.env.IOS_BUNDLE_ID === '${{ steps.version.outputs.bundle }}', JSON.stringify(upload.env));
  t.ok('Secrets はすべて渡す', SECRETS.every((k) => upload.env[k] === `\${{ secrets.${k} }}` && step('Check secrets').env[k] === `\${{ secrets.${k} }}`));
  t.ok('プロファイルの代替 Secrets は任意（必須の確かめには無く、上げる段へだけ渡す）',
    PROFILE_SECRETS.every((k) => upload.env[k] === `\${{ secrets.${k} }}` && !(k in step('Check secrets').env)));
  const order2 = steps.map((s) => s.name ?? s.uses);
  const wtt = step('Set What to Test');
  const tag = step('Tag uploaded commit');
  t.ok('上げた後に「テスト内容」を書き、上げたコミットに ios-v* のタグを付ける（存在確認で飛ばしたときはどちらもしない）',
    order2.indexOf('Archive and upload to TestFlight') < order2.indexOf('Set What to Test') && order2.indexOf('Set What to Test') < order2.indexOf('Tag uploaded commit')
      && [wtt, tag].every((s) => s?.if === "steps.asc.outputs.exists != 'true'"), JSON.stringify(order2));
  t.ok('「テスト内容」は共通のスクリプトで作り、asc-build.mjs --whats-new で書く（失敗は止めない）',
    /mobile-release-notes\.mjs ios --format testflight/.test(wtt?.run ?? '') && /asc-build\.mjs --bundle-id "\$BUNDLE" --build "\$CODE" --whats-new /.test(wtt?.run ?? '')
      && wtt?.env?.ASC_PRIVATE_KEY_BASE64 === '${{ secrets.ASC_PRIVATE_KEY_BASE64 }}' && wtt?.env?.CODE === '${{ steps.version.outputs.code }}', JSON.stringify(wtt?.env));
  t.ok('タグは ios-v<版>-<ビルド> で、push だけ（失敗しても止めない）', tag?.['continue-on-error'] === true && /git tag "\$TAG" "\$GITHUB_SHA"/.test(tag?.run ?? '') && /git push origin "\$TAG"/.test(tag?.run ?? '')
    && tag?.env?.TAG === 'ios-v${{ steps.version.outputs.base }}-${{ steps.version.outputs.code }}', JSON.stringify(tag?.env));
  const scripts = steps.filter((s) => s.run).map((s) => s.run).join('\n');
  t.ok('run の中に ${{ }} を書かない（値は env で渡す）', !scripts.includes('${{'), scripts.match(/.*\$\{\{.*/)?.[0]);

  const sh = read('mobile/scripts/ios-testflight.sh');
  t.ok('ios-testflight.sh は渡された版で archive する（実行番号を使わない）', sh.includes('CURRENT_PROJECT_VERSION="$IOS_BUILD_NUMBER" MARKETING_VERSION="$IOS_MARKETING_VERSION"')
    && !sh.includes('GITHUB_RUN_NUMBER'));
  t.ok('ios-testflight.sh はプロファイルの Bundle ID を確かめ、Keychain の検索リストを元に戻す', /os\.environ(\.get\(|\[)'IOS_BUNDLE_ID'/.test(sh)
    && /cleanup\(\) \{\r?\n\s+if \[ \$\{#original_keychains\[@\]\} -gt 0 \]; then security list-keychains -d user -s "\$\{original_keychains\[@\]\}"/.test(sh));
  t.ok('プロファイルは本体と通知拡張（<本体>.notify）の 2 つ。まず ASC API で名前で取り、取れなければ Secrets に戻る',
    /asc-provision\.mjs --bundle-id "\$IOS_BUNDLE_ID" --fetch/.test(sh) && sh.includes('IOS_NSE_PROVISION_PROFILE_BASE64')
      && sh.includes("app_bundle + '.notify'"), JSON.stringify(sh.match(/asc-provision[^\n]*/)));
  t.ok('本体のプロファイルは App Store のもの（aps-environment=production）と確かめる', sh.includes("get('aps-environment') != 'production'"));
  t.ok('署名はターゲットごとの PLEIAD_* 変数で渡す（全ターゲットへの上書きはもうない）',
    ['PLEIAD_APP_BUNDLE', 'PLEIAD_NSE_BUNDLE', 'PLEIAD_APP_PROFILE', 'PLEIAD_NSE_PROFILE'].every((v) => sh.includes(`${v}=`))
      && !/PROVISIONING_PROFILE_SPECIFIER=|PRODUCT_BUNDLE_IDENTIFIER=/.test(sh), JSON.stringify(sh.match(/PLEIAD_\w+/g)));
  t.ok('ExportOptions は 2 つのプロファイルを載せる', sh.includes("{app_bundle: app['Name'], nse_bundle: nse['Name']}"));
  t.ok('暗号は免除のものだけと Info.plist で宣言する（ビルドごとの輸出コンプライアンスの質問を出さない。docs/ios.md）',
    /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/.test(read('mobile/ios/App/App/Info.plist')));
  const appId = JSON.parse(read('mobile/capacitor.config.json')).appId;
  const pbx = read('mobile/ios/App/App.xcodeproj/project.pbxproj');
  t.ok('Bundle ID の既定値は xcconfig（capacitor.config.json の appId。拡張は +.notify）',
    read('mobile/ios/pleiad.xcconfig').includes(`PLEIAD_APP_BUNDLE = ${appId}`) && read('mobile/ios/pleiad.xcconfig').includes(`PLEIAD_NSE_BUNDLE = ${appId}.notify`));
  t.ok('ターゲットの Bundle ID・プロファイルは変数経由', pbx.includes('PRODUCT_BUNDLE_IDENTIFIER = "$(PLEIAD_APP_BUNDLE)"')
    && pbx.includes('PRODUCT_BUNDLE_IDENTIFIER = "$(PLEIAD_NSE_BUNDLE)"') && pbx.includes('PROVISIONING_PROFILE_SPECIFIER = "$(PLEIAD_APP_PROFILE)"')
    && pbx.includes('PROVISIONING_PROFILE_SPECIFIER = "$(PLEIAD_NSE_PROFILE)"'));
  t.ok('通知拡張のターゲットがある', pbx.includes('com.apple.product-type.app-extension') && pbx.includes('NotifyService'));

  // ===== プロビジョニングのワークフロー（ios-provision.yml） =====
  t.ok('ios-provision.yml は手動の起動だけ（自動では走らない）', Object.keys(PROV.on ?? {}).join(',') === 'workflow_dispatch', JSON.stringify(PROV.on));
  const prov = PROV.jobs.provision;
  t.ok('ASC の Secrets は Environment「release」から読む', prov?.environment === 'release');
  t.ok('asc-provision.mjs で App ID とプロファイルを整える', /asc-provision\.mjs --bundle-id "\$bundle" --out-dir/.test(prov?.steps.find((s) => s.name === 'Provision App IDs and profiles')?.run ?? ''));
  t.ok('Secret の名前をログに出さない（確かめは名前だけ）', !steps.concat(prov?.steps ?? []).some((s) => (s.run ?? '').includes('echo $') && /SECRET|KEY|P12/i.test(s.run ?? '')));

  // ===== Secrets の確かめを bash で流す =====
  const bash = findBash();
  if (!bash) t.skip('Git for Windows の bash が無い');
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-ios-check-'));
    try {
      const file = path.join(dir, 'check.sh');
      fs.writeFileSync(file, step('Check secrets').run);
      const all = Object.fromEntries(SECRETS.map((k) => [k, `do-not-print-${k}`]));
      const check = (env) => {
        const r = spawnSync(bash, [file], { encoding: 'utf8', windowsHide: true, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...env } });
        return { code: r.status, log: `${r.stdout}${r.stderr}` };
      };
      const ok = check({ REF: 'refs/heads/main', ...all });
      t.ok('揃っていれば通る', ok.code === 0, JSON.stringify(ok));
      const branch = check({ REF: 'refs/heads/feature', ...all });
      t.ok('main 以外では止まる', branch.code !== 0 && branch.log.includes('::error::Run this workflow on main'), JSON.stringify(branch));
      const none = check({ REF: 'refs/heads/main' });
      t.ok('無ければ空のものを全部出して止まる', none.code !== 0 && none.log.includes(`Empty:${SECRETS.map((k) => ` secrets.${k}`).join('')}`), JSON.stringify(none));
      const one = check({ REF: 'refs/heads/main', ...all, ASC_PRIVATE_KEY_BASE64: '' });
      t.ok('1 つ欠けてもその名前を出して止まる', one.code !== 0 && one.log.includes('Empty: secrets.ASC_PRIVATE_KEY_BASE64'), JSON.stringify(one));
      t.ok('Secrets の値をログに出さない', [ok, branch, none, one].every((r) => !r.log.includes('do-not-print')));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // ===== App Store Connect の確かめ（偽の API） =====
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const p8 = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const keyId = 'ABCDE12345';
  const issuerId = '00000000-0000-0000-0000-000000000000';
  const fake = await fakeAsc({
    publicKey, keyId, issuerId,
    apps: [{ id: '111', bundleId: 'dev.pleiad.app.other' }, { id: '222', bundleId: 'dev.pleiad.app' }],
    builds: [{ app: '222', version: '1' }, { app: '111', version: '2565' }],
  });
  // ja の「テスト内容」がもうあるビルド（PATCH に回るか見る）
  const fake2 = await fakeAsc({
    publicKey, keyId, issuerId,
    apps: [{ id: '222', bundleId: 'dev.pleiad.app' }],
    builds: [{ app: '222', version: '2565' }],
    localizations: { 'b-2565': [{ id: 'loc-old', locale: 'ja', whatsNew: '前のノート' }] },
  });
  try {
    const env = { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuerId, ASC_PRIVATE_KEY_BASE64: Buffer.from(p8).toString('base64'), ASC_API_BASE: fake.base };
    const args = (build, bundle = 'dev.pleiad.app') => ['--bundle-id', bundle, '--build', build];

    const fresh = await runAsc(args('2565'), env);
    t.ok('まだ無いビルド番号は exists=false（ほかのアプリの同じ番号は数えない）', fresh.code === 0 && fresh.output === 'exists=false\n', JSON.stringify(fresh));
    t.ok('前方一致で返ったほかのアプリではなく、Bundle ID が同じアプリのビルドを引く', fake.requests.includes('/v1/builds?filter[app]=222&filter[version]=2565&fields[builds]=version&limit=1'),
      JSON.stringify(fake.requests));
    const dup = await runAsc(args('1'), env);
    t.ok('もうあるビルド番号は exists=true', dup.code === 0 && dup.output === 'exists=true\n' && dup.log.includes('already on App Store Connect'), JSON.stringify(dup));

    const fails = [
      ['アプリが無ければ止まる', args('5', 'dev.pleiad.none'), env, 'No app with the Bundle ID dev.pleiad.none'],
      ['キー ID が違えば（401）止まる', args('5'), { ...env, ASC_KEY_ID: 'WRONG00000' }, 'refused the key (HTTP 401)'],
      ['別の鍵で署名したら止まる', args('5'), { ...env, ASC_PRIVATE_KEY_BASE64: Buffer.from(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') }, 'refused the key (HTTP 401)'],
      ['鍵が無ければ名前を出して止まる', args('5'), { ...env, ASC_PRIVATE_KEY_BASE64: '' }, 'Empty: secrets.ASC_PRIVATE_KEY_BASE64'],
      ['鍵の形でなければ止まる', args('5'), { ...env, ASC_PRIVATE_KEY_BASE64: Buffer.from('do-not-print').toString('base64') }, 'is not a Base64 of the .p8 private key'],
      ['EC の鍵でなければ止まる', args('5'), { ...env, ASC_PRIVATE_KEY_BASE64: Buffer.from(crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64') }, 'is not an App Store Connect API key'],
      ['ビルド番号の形でなければ止まる', args('1;rm'), env, '--build must be a build number'],
      ['API の送り先は https か loopback の http だけ', args('5'), { ...env, ASC_API_BASE: 'http://example.com' }, 'ASC_API_BASE must be https'],
      ['届かなければ止まる', args('5'), { ...env, ASC_API_BASE: 'http://127.0.0.1:1' }, 'App Store Connect API is unreachable'],
    ];
    for (const [label, a, e, message] of fails) {
      const r = await runAsc(a, e);
      t.ok(label, r.code === 1 && r.log.startsWith('::error::') && r.log.includes(message) && r.output === '', JSON.stringify(r));
      t.ok(`${label}（秘密を出さない）`, !r.log.includes('do-not-print') && !r.log.includes('BEGIN PRIVATE KEY'));
    }

    // ===== 「テスト内容」（--whats-new）: ビルドを待って locale を書く。失敗しても止めない =====
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-wtt-'));
    const notesFile = path.join(notesDir, 'whats-new.txt');
    fs.writeFileSync(notesFile, '今回の変更:\n・iOS の殻を直す\n');
    const wttArgs = (build, extra = []) => ['--bundle-id', 'dev.pleiad.app', '--build', build, '--whats-new', notesFile, '--wait', '0', ...extra];
    try {
      const created = await runAsc(wttArgs('1'), env);
      const post = fake.writes.find((w) => w.method === 'POST');
      t.ok('ビルドが見えれば betaBuildLocalizations を作って「テスト内容」を書く',
        created.code === 0 && post?.body?.data?.type === 'betaBuildLocalizations' && post?.body?.data?.attributes?.locale === 'ja'
          && post?.body?.data?.attributes?.whatsNew === '今回の変更:\n・iOS の殻を直す' && post?.body?.data?.relationships?.build?.data?.id === 'b-1'
          && created.log.includes('created the ja notes'), JSON.stringify(created));

      const patched = await runAsc(wttArgs('2565'), { ...env, ASC_API_BASE: fake2.base });
      const patch = fake2.writes.find((w) => w.method === 'PATCH');
      t.ok('同じ locale があれば書き換える（PATCH）',
        patched.code === 0 && patch?.path === '/v1/betaBuildLocalizations/loc-old' && patch?.body?.data?.attributes?.whatsNew === '今回の変更:\n・iOS の殻を直す'
          && patched.log.includes('updated the ja notes'), JSON.stringify(patched));

      const noBuild = await runAsc(wttArgs('9999'), env);
      t.ok('ビルドが見えなければ警告だけで終わる（リリースを止めない）',
        noBuild.code === 0 && noBuild.log.startsWith('::warning::') && noBuild.log.includes('did not appear'), JSON.stringify(noBuild));

      fs.writeFileSync(notesFile, '');
      const empty = await runAsc(wttArgs('1'), env);
      t.ok('本文が空なら何も書かずに終わる', empty.code === 0 && empty.log.includes('nothing to set'), JSON.stringify(empty));
      fs.writeFileSync(notesFile, '・かえ\n');

      const down = await runAsc(wttArgs('1'), { ...env, ASC_API_BASE: 'http://127.0.0.1:1' });
      t.ok('API に届かなくても警告だけで終わる', down.code === 0 && down.log.startsWith('::warning::'), JSON.stringify(down));

      const badArgs = await runAsc(['--bundle-id', 'dev.pleiad.app', '--build', '1', '--whats-new'], env);
      t.ok('--whats-new にファイルが無ければ引数の誤りで止まる', badArgs.code === 1 && badArgs.log.includes('--whats-new needs a file'), JSON.stringify(badArgs));
    } finally {
      fs.rmSync(notesDir, { recursive: true, force: true });
    }
  } finally {
    fake.server.close();
    fake2.server.close();
  }

  // ===== プロビジョニング（mobile/scripts/asc-provision.mjs。偽の API） =====
  const prof = await fakeAscProvision({ publicKey, keyId, issuerId });
  const provEnv = { ASC_KEY_ID: keyId, ASC_ISSUER_ID: issuerId, ASC_PRIVATE_KEY_BASE64: Buffer.from(p8).toString('base64'), ASC_API_BASE: prof.base };
  const runProv = (args, env) => runScript(PROV_SCRIPT, args, env);
  try {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-prov-'));
    try {
      const fresh = await runProv(['--bundle-id', 'dev.pleiad.app', '--out-dir', outDir], provEnv);
      t.ok('何も無ければ App ID 2 つ・Push の capability・App Store プロファイル 2 つを作る', fresh.code === 0
        && prof.created.bundleIds.filter((b) => ['dev.pleiad.app', 'dev.pleiad.app.notify'].includes(b)).length === 2
        && prof.created.capabilities.some((c) => c.attributes?.capabilityType === 'PUSH_NOTIFICATIONS' && c.relationships?.bundleId?.data?.id === 'bid-dev.pleiad.app')
        && prof.created.profiles.filter((p) => p.attributes?.profileType === 'IOS_APP_STORE').length === 2, JSON.stringify(fresh));
      t.ok('プロファイルは名前 "Pleiad <bundle>" で配布証明書を全部含む',
        prof.created.profiles.every((p) => /^Pleiad dev\.pleiad\.app/.test(p.attributes?.name)
          && p.relationships?.certificates?.data?.length === prof.certs.length), JSON.stringify(prof.created.profiles));
      t.ok('出来上がった .mobileprovision を --out-dir に書く',
        fs.existsSync(path.join(outDir, 'app.mobileprovision')) && fs.existsSync(path.join(outDir, 'nse.mobileprovision'))
          && fs.readFileSync(path.join(outDir, 'app.mobileprovision'), 'utf8') === 'APP-PROVISION-BYTES');

      const again = await runProv(['--bundle-id', 'dev.pleiad.app'], provEnv);
      const before = prof.writes.length;
      t.ok('すでにあれば何も作り直さない（冪等）', again.code === 0 && prof.writes.length === before, JSON.stringify(again));

      // 期限切れのプロファイルは作り直す
      prof.profiles.find((p) => p.name === 'Pleiad dev.pleiad.app.notify').profileState = 'EXPIRED';
      const rerun = await runProv(['--bundle-id', 'dev.pleiad.app'], provEnv);
      t.ok('期限切れのプロファイルだけ消して作り直す', rerun.code === 0
        && prof.deleted.length === 1 && prof.created.profiles.length === 3, JSON.stringify(prof.deleted));
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }

    const fetchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-prov-fetch-'));
    try {
      const fetched = await runProv(['--bundle-id', 'dev.pleiad.app', '--fetch', '--out-dir', fetchDir], provEnv);
      t.ok('--fetch は既存のプロファイルを取る（作成しない）', fetched.code === 0
        && fs.existsSync(path.join(fetchDir, 'app.mobileprovision')) && fs.existsSync(path.join(fetchDir, 'nse.mobileprovision')),
        JSON.stringify(fetched));
      const missing = await runProv(['--bundle-id', 'dev.pleiad.other', '--fetch', '--out-dir', fetchDir], provEnv);
      t.ok('--fetch で無ければ失敗し、確かめる側が代替（Secrets）に回れる', missing.code === 1
        && missing.log.includes('not on App Store Connect yet'), JSON.stringify(missing));
    } finally {
      fs.rmSync(fetchDir, { recursive: true, force: true });
    }

    const denied = await runProv(['--bundle-id', 'dev.pleiad.app'], { ...provEnv, ASC_KEY_ID: 'WRONG00000' });
    t.ok('鍵の役割が足りなければ、人が Developer のサイトでやる道を示して止まる',
      denied.code === 1 && denied.log.includes('refused the key') && denied.log.includes('Developer site'), JSON.stringify(denied));
    t.ok('プロビジョニングでも秘密を出さない', !denied.log.includes('BEGIN PRIVATE KEY') && !denied.log.includes('do-not-print'));
  } finally {
    prof.server.close();
  }
}
