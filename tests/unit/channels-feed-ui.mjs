// チャンネルの流れの部品（web/channels/）の、画面を持たない判定: @ の補完（トークンの取り方・候補の絞り込み）・リアクションの札と手元の先取り・日と時刻の文言・配線。
// 描画・キー操作・出来事での更新は tests/browser/channels.cjs（実ブラウザー）。
import { readFileSync } from 'node:fs';
import { mentionToken, filterCandidates } from '../../web/channels/mention-complete.mjs';
import { pillsOf, withReaction, isMine } from '../../web/channels/reactions.mjs';
import { whenText, dayText, unrepresentedActivity } from '../../web/channels/post.mjs';
import { findMentionBlocks } from '../../web/channels/mention-blocks.mjs';

export const name = 'channels-feed-ui';
export const title = 'チャンネルの流れ: @ の補完の判定・候補の絞り込み・リアクションの札・時刻の文言・スレッドを開く口の配線';

const read = (p) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

export default function (t) {
  // ---- @ のトークン（slash-skills の「/」と同じ判定）
  const tok = (s, caret = s.length) => mentionToken(s, caret);
  t.ok('行頭・空白の後の @ から打った名前を取る', tok('@Ow')?.query === 'Ow' && tok('お願い @Ow')?.query === 'Ow' && tok('a @')?.query === '');
  t.ok('日本語・開き括弧の直後の @ も候補を出す', tok('お願い@Ow')?.query === 'Ow' && tok('（@O')?.query === 'O' && tok('「@')?.query === '');
  t.ok('メールの形・語の途中の @ では出さない', tok('a@Ow') === null && tok('mail@example.com') === null);
  t.ok('@ の後に空白が入ったら終わり。別の @ も新しい始まり', tok('@Ow ') === null && tok('@Owl @Ly')?.query === 'Ly' && tok('@a@b') === null);
  t.ok('カーソルが名前の途中なら続きまで置き換える範囲を返す', (() => { const r = tok('@Owlet', 3); return r?.query === 'Ow' && r.start === 0 && r.end === 6; })());
  t.ok('範囲選択中・長すぎる名前では出さない', mentionToken('@Owl', 4, 2) === null && tok('@' + 'a'.repeat(41)) === null);

  // ---- 候補の絞り込み（前方一致 → 部分一致。元の並びを保つ）
  const cands = [{ id: 'b_owl', name: 'Owl' }, { id: 'b_lynx', name: 'Lynx' }, { id: 'b_kit', name: 'Kit' }, { id: 'b_howl', name: 'Howler' }, { id: 'you', name: 'あなた' }];
  const names = (q) => filterCandidates(cands, q).map((c) => c.name).join(',');
  t.ok('空の問いは全部（元の並び）', names('') === 'Owl,Lynx,Kit,Howler,あなた');
  t.ok('前方一致が先、部分一致が後（大小を区別しない）', names('o') === 'Owl,Howler' && names('OW') === 'Owl,Howler' && names('ow') === 'Owl,Howler');
  t.ok('全角・日本語も当たる。当たらなければ空', names('Ｏｗ') === 'Owl,Howler' && names('あな') === 'あなた' && names('zzz') === '');

  // ---- 入力欄の宛先の塊（本文の `@名前` のうち bot の名前に当たるもの。ADR 0362）
  const bots = [{ id: 'b_owl', name: 'Owl' }, { id: 'b_owlet', name: 'Owlet' }, { id: 'b_ru', name: 'ルナ' }];
  const blk = (s, caret = null) => findMentionBlocks(s, bots, { caret }).map((m) => `${m.bot.id}@${m.start}-${m.end}`).join(',');
  t.ok('名前の後に空白・句読点・行末が来たら塊にする。長い名前を先に見る', blk('@Owl お願い') === 'b_owl@0-4' && blk('@Owlet お願い') === 'b_owlet@0-6' && blk('見て@ルナ、どう？') === 'b_ru@2-5');
  t.ok('複数の宛先はそれぞれ塊（全員に届く）', blk('@Owl @ルナ お願い') === 'b_owl@0-4,b_ru@5-8');
  t.ok('打っている途中（キャレットが名前の直後）・名前の続き・メールの形は塊にしない', blk('@Owl', 4) === '' && blk('@Owlx') === '' && blk('a@Owl ') === '' && blk('@Owl_x') === '' && blk('@Owl', null) === 'b_owl@0-4');
  t.ok('bot がいない・名前の無い bot は塊にしない', findMentionBlocks('@Owl ', [], {}).length === 0 && findMentionBlocks('@ ', [{ id: 'x', name: ' ' }], {}).length === 0);
  t.ok('全角・大小の違いは同じ名前として数える（サーバーの解析と同じ）', blk('@ＯＷＬ ') === 'b_owl@0-4' && blk('@owl ') === 'b_owl@0-4');

  // ---- リアクションの札
  const you = { kind: 'human' }, owl = { kind: 'bot', botId: 'b_owl' }, lynx = { kind: 'bot', botId: 'b_lynx' };
  const reactions = { '👍': [owl, you], '🎉': [lynx], '🔥': [] };
  const pills = pillsOf(reactions);
  t.ok('札は付いた順・空の絵文字は出さない', pills.map((p) => p.emoji).join('') === '👍🎉' && pills[0].count === 2 && pills[1].count === 1);
  t.ok('自分の分があれば mine（bot だけなら mine ではない）', pills[0].mine === true && pills[1].mine === false && isMine(you) && !isMine(owl));
  t.ok('reactions が無くても落ちない', pillsOf(undefined).length === 0 && pillsOf({}).length === 0);
  const on = withReaction(reactions, '🎉', true);
  t.ok('付ける: 自分を足す。元の写しは変えない', on['🎉'].length === 2 && on['🎉'].some(isMine) && reactions['🎉'].length === 1);
  t.ok('付けると同じ絵文字をもう一度付けても増えない', withReaction(on, '🎉', true)['🎉'].length === 2);
  const off = withReaction(reactions, '👍', false);
  t.ok('外す: 自分だけを抜く。bot の分は残る', off['👍'].length === 1 && off['👍'][0].botId === 'b_owl');
  t.ok('最後の 1 人が外すと絵文字ごと消える', !('🎉' in withReaction({ '🎉': [you] }, '🎉', false)) && Object.keys(withReaction({}, '🙏', true)).join('') === '🙏');

  // ---- 日と時刻の文言（今日は時分だけ、別の日は月日も）
  const now = new Date(2026, 9, 3, 15, 0).getTime();
  const same = new Date(2026, 9, 3, 9, 5).getTime(), yesterday = new Date(2026, 9, 2, 23, 30).getTime(), older = new Date(2026, 8, 20, 8, 0).getTime();
  t.ok('同じ日は時分だけ', /^0?9:05$/.test(whenText(same, now)));
  t.ok('別の日は月日と時分', /9\/20|9月20日/.test(whenText(older, now)) && /8:00/.test(whenText(older, now)));
  t.ok('日の区切り: 今日・昨日・それ以前は月日', dayText(same, now) === '今日' && dayText(yesterday, now) === '昨日' && /9月20日/.test(dayText(older, now)));

  // ---- 配線（文字列で）
  const index = read('web/channels/index.mjs');
  t.ok('部品の一覧に流れが入っている', /const feed = createFeed\(host\);\s+parts\.push\(feed\)/.test(index) && /from '\.\/feed\.mjs'/.test(index));
  t.ok('スレッドを開く口（host.openThread）を足し、部品の openThread へ配る', /host\.openThread \?\?=/.test(index) && /each\('openThread'/.test(index));
  t.ok('どこからでも開ける入口（channels:show）がある', /addEventListener\('channels:show'/.test(index));
  const feed = read('web/channels/feed.mjs');
  t.ok('書き込みは channels.* の操作（invoke）だけ。新しい WS コマンドは足さない',
    /invoke\('channels\.post'/.test(feed) && /invoke\('channels\.react'/.test(feed) && /invoke\('channels\.read'/.test(feed) && !/host\.cmd\(/.test(feed));
  t.ok('流れの受ける出来事', ['channelPost', 'channelReaction', 'channelThread', 'channelRead', 'channelsChanged', 'botsChanged'].every((e) => feed.includes(e)));
  t.ok('web/client.mjs・core/server.mjs には依存を足していない', !/client\.mjs|server\.mjs/.test(feed + read('web/channels/post.mjs') + read('web/channels/reactions.mjs')));

  // ---- スマホのスレッド・投稿の見た目（承認済み 2026-11-27）
  const postJs = read('web/channels/post.mjs');
  const activity = unrepresentedActivity({ live: { owl: 'waiting', lynx: 'working' }, liveSince: { owl: 1200, lynx: 1400 } }, [
    { turn: { botId: 'owl' }, state: 'done' },
    { turn: { botId: 'lynx' }, state: 'working' },
  ]);
  t.ok('A finished reply leaves room for the next turn, and an active reply represents its own bot',
    activity.length === 1 && activity[0].botId === 'owl' && activity[0].state === 'waiting' && activity[0].since === 1200);
  const feedCss = read('web/channels-feed.css');
  const threadCss = read('web/channels-thread.css');
  const styleCss = read('web/style.css');
  t.ok('post.mjs が bot/人の本文に .body を付け、system 投稿（.post.sys）には付けない',
    /if \(info\.kind !== 'system'\) body\.classList\.add\('body'\)/.test(postJs));
  t.ok('channels-feed.css は .post-body p の段落上書きを持たず、ホバー面を @media (hover:hover) に閉じている',
    !/\.post-body\s+p\b/.test(feedCss) && /@media\s*\(hover:hover\)\s*\{[^}]*\.post:hover,\.post:focus-within\{background:var\(--surface-hover\)\}/.test(feedCss));
  t.ok('channels-feed.css の 700px 以下は .post-main に display:contents を当て、アイコンを 20px で名前の行へ並べる',
    /@media\s*\(max-width:700px\)\s*\{[\s\S]*\.post-main\{display:contents\}[\s\S]*width:20px;height:20px/.test(feedCss));
  t.ok('channels-thread.css の作業ログ見出し・返信区切りは --fs-meta を使い、チェックリストのホバー面を hover:hover に閉じている',
    /\.th-worklog-head\{[^}]*font-size:var\(--fs-meta\)/.test(threadCss) && /\.th-rdiv\{[^}]*font-size:var\(--fs-meta\)/.test(threadCss) && /@media\s*\(hover:hover\)\{\.post:hover \.post-body ul\.ck/.test(threadCss));
  t.ok('style.css の 700px 以下で投稿の本文を 17px/1.7 に揃え、札の無い入力欄では .crow-gap を残す',
    /\.post:not\(\.sys\) \.post-body\{font-size:var\(--fs-body\);line-height:1\.7\}/.test(styleCss) && /\.crow:has\(>\s*:is\(\.chip\.model,\.chip\.folder\):not\(\[hidden\]\)\)\s*>\s*\.crow-gap\{display:none\}/.test(styleCss));
}
