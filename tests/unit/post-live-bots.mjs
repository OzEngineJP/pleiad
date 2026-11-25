// 流れの要約の「作業中の bot」の選び方（web/channels/post.mjs）の、画面を持たない判定。
// 描画は tests/browser/channels.cjs。bot 専用の使用量の仕組み（予算・メーター）は ADR 0357 でやめた（このファイルの前身は thread-budget-ui）。
import { readFileSync } from 'node:fs';
import { liveBotIds } from '../../web/channels/post.mjs';

export const name = 'post-live-bots';
export const title = '要約の作業中の bot の選び方（working だけ・waiting は別・印が無ければ空）';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

export default function (t) {
  // ---- 要約: 作業中の bot は ThreadState.live から選ぶ
  const live = { b_mike: 'working', b_hana: 'waiting', b_taro: 'working' };
  t.ok('作業中の要約は、working の bot だけ（waiting の bot は含めない）。印の並び', liveBotIds({ state: 'working', live }).join() === 'b_mike,b_taro');
  t.ok('あなた待ちの要約は、waiting の bot', liveBotIds({ state: 'waiting', live }).join() === 'b_hana');
  t.ok('印が無い・空なら空（返信した最後の bot や最初の会話の bot を名前にしない）', liveBotIds({ state: 'working' }).length === 0 && liveBotIds({ state: 'working', live: {} }).length === 0 && liveBotIds(null).length === 0);
  const post = read('web/channels/post.mjs');
  t.ok('要約は返信した最後の bot（s.authors）と th.sessions の最初のキーを使わない', !/s\.authors/.test(post.slice(post.indexOf('export function renderSummary'))) && !/Object\.keys\(th\?\.sessions/.test(post));
}
