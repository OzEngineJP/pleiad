import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { withdraw } from '../../scripts/release-withdraw.mjs';
import { assertReleaseAllowed } from '../../scripts/release-policy.mjs';
import { verifyPublished } from '../../scripts/release-feed.mjs';

export const name = 'release-startup-gate';
export const title = 'Withdraw known-bad downloads and require packaged UI startup before release';
export default async function(t) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'pleiad-withdraw-test-'));
  try {
    for (const tag of ['v0.27.0', 'v0.28.0', 'v0.28.1']) await assert.rejects(assertReleaseAllowed(tag), /Withdrawn/);
    await assertReleaseAllowed('v0.28.2');
    t.ok('Known-bad releases cannot be republished', true);
    const remote = { tag_name: 'v0.28.2', draft: false, prerelease: false, assets: [{ id: 7, name: 'latest.yml' }, { name: 'installer.exe' }] };
    const feedGh = args => args.at(-1) === 'Accept: application/octet-stream' ? 'version: 0.28.2\nfiles:\n  - url: installer.exe\n' : JSON.stringify(remote);
    assert.equal(verifyPublished({ gh: feedGh, repo: 'owner/repo', tag: 'v0.28.2' }).published, true);
    remote.draft = true;
    assert.throws(() => verifyPublished({ gh: feedGh, repo: 'owner/repo', tag: 'v0.28.2' }), /not published/);
    remote.draft = false;
    assert.throws(() => verifyPublished({ gh: args => args.at(-1).endsWith('/latest') ? JSON.stringify({ tag_name: 'v0.28.1' }) : feedGh(args), repo: 'owner/repo', tag: 'v0.28.2' }), /Latest has not switched/);
    assert.throws(() => verifyPublished({ gh: args => args.at(-1) === 'Accept: application/octet-stream' ? 'version: 0.28.1\nfiles:\n  - url: installer.exe\n' : feedGh(args), repo: 'owner/repo', tag: 'v0.28.2' }), /inconsistent/);
    t.ok('Publication requires the real latest pointer and downloaded manifests to match', true);
    const bad = { id: 42, tag_name: 'v0.28.1', immutable: true, assets: [{ name: 'installer.exe' }] };
    const good = { id: 41, tag_name: 'v0.26.2', assets: [] };
    let releases = [bad, good];
    const mutations = [];
    const gh = args => {
      if (args.includes('DELETE')) { mutations.push(args); releases = releases.filter(r => r.id !== 42); return ''; }
      if (args.includes('--slurp')) return JSON.stringify([releases]);
      if (args.at(-1).endsWith('/latest')) return JSON.stringify(releases[0]);
      if (args.at(-1).endsWith('/42')) return JSON.stringify(bad);
      throw new Error('Unexpected API request');
    };
    const options = { repo: 'owner/repo', gh };
    const plan = await withdraw(options);
    assert.deepEqual(plan.targets.map(r => r.id), [42]);
    assert.equal(mutations.length, 0);
    await assert.rejects(withdraw({ ...options, mode: 'verify' }), /remain downloadable/);
    await assert.rejects(withdraw({ ...options, mode: 'apply' }), /backup/);
    assert.equal(mutations.length, 0);
    const result = await withdraw({ ...options, mode: 'apply', backup: scratch });
    assert.equal(result.latest, 'v0.26.2');
    assert.equal(mutations.length, 1);
    assert.equal(JSON.parse(await fs.readFile(path.join(scratch, 'withdrawal.json'))).releases[0].tag_name, 'v0.28.1');
    assert.ok(mutations.every(a => !a.join(' ').includes('/git/')));
    t.ok('Withdrawal is planned first, audited before mutation, preserves tags and verifies feed', true);

    const root = new URL('../../', import.meta.url);
    for (const file of ['evaluation-release.yml', 'desktop-release.yml']) {
      const workflow = parse(await fs.readFile(new URL(`.github/workflows/${file}`, root), 'utf8'));
      for (const jobName of file === 'evaluation-release.yml' ? ['windows', 'mac'] : ['package']) {
        const steps = workflow.jobs[jobName].steps;
        const smoke = steps.findIndex(s => s.name === 'Packaged UI startup smoke');
        const upload = steps.findIndex(s => s.uses?.startsWith('actions/upload-artifact@'));
        assert.ok(smoke >= 0 && upload > smoke, `${file}/${jobName} must gate artifact upload on UI startup`);
        assert.ok(!steps[smoke]['continue-on-error'] && !steps[smoke].if);
        if (jobName !== 'windows') {
          // stapler（公証 ticket の lookup）と spctl（Gatekeeper の照合）は Apple のサーバーへ出るので、
          // 一時的な失敗だけを試し直す形（verify_apple）に固定する。裸で呼ぶ形に戻ったらここで落とす
          const verify = steps.find(s => /stapler validate/.test(s.run ?? ''));
          assert.ok(verify && /verify_apple xcrun stapler validate/.test(verify.run) && !/^\s*xcrun stapler/m.test(verify.run),
            `${file}/${jobName} must retry transient stapler failures`);
          assert.ok(verify && verify.run.includes('::warning::'), `${file}/${jobName} must annotate each retried validation`);
          // 公証の直後は ticket の問い合わせ（CloudKit）が「(null)」で失敗し、stapler が 65 で落ちることがある。これも一時的な失敗として試し直す
          assert.ok(verify && /CloudKit query/.test(verify.run), `${file}/${jobName} must retry a failed CloudKit ticket lookup`);
          if (file === 'evaluation-release.yml') {
            assert.ok(/verify_apple spctl --assess/.test(verify.run), `${file}/${jobName} must retry transient spctl failures`);
          }
          // 待ちは 30・60・120・240 秒の最大 5 回（15 << attempt）。2 回呼ぶ evaluation の最悪 900 秒がジョブの 45 分に収まる
          assert.ok(/\[ "\$attempt" -ge 5 \]/.test(verify.run) && /attempt \$attempt of 5/.test(verify.run) && /sleep \$\(\(15 << attempt\)\)/.test(verify.run),
            `${file}/${jobName} must retry up to 5 times waiting 30/60/120/240 s`);
          // mac のビルドは、タイムスタンプのエラーだけ試し直す包みを通して呼ぶ（裸の desktop:dist に戻したらここで落とす）
          const build = steps.find(s => /desktop:dist/.test(s.run ?? '') && (/--mac/.test(s.run) || s.if === "runner.os == 'macOS'"));
          const wrapper = file === 'evaluation-release.yml' ? 'release-prep/scripts/retry-on-codesign-timestamp.mjs' : 'scripts/retry-on-codesign-timestamp.mjs';
          assert.ok(build && build.run.startsWith(`node ${wrapper} --clean dist-desktop -- npm run desktop:dist`), `${file}/${jobName} must build macOS through the timestamp retry wrapper`);
        }
      }
    }
    const evaluationText = await fs.readFile(new URL('.github/workflows/evaluation-release.yml', root), 'utf8');
    const evaluation = parse(evaluationText);
    // 古いタグのやり直しでも動くよう、準備・包みはワークフローの commit（release-prep）から呼ぶ。最悪の待ちは job の上限に収まる
    assert.equal(evaluation.jobs.mac['timeout-minutes'], 45);
    assert.ok(evaluation.jobs.mac.steps.some(s => s.uses?.startsWith('actions/checkout@') && s.with?.path === 'release-prep' && s.with['sparse-checkout'] === 'scripts'));
    assert.ok(!/run: npm run desktop:dist .*--mac/.test(evaluationText), 'mac build must not call desktop:dist directly');
    t.ok('Every release packaging job must pass the real UI startup gate before upload', true);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
