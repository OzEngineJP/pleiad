// チャンネルの流れの入力欄の「/」候補の「だれの・どこの」スキル（web/channels/feed-skills.mjs）。
// 宛先の決め方（@ した bot → いなければ呼べるメンバー）・動く場所ごとの束ね・名前でのまとめ・見出しと行頭の顔・取り直しの印の安定。
// core の slashSkills・本物のモードの表は呼ばない（host は偽物）。
import { skillBots, skillPlan, parsePlan, mergeSkills, scanSkills, createFeedSkills } from '../../web/channels/feed-skills.mjs';
import { createWorkPlaces } from '../../web/channels/work-places.mjs';

export const name = 'feed-skills';
export const title = '流れの入力欄の / 候補: 宛先の bot（@ か呼べるメンバー）・動く場所ごとの取得と名前でのまとめ・見出しと顔・印の安定';

const MODES = { guarded: { scope: 'workspace', autonomy: 'ask' }, open: { scope: 'full', autonomy: 'never' } };
const owl = { id: 'b-owl', name: 'Owl', backend: 'claude', mode: 'guarded', folders: [{ path: '/work/owl', access: 'rw' }] };
const fox = { id: 'b-fox', name: 'Fox', backend: 'claude', mode: 'guarded', folders: [{ path: '/work/fox', access: 'rw' }] };
const ant = { id: 'b-ant', name: 'Ant', backend: 'claude', mode: 'open', folders: [{ path: '/work/ant', access: 'rw' }] };
const bare = { id: 'b-bare', name: 'Bare', backend: 'claude', mode: 'guarded', folders: [] };
const plain = { id: 'b-plain', name: 'Plain', plain: true, backend: 'claude', folders: [] };
const ALL = [owl, fox, ant, bare, plain];

const BY_CWD = {
  '/work/owl': [{ name: 'review', description: 'owl 版', hint: '' }, { name: 'only-owl', description: 'Owl だけ', hint: '' }],
  '/work/fox': [{ name: 'review', description: 'fox 版', hint: '' }, { name: 'only-fox', description: 'Fox だけ', hint: '' }],
  '/work/shared': [{ name: 'review', description: 'shared 版', hint: '' }],
};

function fakeHost({ failFor = [], modes = MODES } = {}) {
  const calls = [];
  return {
    calls,
    state: { homeDir: '/home/me' },
    cmd: async (op, args) => {
      calls.push([op, args]);
      if (op === 'modes') return modes;
      if (op === 'slashSkills') {
        if (failFor.includes(args.cwd)) throw new Error('取れない');
        return BY_CWD[args.cwd] ?? [];
      }
      return null;
    },
  };
}

