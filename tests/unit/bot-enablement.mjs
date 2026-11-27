import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBotEnablement } from '../../core/bots/enablement.mjs';
import { startServer } from '../lib/server.mjs';
import { open } from '../lib/ws-client.mjs';

export const name = 'bot-enablement';
export const title = 'bot の全体スイッチ: 初期値、既存データ、読み直し、実行中の切り替え';

export default async function (t) {
  let unreadable = true;
  let stored;
  const gate = createBotEnablement({
    read: async () => {
      if (unreadable) throw new Error('read failed');
      return { botEnablement: stored };
    },
    existing: async () => true,
    locale: () => 'ja',
    changed: async () => {},
  });
  t.ok('読み込みの失敗は保留する', !await gate.allowed());
  unreadable = false;
  t.ok('読み直すと既存データからオンになる', await gate.allowed() && !stored);
  const manual = Promise.withResolvers();
  const started = Promise.withResolvers();
  const saved = Promise.withResolvers();
  const background = gate.backgroundSignal();
  const work = gate.run('manual', true, () => { started.resolve(); return manual.promise; });
  await started.promise;
  const steered = Promise.withResolvers();
  const steerStarted = Promise.withResolvers();
  const extraWork = gate.run('manual', false, (signal) => { steerStarted.resolve(signal); return steered.promise; });
  const steerSignal = await steerStarted.promise;
  gate.promote('manual');
  const disabling = gate.set(false, async (value) => { stored = value; saved.resolve(); });
  await saved.promise;
  t.ok('人の応答を待つ間に受付を閉じ、設定の表示は待つ', !gate.enabled() && gate.finishing('manual') && (await gate.load()).enabled);
  t.ok('自動処理を中断する', background.aborted);
  manual.resolve();
  await work;
  t.ok('同じ会話に人が追送した応答も完了を待つ', gate.finishing('manual') && !steerSignal.aborted && (await gate.load()).enabled);
  steered.resolve();
  await extraWork;
  await disabling;
  t.ok('人の応答の後でオフを確定する', !gate.enabled() && !gate.finishing('manual') && stored.enabled === false);
  await gate.set(true, async (value) => { stored = value; });
  t.ok('再有効化では新しい処理が動ける', gate.enabled() && !gate.backgroundSignal().aborted && stored.since > 0);

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bot-enablement-'));
  let server, client;
  const invoke = (op, args) => client.cmd('invoke', { op, args });
  const value = () => invoke('settings.get', { key: 'botEnabled' }).then(result => result.value);
  const set = (enabled) => invoke('settings.set', { key: 'botEnabled', value: enabled });
  const rejects = async (promise) => promise.then(() => false, e => /bot.*オン/.test(e.message));
  const shutdown = async () => { client?.close(); await server?.stop(); };
  const boot = async () => {
    server = await startServer({ dataDir, env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' } });
    client = await open({ port: server.port, token: server.token });
  };
  try {
    await boot();
    t.ok('新しいホストの既定はオフ', await value() === false);
    t.ok('オフでは bot とチャンネルを新規作成できない',
      await rejects(invoke('bots.create', { name: 'Owl', backend: 'fake' })) &&
      await rejects(invoke('channels.create', { name: 'history' })));
    await set(true);
    const channel = await invoke('channels.create', { name: 'history' });
    const post = await invoke('channels.post', { channelId: channel.id, text: 'readable while off' });
    await set(false);
    t.ok('オフで既存投稿は読める', (await invoke('channels.read', { channelId: channel.id })).posts.some(row => row.id === post.id));
    t.ok('オフでは返信できない', await rejects(invoke('channels.post', { channelId: channel.id, threadId: post.id, text: 'disabled' })));
    await set(true);
    await invoke('channels.archive', { channelId: channel.id, on: true });
    await set(false);
    await shutdown();
    await boot();
    t.ok('再起動しても明示したオフは保存される', await value() === false);
    await shutdown();
    const file = path.join(dataDir, 'prefs.json');
    const oldPrefs = JSON.parse(await fs.readFile(file, 'utf8'));
    delete oldPrefs.botEnablement;
    await fs.writeFile(file, JSON.stringify(oldPrefs));
    await boot();
    t.ok('アーカイブ済みチャンネルだけでもオンになり、設定は書き換えない',
      await value() === true && !JSON.parse(await fs.readFile(file, 'utf8')).botEnablement);
  } finally {
    await shutdown();
    await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  }
}
