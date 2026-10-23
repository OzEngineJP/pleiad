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
const SECRETS = ['IOS_TEAM_ID', 'IOS_DISTRIBUTION_P12_BASE64', 'IOS_DISTRIBUTION_P12_PASSWORD', 'IOS_PROVISION_PROFILE_BASE64', 'ASC_KEY_ID', 'ASC_ISSUER_ID', 'ASC_PRIVATE_KEY_BASE64'];

/** Git for Windows の bash（Windows の PATH の bash は WSL のことがある）。無ければ null */
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8', windowsHide: true }).trim();
    const bash = path.resolve(exec, '../../../bin/bash.exe');
    return fs.existsSync(bash) ? bash : null;
  } catch { return null; }
}

/** App Store Connect API の偽物。JWT を検証し、apps と builds だけに答える */
function fakeAsc({ publicKey, keyId, issuerId, apps, builds }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    requests.push(`${url.pathname}?${decodeURIComponent(url.search.slice(1))}`);
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
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
    return send(404, { errors: [{ status: '404' }] });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, base: `http://127.0.0.1:${server.address().port}` })));
}

function runAsc(args, env) {
  return new Promise((resolve) => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-asc-out-')), 'out');
    fs.writeFileSync(out, '');
    const child = spawn(process.execPath, [ASC_SCRIPT, ...args], { env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, ...env }, windowsHide: true });
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
  t.ok('上げる道具（スクリプト）の変更でも動く', ['mobile/scripts/ios-testflight.sh', 'mobile/scripts/asc-build.mjs', '.github/workflows/ios-testflight.yml'].every((p) => paths.includes(p)));
  t.ok('書く権限を持たない（contents: read）', FLIGHT.permissions?.contents === 'read' && !FLIGHT.jobs.upload.permissions, JSON.stringify(FLIGHT.permissions));
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
  const scripts = steps.filter((s) => s.run).map((s) => s.run).join('\n');
  t.ok('run の中に ${{ }} を書かない（値は env で渡す）', !scripts.includes('${{'), scripts.match(/.*\$\{\{.*/)?.[0]);

  const sh = read('mobile/scripts/ios-testflight.sh');
  t.ok('ios-testflight.sh は渡された版で archive する（実行番号を使わない）', sh.includes('CURRENT_PROJECT_VERSION="$IOS_BUILD_NUMBER" MARKETING_VERSION="$IOS_MARKETING_VERSION"')
    && !sh.includes('GITHUB_RUN_NUMBER'));
  t.ok('ios-testflight.sh はプロファイルの Bundle ID を確かめ、Keychain の検索リストを元に戻す', sh.includes("os.environ.get('IOS_BUNDLE_ID')")
    && /cleanup\(\) \{\n\s+if \[ \$\{#original_keychains\[@\]\} -gt 0 \]; then security list-keychains -d user -s "\$\{original_keychains\[@\]\}"/.test(sh));
  t.ok('暗号は免除のものだけと Info.plist で宣言する（ビルドごとの輸出コンプライアンスの質問を出さない。docs/ios.md）',
    /<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/.test(read('mobile/ios/App/App/Info.plist')));
  t.ok('Bundle ID は Xcode の設定と同じ', read('mobile/ios/App/App.xcodeproj/project.pbxproj').includes(`PRODUCT_BUNDLE_IDENTIFIER = ${JSON.parse(read('mobile/capacitor.config.json')).appId};`));

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
  } finally {
    fake.server.close();
  }
}
