// 各 bot が実際に動く場所を、画面側で引く部品（判定そのものは web/work-place.mjs の workPlace。core の pickCwd と同じもの）。
// 判定に要るのは bot のモード（範囲 full は cwd をそのまま使う）。モードの表はバックエンドごとに host.cmd('modes') で取って覚える。
//
//   const places = createWorkPlaces({ host });
//   await places.ensure(bots);              … 使う bot のバックエンドのモードを取る（取れるまで待つ）
//   places.of(bot, channelCwd)              … { cwd, uses, reason }（同期。モードが未取得の間は範囲を限れる扱い。取れたら onReady が呼ばれる）
import { workPlace, modeEntryFor, unrestrictedEntry } from '../work-place.mjs';

/**
 * チャンネルの設定の「各 bot が動く場所」の行。bots のうち実在の bot（素の bot は、モードもフォルダーもスレッドごとに決まるので出さない）それぞれについて
 * { bot, cwd, uses, reason, outside }。outside は「チャンネルのフォルダーを指定したのに、その bot は使わない」（理由の一文を添える行）
 */
export function whereRows(places, bots, channelCwd) {
  const wanted = String(channelCwd ?? '').trim() || null;
  return (bots ?? []).filter((b) => b && !b.plain).map((bot) => {
    const p = places.of(bot, wanted);
    return { bot, ...p, outside: Boolean(wanted) && p.uses === 'bot' };
  });
}

export function createWorkPlaces({ host, onReady = () => {} }) {
  const modes = new Map();      // backend → modes（取れたものだけ）
  const loading = new Map();    // backend → Promise

  function load(backend) {
    if (!backend || modes.has(backend)) return Promise.resolve();
    if (loading.has(backend)) return loading.get(backend);
    const p = Promise.resolve(host.cmd('modes', { backend }))
      .then((m) => { if (m && Object.keys(m).length) modes.set(backend, m); })
      .catch(() => {})
      .finally(() => loading.delete(backend));
    loading.set(backend, p);
    return p;
  }

  return {
    /** bots のバックエンドのモードを取る。新しく取れたものがあれば true */
    async ensure(bots) {
      const missing = [...new Set((bots ?? []).filter((b) => b && !b.plain).map((b) => b.backend))].filter((id) => id && !modes.has(id));
      if (!missing.length) return false;
      await Promise.all(missing.map(load));
      return missing.some((id) => modes.has(id));
    },
    /** 取れていないバックエンドがあれば裏で取り、取れたら onReady（描き直し）を呼ぶ */
    warm(bots) {
      const missing = (bots ?? []).filter((b) => b && !b.plain && b.backend && !modes.has(b.backend));
      if (missing.length) this.ensure(missing).then((got) => { if (got) onReady(); });
    },
    of(bot, channelCwd = null) {
      const entry = bot?.plain ? null : modeEntryFor(modes.get(bot?.backend), bot?.mode);
      return workPlace({ folders: bot?.folders, channelCwd, unrestricted: unrestrictedEntry(entry), home: host.state?.homeDir ?? '' });
    },
    loaded: (backend) => modes.has(backend),
  };
}
