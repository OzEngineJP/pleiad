// 更新の切り替えはロック後に旧サーバーを通常停止し、新サーバーを通常起動する。
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sw = require('../../desktop/switch.cjs');

export const name = 'desktop-switch';
export const title = 'サーバー更新: ロック・通常停止・通常起動・失敗時の復旧';

const OLD = { appVersion: '1.0.0', build: 'aaaaaaaaaaaa' };
const NEW = { appVersion: '1.0.1', build: 'bbbbbbbbbbbb' };

function machine({ lock = { ok: true }, stop = { ok: true }, startNew, startPrevious, ask = 'later', reattach = true, check = { check: 1, ipc: [1, 1], dataSchema: 2, dataSchemaFound: 2 } } = {}) {
  const calls = [];
  const heldChild = { id: 'turn:session-1', alive: true };
  const effects = {
    prepare: async () => { calls.push('prepare'); return { ok: true, runtime: { root: 'runtime', key: 'new' }, mode: 'detached' }; },
    check: async () => { calls.push('check'); return check; },
    lock: async () => { calls.push('lock'); return lock; }, unlock: () => calls.push('unlock'),
    stopOld: async () => { calls.push('stopOld'); return stop; },
    reattachOld: async () => { calls.push('reattachOld'); return reattach; },
    startNew: async () => { calls.push('startNew'); return startNew ? startNew() : { ...NEW, port: 7420, token: 'token' }; },
    startPrevious: async () => { calls.push('startPrevious'); return startPrevious ? startPrevious() : { ...OLD, port: 7420, token: 'token' }; },
    reload: async () => calls.push('reload'), restart: async () => calls.push('restart'),
    fallback: async () => calls.push('fallback'), failed: async () => calls.push('failed'),
    ask: async () => ask,
  };
  const control = sw.createSwitch({ server: OLD, target: NEW, effects });
  return { control, calls, heldChild };
}

export default async function (t) {
  t.ok('ビルドが異なれば更新する', sw.needsSwitch(OLD, NEW));
  t.ok('同じ版とビルドなら更新しない', !sw.needsSwitch(OLD, { ...OLD }));
  t.ok('互換性検査が通る', sw.judgeCheck({ check: 1, ipc: [1, 1], dataSchema: 2, dataSchemaFound: 2 }).ok);
  t.ok('データ形式が異なれば互換性検査で止める', sw.judgeCheck({ check: 1, ipc: [1, 1], dataSchema: 3, dataSchemaFound: 2 }).reason === 'schema');

  {
    const { control, calls, heldChild } = machine({ startNew: () => {
      return heldChild.alive ? { ...NEW, port: 7420, token: 'token' } : null;
    } });
    const result = await control.run();
    t.ok('作業中でも待たずにロック・旧サーバーの通常停止・新サーバーの通常起動へ進む',
      result.state === 'done' && calls.join(' ') === 'prepare check lock stopOld startNew reload', calls.join(' '));
    t.ok('新サーバーの起動時にも保持役の子が残っている', heldChild.alive && result.server.build === NEW.build);
  }

  {
    const { control, calls } = machine({ lock: { ok: false, reason: 'busy' } });
    const result = await control.run();
    t.ok('更新ロックを取れないときは旧サーバーを止めない', result.state === 'failed' && !calls.includes('stopOld'));
  }

  {
    const { control, calls } = machine({ startNew: () => { throw new Error('new server failed'); } });
    const result = await control.run();
    t.ok('新サーバーが起動しなければ同じデータ置き場で旧版を起動し直す',
      result.state === 'done' && result.previous && calls.includes('startPrevious') && calls.includes('fallback'));
  }

  {
    const { control, calls } = machine({ stop: { ok: false, error: 'shutdown timeout' } });
    const result = await control.run();
    t.ok('旧サーバーが止まらなければ再接続を試し、更新を失敗として終える',
      result.state === 'failed' && calls.includes('reattachOld') && !calls.includes('startNew'));
  }

  {
    const { control, calls } = machine({ ask: null, check: { check: 1, ipc: [2, 3], dataSchema: 2, dataSchemaFound: 2 } });
    const run = control.run();
    while (control.snapshot().state !== 'incompatible') await new Promise(resolve => setImmediate(resolve));
    t.ok('互換性を確かめられない版だけは更新を進めるか確認する', control.answer('later'));
    while (control.snapshot().state !== 'held') await new Promise(resolve => setImmediate(resolve));
    t.ok('あとでを選ぶと互換性が解決するまで旧サーバーを動かし続ける', !calls.includes('stopOld'));
    control.cancel();
    await run;
  }
}
