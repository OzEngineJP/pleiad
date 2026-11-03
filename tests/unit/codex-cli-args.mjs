// `codex app-server` の `-c key=value` の値の形（issue #157）。
// codex は -c の値を TOML のインライン値として読み、読めなければ文字列にする。skills.config（sequence）・
// mcp_servers（map）を JSON（"key":）で書くと文字列になり、app-server が起動直後に exit 1 で落ちる。
// launch()（このサーバーの子）と保持役の子の 2 経路（codex-held.mjs）が、同じ codexConfigArgs（codex-cli-args.mjs）で `-c` を作る。
// 手元に本物の codex があれば、一時の CODEX_HOME で `codex -c <値> features list` を shell 無しで起こし、TOML で exit 0・JSON で exit 1 も見る
// （Issue の再現表と同じ確かめ方。利用者の ~/.codex は開かない）。
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { codexConfigArgs, tomlValue } from '../../core/backends/codex-cli-args.mjs';
import { acquireHeldAppServer, acquireHeldTurnAppServer, configureCodexHeld } from '../../core/backends/codex-held.mjs';
import { findExecutable } from '../../core/cli-installation.mjs';

export const name = 'codex-cli-args';
export const title = 'Codex の -c の値: TOML のインライン形・保持役の 2 経路・本物の codex で受け付ける';

/** spawn の args の `app-server` の後の `-c key=value` を { key: 'key=value' } にする */
function cArgs(args) {
  const i = args.indexOf('app-server');
  assert.notEqual(i, -1, 'app-server を起こす引数');
  const pairs = {};
  for (let j = i + 1; j < args.length; j += 2) {
    assert.equal(args[j], '-c', '-c の引数の並び');
    pairs[args[j + 1].split('=')[0]] = args[j + 1];
  }
  return pairs;
}

/** 値が TOML のインライン値の形か（JSON の "key": ではない） */
const isToml = v => !/"[^"\\]*":/.test(v);