export default async function (t) {
  // --- 宛先の bot ---
  const ids = (r) => r.bots.map((b) => b.id).join();
  t.ok('@ した bot が宛先（from=mention）。呼べるメンバーより優先', ids(skillBots('@Fox 見て', { bots: ALL, fallback: [owl] })) === 'b-fox'
    && skillBots('@Fox 見て', { bots: ALL, fallback: [owl] }).from === 'mention');
  t.ok('誰も @ していなければ呼べるメンバー（from=members）', ids(skillBots('調べて', { bots: ALL, fallback: [owl, fox] })) === 'b-owl,b-fox'
    && skillBots('調べて', { bots: ALL, fallback: [owl, fox] }).from === 'members');
  t.ok('複数 @ したら並びは bots の並び（書いた順にしない。同じ宛先は同じ印）', ids(skillBots('@Fox と @Owl へ', { bots: ALL, fallback: [] })) === 'b-owl,b-fox');
  t.ok('素の bot への @ は宛先に数えない（メンバーに戻る）', ids(skillBots('@Plain どう', { bots: ALL, fallback: [owl] })) === 'b-owl');
  t.ok('同じ bot を 2 回 @ しても 1 体', ids(skillBots('@Owl @Owl', { bots: ALL, fallback: [] })) === 'b-owl');
  t.ok('宛先が無く fallback も空なら空（空の引き先）', skillBots('', { bots: ALL, fallback: [] }).bots.length === 0 && skillBots('x').bots.length === 0);
  t.ok('fallback の空の要素は落とす', ids(skillBots('', { bots: ALL, fallback: [undefined, owl, null] })) === 'b-owl');

  // --- 動く場所ごとの束ね・印 ---
  const places = createWorkPlaces({ host: fakeHost() });
  await places.ensure(ALL);
  const plan = skillPlan([fox, owl], null, places, 'members');
  t.ok('動く場所ごとに束ね、場所の名前順に並べる', plan.groups.map((g) => g.cwd).join() === '/work/fox,/work/owl' && plan.groups[0].botIds.join() === 'b-fox');
  t.ok('同じ宛先なら並びが違っても同じ印', skillPlan([owl, fox], null, places, 'members').key === plan.key);
  t.ok('宛先の出どころ（@ かメンバー）が違えば印も違う（見出しが変わるので取り直す）', skillPlan([owl, fox], null, places, 'mention').key !== plan.key);
  const shared = skillPlan([owl, fox], '/work/shared', places, 'members');   // ガード付きのモード: bot のフォルダーの外 → 各 bot のフォルダー
  t.ok('チャンネルの場所が bot のフォルダーの外なら、bot ごとの場所のまま', shared.groups.length === 2);
  const openPlan = skillPlan([ant, owl], '/work/shared', places, 'members');   // 範囲を限れないモードの bot は、チャンネルの場所で動く
  t.ok('範囲を限れないモードの bot はチャンネルの場所（ほかの bot とは別の組）', openPlan.groups.some((g) => g.cwd === '/work/shared' && g.botIds.join() === 'b-ant')
    && openPlan.groups.some((g) => g.cwd === '/work/owl'));
  const same = skillPlan([bare, ant], '/work/shared', places, 'members');
  t.ok('フォルダーの無い bot と範囲を限れない bot は同じ場所に束ねる', same.groups.length === 1 && same.groups[0].botIds.join() === 'b-bare,b-ant', JSON.stringify(same.groups));
  t.ok('宛先が空なら組も空', skillPlan([], null, places).groups.length === 0 && skillPlan(undefined, null, places).groups.length === 0);

  t.ok('印を読み戻せる', JSON.stringify(parsePlan(plan.key)) === JSON.stringify({ from: 'members', groups: plan.groups }));
  t.ok('読めない・空の印は空の引き先', parsePlan('').groups.length === 0 && parsePlan('{').groups.length === 0 && parsePlan('{"groups":3}').groups.length === 0
    && parsePlan('{"from":"x","groups":[null,{"cwd":1}]}').groups.length === 0 && parsePlan('{"from":"x"}').from === 'members');

  // --- 名前でのまとめ ---
  const merged = mergeSkills([
    { botIds: ['b-owl'], skills: BY_CWD['/work/owl'] },
    { botIds: ['b-fox'], skills: BY_CWD['/work/fox'] },
    { botIds: ['b-ant', 'b-bare'], skills: BY_CWD['/work/shared'] },
  ]);
  const review = merged.find((s) => s.name === 'review');
  t.ok('同じ名前は 1 行・持つ bot を全部覚える・説明は先に取れた方', merged.length === 3 && review.botIds.join() === 'b-owl,b-fox,b-ant,b-bare' && review.description === 'owl 版');
  t.ok('名前順に並べる', merged.map((s) => s.name).join() === 'only-fox,only-owl,review');
  t.ok('1 体だけのスキルはその bot だけ', merged.find((s) => s.name === 'only-fox').botIds.join() === 'b-fox');
  t.ok('同じ bot が 2 回入っても重ねない・名前の無い行は捨てる・空は空', mergeSkills([{ botIds: ['b-owl'], skills: [{ name: 'a' }, { description: 'x' }] }, { botIds: ['b-owl'], skills: [{ name: 'a' }] }])
    .map((s) => `${s.name}:${s.botIds}`).join() === 'a:b-owl' && mergeSkills([]).length === 0 && mergeSkills(undefined).length === 0);
  t.ok('元の配列は書き換えない', BY_CWD['/work/owl'][0].botIds === undefined);

  // --- 画面の部品（偽の host） ---
  const host = fakeHost();
  let members = [owl, fox];
  let channelCwd = null;
  const fs = createFeedSkills({ host, allBots: () => ALL, fallback: () => members, channelCwd: () => channelCwd });
  const k1 = fs.key('調べて');
  t.ok('宛先なし: メンバーの場所を束ねた印', parsePlan(k1).groups.map((g) => g.cwd).join() === '/work/fox,/work/owl' && parsePlan(k1).from === 'members');
  t.ok('同じ宛先の間は印が変わらない（候補を使い回す）', fs.key('別の文') === k1 && fs.key('調べて /re') === k1);
  t.ok('@ すると印が変わる', fs.key('@Fox 見て') !== k1 && parsePlan(fs.key('@Fox 見て')).from === 'mention');
  const got = await fs.load(k1);
  t.ok('場所ごとに 1 回ずつ slashSkills を引く（cwd を渡す）', host.calls.filter(([op]) => op === 'slashSkills').map(([, a]) => a.cwd).sort().join() === '/work/fox,/work/owl');
  t.ok('名前でまとめた候補を返す', got.map((s) => s.name).join() === 'only-fox,only-owl,review' && got.find((s) => s.name === 'review').botIds.length === 2);
  t.ok('同じ名前の説明は宛先の並びで先の bot（Owl）のもの（場所の名前順ではない）', got.find((s) => s.name === 'review').description === 'owl 版'
    && host.calls.filter(([op]) => op === 'slashSkills').map(([, a]) => a.cwd).join() === '/work/owl,/work/fox');

  const one = await (async () => { await fs.load(fs.key('@Owl 見て')); return fs.headLabel(fs.key('@Owl 見て')); })();
  t.ok('宛先が 1 体: 見出しは顔・「Owl のスキル」・動く場所', one.querySelector('.sk-who').textContent === 'Owl のスキル' && one.querySelector('.sk-where').textContent === '/work/owl' && !!one.querySelector('svg'),
    one.textContent);
  t.ok('宛先が 1 体のとき、行頭の顔は付けない（見出しに出ている）', fs.badge(got[0]) === null);
  const hiddenWhere = fs.headLabel(JSON.stringify({ from: 'mention', groups: [{ cwd: '', botIds: ['b-owl'] }] }));
  t.ok('場所が空なら場所を出さない', hiddenWhere.querySelector('.sk-where') === null);

  const kAll = fs.key('調べて');
  await fs.load(kAll);
  const many = fs.headLabel(kAll);
  t.ok('宛先が複数でメンバーから: 「メンバーのスキル」（場所は出さない）', many.querySelector('.sk-who').textContent === 'メンバーのスキル' && many.querySelector('.sk-where') === null && many.querySelector('svg') === null,
    many.textContent);
  const kMention = fs.key('@Owl @Fox 比べて');
  await fs.load(kMention);
  t.ok('宛先が複数で @ から: 「Owl、Fox のスキル」の形（名前を並べる）', /Owl.+Fox/.test(fs.headLabel(kMention).querySelector('.sk-who').textContent) && fs.headLabel(kMention).querySelector('.sk-who').textContent.includes('スキル'),
    fs.headLabel(kMention).textContent);
  const gotMention = await fs.load(kMention);
  const faces = fs.badge(gotMention.find((s) => s.name === 'only-fox'));
  t.ok('宛先が複数なら、行頭にそのスキルを持つ bot の顔（1 体）', !!faces && faces.querySelectorAll('svg').length === 1 && faces.getAttribute('title') === 'Fox', String(faces?.getAttribute('title')));
  const both = fs.badge(gotMention.find((s) => s.name === 'review'));
  t.ok('両方が持つスキルは両方の顔・title に名前（宛先の並び）', both.querySelectorAll('svg').length === 2 && both.getAttribute('title') === 'Owl・Fox', both.getAttribute('title'));
  t.ok('どの bot のものか分からない行には顔を付けない', fs.badge({ name: 'x', botIds: [] }) === null && fs.badge({ name: 'x' }) === null && fs.badge(null) === null);
  t.ok('宛先が空の印は見出しを出さない', fs.headLabel('') === null && fs.headLabel(JSON.stringify({ from: 'members', groups: [] })) === null);

  // --- 取れなかったとき ---
  const hostBad = fakeHost({ failFor: ['/work/fox'] });
  const fsBad = createFeedSkills({ host: hostBad, allBots: () => ALL, fallback: () => [owl, fox], channelCwd: () => null });
  const partial = await fsBad.load(fsBad.key(''));
  t.ok('一部の場所が取れなくても、取れた分は出す', partial.map((s) => s.name).join() === 'only-owl,review' && partial.every((s) => s.botIds.join() === 'b-owl'));
  const hostAllBad = fakeHost({ failFor: ['/work/fox', '/work/owl'] });
  const fsAllBad = createFeedSkills({ host: hostAllBad, allBots: () => ALL, fallback: () => [owl, fox], channelCwd: () => null });
  let thrown = null;
  try { await fsAllBad.load(fsAllBad.key('')); } catch (e) { thrown = e; }
  t.ok('全部の場所が取れなければ失敗にする（「取得できませんでした」を出せるように）', !!thrown);
  const fsNone = createFeedSkills({ host: fakeHost(), allBots: () => ALL, fallback: () => [], channelCwd: () => null });
  t.ok('宛先がいなければ空の候補（失敗にしない）', (await fsNone.load(fsNone.key(''))).length === 0);

  // --- サーバーの探索は接続ごとに 1 つずつ（並べて引くと 2 つ目が SCAN_BUSY で落ちる。実画面で見つけた） ---
  const lockedHost = () => {
    let running = 0, peak = 0;
    const base = fakeHost();
    return {
      ...base,
      peak: () => peak,
      cmd: async (op, args) => {
        if (op !== 'slashSkills') return base.cmd(op, args);
        if (running) throw Object.assign(new Error('スキャン中です'), { code: 'SCAN_BUSY' });
        running++; peak = Math.max(peak, running);
        try { await new Promise((resolve) => setTimeout(resolve, 5)); return await base.cmd(op, args); } finally { running--; }
      },
    };
  };
  const locked = lockedHost();
  const fsLocked = createFeedSkills({ host: locked, allBots: () => ALL, fallback: () => [owl, fox], channelCwd: () => null });
  const lockedGot = await fsLocked.load(fsLocked.key(''));
  t.ok('場所が複数でも slashSkills は順に引く（同時に走らせない）。全部の場所の候補が揃う', locked.peak() === 1 && lockedGot.map((s) => s.name).join() === 'only-fox,only-owl,review'
    && lockedGot.find((s) => s.name === 'review').botIds.length === 2, `${locked.peak()} ${lockedGot.map((s) => s.name)}`);

  let busy = 2;
  const busyHost = { cmd: async () => { if (busy-- > 0) throw Object.assign(new Error('スキャン中です'), { code: 'SCAN_BUSY' }); return [{ name: 'a' }]; } };
  t.ok('SCAN_BUSY は待って引き直す', (await scanSkills(busyHost, '/x', { waitMs: 1 })).length === 1 && busy === -1);
  let always = 0;
  const alwaysBusy = { cmd: async () => { always++; throw Object.assign(new Error('スキャン中です'), { code: 'SCAN_BUSY' }); } };
  let busyErr = null;
  try { await scanSkills(alwaysBusy, '/x', { retries: 3, waitMs: 1 }); } catch (e) { busyErr = e; }
  t.ok('SCAN_BUSY が続けば回数で諦める（最初の 1 回 + 引き直し 3 回）', busyErr?.code === 'SCAN_BUSY' && always === 4, String(always));
  let other = 0;
  const broken = { cmd: async () => { other++; throw new Error('取れない'); } };
  let otherErr = null;
  try { await scanSkills(broken, '/x', { waitMs: 1 }); } catch (e) { otherErr = e; }
  t.ok('SCAN_BUSY 以外の失敗は引き直さない', otherErr?.message === '取れない' && other === 1);
  t.ok('場所が空なら cwd を渡さない・配列でない返事は空', await (async () => { let seen; const h = { cmd: async (_op, a) => { seen = a; return null; } }; const r = await scanSkills(h, ''); return r.length === 0 && !('cwd' in seen && seen.cwd !== undefined); })());

  // --- 場所の判定が取れた後の取り直し ---
  const late = fakeHost();
  const fsLate = createFeedSkills({ host: late, allBots: () => ALL, fallback: () => [ant], channelCwd: () => '/work/shared' });
  const before = fsLate.key('');                         // モードの表が未取得: 範囲を限れる扱い → ant のフォルダー
  await fsLate.load(before);                             // 取れてから場所を決め直して引く
  const after = fsLate.key('');                          // 範囲を限れないモード → チャンネルの場所
  t.ok('モードの表が取れる前後で印が変わる（取り直す）', parsePlan(before).groups[0].cwd === '/work/ant' && parsePlan(after).groups[0].cwd === '/work/shared', `${before} → ${after}`);
  t.ok('取れた後に引いた場所は、取れた後の判定', late.calls.filter(([op]) => op === 'slashSkills').map(([, a]) => a.cwd).join() === '/work/shared');
}
