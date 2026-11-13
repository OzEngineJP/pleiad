import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { stringify } from 'yaml';
import { compareVersions, versionsBetween } from '../../web/versions.mjs';
const require = createRequire(import.meta.url);
const { Updates } = require('../../desktop/updates.cjs');
const { prepareUpdateCheck, notesBetween } = require('../../desktop/update-auth.cjs');
const semver = require('semver');
export const name = 'update-release-notes';
export const title = 'Update release notes: previous version kept, notes between versions, version order';

// 配布時に作る本文の形（scripts/release-info.mjs）
const body = (version, date, title, item) => `# Pleiad ${version}\n\n${date} · ${title}\n\n## 変更\n\n- ${item}\n`;
const release = (version, extra = {}) => ({ tag_name: `v${version}`, prerelease: version.includes('-'), draft: false, published_at: '2026-11-01T00:00:00Z', name: `Pleiad ${version}`, body: body(version, '2026-11-01', `題 ${version}`, `項目 ${version}`), assets: [], ...extra });

export default async function(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-update-notes-'));
  try {
    // ---- 版の比較（先行版は同じ番号の正式な版より前。beta.9 < beta.10 は数として比べる）
    const sorted = ['0.1.0-beta.9', '0.2.0', '0.1.0', '0.10.0', '0.1.0-beta.74', '0.2.0-beta.1'].sort((a, b) => compareVersions(b, a));
    t.ok('Versions compare in semver order', sorted.join() === '0.10.0,0.2.0,0.2.0-beta.1,0.1.0,0.1.0-beta.74,0.1.0-beta.9');
    t.ok('A prerelease is older than its release and newer than the previous release', compareVersions('0.2.0-beta.1', '0.2.0') < 0 && compareVersions('0.2.0-beta.1', '0.1.9') > 0);
    t.ok('Equal versions compare as zero', compareVersions('0.2.0', '0.2.0') === 0);

    // ---- 範囲の切り出し（from < v ≤ to、新しい順）
    const all = ['0.1.0', '0.2.0-beta.1', '0.2.0-beta.2', '0.2.0', '0.3.0-beta.1'].map(version => ({ version }));
    t.ok('Range excludes the lower bound and includes the upper bound', versionsBetween(all, '0.1.0', '0.2.0').map(r => r.version).join() === '0.2.0,0.2.0-beta.2,0.2.0-beta.1');
    t.ok('Range with only an upper bound keeps everything up to it', versionsBetween(all, null, '0.2.0-beta.1').map(r => r.version).join() === '0.2.0-beta.1,0.1.0');
    t.ok('Range from a version newer than the upper bound is empty', versionsBetween(all, '0.3.0', '0.2.0').length === 0);

    // ---- GitHub の一覧から、入っている版から見つけた版までのノートを作る
    const list = [release('0.2.0'), release('0.2.0-beta.2'), release('0.2.0-beta.1'), release('0.1.0'), release('0.3.0-beta.1'), release('0.2.0-beta.3', { draft: true }), { tag_name: 'nightly' }, null];
    const notes = notesBetween(list, '0.1.0', '0.2.0', semver);
    t.ok('Notes between cover intermediate prereleases, newest first, without drafts or invalid tags', notes.map(n => n.version).join() === '0.2.0,0.2.0-beta.2,0.2.0-beta.1');
    t.ok('Notes split the title and date from the body', notes[0].title === '題 0.2.0' && notes[0].date === '2026-11-01' && notes[0].body === '## 変更\n\n- 項目 0.2.0');
    t.ok('A body without the Pleiad header keeps the release name and publish date', (() => {
      const [n] = notesBetween([release('0.2.0', { body: 'plain text', name: 'Named', published_at: '2026-10-05T01:00:00Z' })], '0.1.0', '0.2.0', semver);
      return n.title === 'Named' && n.date === '2026-10-05' && n.body === 'plain text';
    })());
    t.ok('Body length is capped per version', notesBetween([release('0.2.0', { body: 'x'.repeat(9000) })], '0.1.0', '0.2.0', semver)[0].body.length === 4000);
    t.ok('Total size stops at the cap so the state stays small', notesBetween(Array.from({ length: 100 }, (_, i) => release(`0.2.${i}`, { body: 'x'.repeat(9000) })), '0.1.0', '0.3.0', semver).length === 25);
    t.ok('Bad inputs give an empty list', notesBetween(null, '0.1.0', '0.2.0', semver).length === 0 && notesBetween(list, 'x', '0.2.0', semver).length === 0 && notesBetween(list, '0.1.0', null, semver).length === 0);

    // ---- 提供元: 正式な版だけの利用者にも一覧を取り、途中の先行版を添える。一覧が取れなくても確認は成功する
    const configFile = path.join(dir, 'app-update.yml');
    await fs.writeFile(configFile, stringify({ provider: 'github', owner: 'example', repo: 'releases', private: true, channel: 'latest' }));
    let feed;
    await prepareUpdateCheck({ setFeedURL(value) { feed = value; } }, configFile, { env: { GH_TOKEN: 'token' }, platform: 'linux' });
    const updater = { currentVersion: { version: '0.1.0' }, allowPrerelease: false };
    const metadata = version => stringify({ version, files: [{ url: 'Pleiad.exe', sha512: 'hash' }] });
    const provider = (listBehaviour) => new feed.updateProvider(feed, updater, { platform: 'win32', executor: { request: async options => {
      if (options.path.endsWith('/releases/latest')) return JSON.stringify(release('0.2.0', { assets: [{ name: 'latest.yml', url: 'https://api.github.com/assets/0.2.0/metadata' }] }));
      if (options.path.includes('/releases?')) return listBehaviour();
      return metadata('0.2.0');
    } } });
    const withList = await provider(() => JSON.stringify(list)).getLatestVersion();
    t.ok('Stable check carries the notes of every version between', withList.version === '0.2.0' && withList.plyReleases?.map(n => n.version).join() === '0.2.0,0.2.0-beta.2,0.2.0-beta.1');
    const failedList = await provider(() => { throw new Error('rate limited'); }).getLatestVersion();
    t.ok('A list that cannot be fetched does not fail the check', failedList.version === '0.2.0' && failedList.plyReleases === undefined);
    const brokenList = await provider(() => 'not json').getLatestVersion();
    t.ok('An unreadable list does not fail the check either', brokenList.version === '0.2.0' && brokenList.plyReleases === undefined);
    const emptyList = await provider(() => '[]').getLatestVersion();
    t.ok('An empty list adds nothing', emptyList.plyReleases === undefined);

    // ---- Updates: 前に入っていた版を次の更新まで覚える。途中の版のノートは state に載り、確認し直しで消える
    const file = path.join(dir, 'updates.json');
    const make = (version, extra = {}) => {
      const fake = new EventEmitter();
      fake.checkForUpdates = async () => { fake.emit('update-available', { version: '0.9.0', releaseNotes: 'latest notes', ...extra }); };
      fake.downloadUpdate = async () => { fake.emit('update-downloaded'); };
      return { fake, updates: new Updates({ updater: fake, version, file, enabled: true, install: async () => {} }) };
    };
    const saved = async () => JSON.parse(await fs.readFile(file, 'utf8'));
    let first = make('0.1.0'); await first.updates.init();
    t.ok('A fresh install has no previous version', first.updates.snapshot().previousVersion === null && (await saved()).previousVersion === null);
    let again = make('0.1.0'); await again.updates.init();
    t.ok('Restarting the same version keeps no previous version', again.updates.snapshot().previousVersion === null);
    let updated = make('0.2.0'); await updated.updates.init();
    t.ok('After an update the previous version is exposed and saved apart from the current one', updated.updates.snapshot().previousVersion === '0.1.0' && (await saved()).previousVersion === '0.1.0' && (await saved()).lastVersion === '0.2.0');
    t.ok('The first start after an update shows the notice', updated.updates.snapshot().notice === true);
    let restarted = make('0.2.0'); await restarted.updates.init();
    t.ok('The previous version survives restarts of the same version until the next update', restarted.updates.snapshot().previousVersion === '0.1.0' && restarted.updates.snapshot().notice === false);
    let next = make('0.3.0'); await next.updates.init();
    t.ok('The next update replaces the previous version', next.updates.snapshot().previousVersion === '0.2.0');
    await fs.writeFile(file, JSON.stringify({ lastVersion: '0.3.0', previousVersion: '0.3.0' }));
    let same = make('0.3.0'); await same.updates.init();
    t.ok('A previous version equal to the current one is dropped', same.updates.snapshot().previousVersion === null);

    const notesOf = [{ version: '0.9.0', date: '2026-11-01', title: '題', body: '本文' }, { version: 3 }, null];
    const found = make('0.3.0', { plyReleases: notesOf });
    await found.updates.init(); await found.updates.command('preferences', { channel: 'stable', autoDownload: false, autoCheck: true }); await found.updates.command('check');
    t.ok('Notes between versions reach the state, keeping only well-formed entries', JSON.stringify(found.updates.snapshot().releases) === JSON.stringify([notesOf[0]]) && found.updates.snapshot().notes === 'latest notes');
    const fallback = make('0.3.0');
    await fallback.updates.init(); await fallback.updates.command('check');
    t.ok('Without a list the state falls back to the latest notes only', fallback.updates.snapshot().releases.length === 0 && fallback.updates.snapshot().notes === 'latest notes');
    found.fake.checkForUpdates = async () => { found.fake.emit('update-not-available', {}); };
    await found.updates.command('check');
    t.ok('A check that finds nothing clears the notes between versions', found.updates.snapshot().releases.length === 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