export default async function (t) {
  // ---- 1. codexConfigArgs / tomlValue の形
  {
    assert.equal(tomlValue('file'), '"file"');
    assert.equal(tomlValue(false), 'false');
    assert.equal(tomlValue(0), '0');
    assert.equal(tomlValue([{ path: 'D:/x/SKILL.md', enabled: false }]), '[{"path"="D:/x/SKILL.md","enabled"=false}]', '配列は TOML のインライン表');
    assert.equal(tomlValue({ srv: { command: 'x', enabled: false, required: false } }), '{"srv"={"command"="x","enabled"=false,"required"=false}}', 'map も TOML のインライン表');
    assert.deepEqual(codexConfigArgs({ 'a.b': 'x', 'features.plugins': false }), ['-c', 'a.b="x"', '-c', 'features.plugins=false']);
    assert.equal(codexConfigArgs({ 'skills.config': [{ path: 'x', enabled: false }], mcp_servers: { s: { command: 'y' } } })
      .every((v, i) => i % 2 === 0 ? v === '-c' : isToml(v)), true, '値が配列・map のとき JSON の形（"key":）を含まない');
    t.ok('-c の値は TOML のインライン値（[{…}]・{k=…}）で、JSON の "key": の形を含まない', true);
  }

  // ---- 2. 保持役に載せる 2 経路も同じ作り方（spawn に渡る引数）
  {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-codex-args-')));
    const saved = Object.fromEntries(['AGENT_HOST_RUNTIME_ROOT', 'AGENT_HOST_CODEX_HOLDER', 'AGENT_HOST_CODEX_TURN_HOLDER', 'AGENT_HOST_CODEX_BIN'].map(k => [k, process.env[k]]));
    process.env.AGENT_HOST_RUNTIME_ROOT = root;
    process.env.AGENT_HOST_CODEX_HOLDER = 'on';
    process.env.AGENT_HOST_CODEX_TURN_HOLDER = 'on';
    process.env.AGENT_HOST_CODEX_BIN = `"${process.execPath}"`;
    configureCodexHeld({ dataDir: () => root });
    const client = new EventEmitter();
    client.connected = true;
    client.welcome = { children: [] };
    const spawns = [];
    client.spawn = spec => spawns.push(spec);
    client.label = () => {};
    client.mark = () => {}; client.unmark = () => {}; client.ack = () => {};
    client.attach = async () => ({ alive: false, pendingRequests: [] });
    client.replay = async () => ({ lines: [] });
    client.release = () => {};
    client.kill = id => queueMicrotask(() => client.emit('exit', { id, code: 0 }));
    client.write = () => true;
    const helds = [];
    try {
      const account = { id: 'acct-toml', name: 'toml', dir: path.join(root, 'account') };
      helds.push(await acquireHeldAppServer({ cli_auth_credentials_store: 'file' }, { account, env: { CODEX_HOME: account.dir }, link: async () => client }));
      const config = {
        project_doc_max_bytes: 0,
        'skills.config': [{ path: 'D:/x/SKILL.md', enabled: false }],
        mcp_servers: { srv: { command: 'x', enabled: false, required: false } },
        'features.plugins': false,
      };
      helds.push(await acquireHeldTurnAppServer(config, { env: { CODEX_HOME: root }, link: async () => client }));
      assert.equal(spawns.length, 2, '保持役へ spawn したのは 2 経路とも');
      assert.deepEqual(cArgs(spawns[0].args), { cli_auth_credentials_store: 'cli_auth_credentials_store="file"' }, '共有の app-server');
      const pairs = cArgs(spawns[1].args);
      assert.equal(pairs['project_doc_max_bytes'], 'project_doc_max_bytes=0');
      assert.equal(pairs['skills.config'], 'skills.config=[{"path"="D:/x/SKILL.md","enabled"=false}]');
      assert.equal(pairs['mcp_servers'], 'mcp_servers={"srv"={"command"="x","enabled"=false,"required"=false}}');
      assert.equal(pairs['features.plugins'], 'features.plugins=false');
      assert.ok(Object.values(pairs).every(isToml), 'どの値も JSON の形を含まない');
      t.ok('保持役に載せる 2 経路（共有・ターン専用）も -c を TOML で作る', true);
    } finally {
      for (const held of helds) await held?.stop({ waitMs: 50 }).catch(() => {});
      configureCodexHeld({ dataDir: () => null });
      for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ---- 3. 本物の codex が受け付ける形（codex が入っていなければとばす）
  {
    const codex = findExecutable('codex');
    if (!codex) {
      t.skip('codex が入っていないので、本物の codex での確かめはとばす');
      return;
    }
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-codex-home-')));
    const run = extra => new Promise(resolve => {
      const child = spawn(codex, [...extra, 'features', 'list'], { env: { ...process.env, CODEX_HOME: home }, windowsHide: true });
      let err = '';
      child.stderr.on('data', d => { err += d; });
      child.on('error', error => resolve({ code: -1, err: String(error) }));
      child.on('close', code => resolve({ code, err }));
      setTimeout(() => { child.kill(); resolve({ code: -1, err: `${err}（60 秒で時間切れ）` }); }, 60_000);
    });
    try {
      const config = {
        'skills.config': [{ path: 'D:/x/SKILL.md', enabled: false }],
        mcp_servers: { srv: { command: 'x', enabled: false, required: false } },
        'features.plugins': false,
      };
      const toml = await run(codexConfigArgs(config));
      t.ok('codex -c <TOML> features list が exit 0', toml.code === 0, toml.err.slice(-300));
      // 反対の確かめ: 同じ値を JSON（"key":）で渡すと、codex が文字列として受けて型不一致で落ちる（Issue の再現）
      const json = await run(Object.entries(config).flatMap(([k, v]) => ['-c', `${k}=${JSON.stringify(v)}`]));
      t.ok('codex -c <JSON> は exit 0 にならない（値を TOML として読む確かめ）', json.code !== 0 && json.code !== -1, `code=${json.code} ${json.err.slice(-200)}`);
    } finally {
      await fs.rm(home, { recursive: true, force: true }).catch(() => {});
    }
  }
}
