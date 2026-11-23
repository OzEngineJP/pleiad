// 一時チャットの実体（ADR 0157・docs/channels.md「一時チャット」）: home: true のチャンネルは最初に bot へ話しかけたときにでき、
// op の channelId 'home' がそれを指す。改名・アーカイブはできず、名前 home は人のチャンネルとぶつからない。宛先の bot はメンバーになる。
// 心拍・予約の「家」には選ばない。サーバーを立てずに、本物のチャンネルのサービス（一時ディレクトリ）で registry.invoke を通す。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { registry } from '../../core/ops/index.mjs';
import { ChannelError, createChannelService } from '../../core/channels/service.mjs';
import { pickHome } from '../../core/brain/pulse.mjs';

export const name = 'home-channel';
export const title = '一時チャットの実体: channelId home・最初の投稿で作る・改名とアーカイブを断る・宛先の bot はメンバー・家に選ばない';

const HUMAN = { by: 'human', via: 'ui', local: true };
const codeOf = async (fn) => { try { await fn(); return null; } catch (e) { return e instanceof ChannelError ? e.code : `other:${e.message}`; } };

export default async function (t) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'home-channel-'));
  try {
    let clock = 5000;
    const channels = createChannelService({ dir: path.join(tmp, 'channels'), now: () => (clock += 10), listBots: async () => [{ id: 'b_owl', name: 'Owl' }, { id: 'b_lynx', name: 'Lynx' }] });
    await channels.start();
    const deps = { locale: 'ja', channels, botOfSession: async () => null, modeOf: async () => ({ scope: 'workspace', autonomy: 'ask' }), audit: () => {} };
    const run = (id, args) => registry.invoke(HUMAN, id, args, deps);

    // ---- まだ無い
    t.ok('最初は一時チャットの実体が無い', (await channels.home()) === null);
    const empty = await run('channels.read', { channelId: 'home' });
    t.ok('無いうちの channels.read home は空の流れ', empty.ok && empty.result.posts.length === 0 && empty.result.nextBefore === null, JSON.stringify(empty));
    const missing = await run('channels.get', { channelId: 'home' });
    t.ok('無いうちの channels.get home は見つからない', !missing.ok && missing.code === 'CHANNEL_NOT_FOUND', JSON.stringify(missing));
    t.ok('読むだけでは作らない', (await channels.home()) === null);

    // ---- bot に話しかける（宛先のチップ）
    const first = await run('channels.post', { channelId: 'home', text: '依存を更新して', to: 'b_owl', clientId: 'home-00000001' });
    const home = await channels.home();
    t.ok('最初の投稿で home: true のチャンネルができ、投稿はそこに入る', first.ok && home?.home === true && home.kind === 'channel' && first.result.channelId === home.id, JSON.stringify(first));
    t.ok('宛先の bot はメンバーになる', home.members.includes('b_owl') && !home.members.includes('b_lynx'));
    t.ok('投稿に宛先が残る', first.result.to === 'b_owl');
    const again = await run('channels.post', { channelId: 'home', text: '依存を更新して', to: 'b_owl', clientId: 'home-00000001' });
    t.ok('同じ clientId の送り直しは同じ投稿（二重に作らない）', again.ok && again.result.id === first.result.id);
    await run('channels.post', { channelId: 'home', text: '別の話', to: 'b_lynx', clientId: 'home-00000002' });
    const after = await channels.home();
    t.ok('2 つ目は同じ実体・宛先の bot がメンバーに足される', after.id === home.id && after.members.includes('b_lynx') && (await channels.list()).filter((c) => c.home).length === 1);
    const unknownBot = await run('channels.post', { channelId: 'home', text: 'x', to: 'b_nope', clientId: 'home-00000003' });
    t.ok('知らない bot を宛先にすると断る（メンバーに足さない）', !unknownBot.ok && !(await channels.home()).members.includes('b_nope'));

    // ---- 呼び名
    const read = await run('channels.read', { channelId: 'home' });
    const got = await run('channels.get', { channelId: 'home' });
    t.ok('channels.read / get の home は実体を指す', read.ok && read.result.posts.length === 2 && got.ok && got.result.id === home.id);
    const reply = await run('channels.post', { channelId: home.id, threadId: first.result.id, text: '続き' });
    t.ok('実体の id でも書ける（スレッドの返信）', reply.ok && reply.result.threadId === first.result.id);

    // ---- 守り
    t.ok('改名は断る', await codeOf(() => channels.update({ channelId: home.id, name: 'renamed' }, { kind: 'human' })) === 'INVALID');
    t.ok('アーカイブは断る', await codeOf(() => channels.archive({ channelId: home.id, on: true }, { kind: 'human' })) === 'INVALID');
    t.ok('目的・メモは変えられる', (await channels.update({ channelId: home.id, purpose: '気軽な相談' }, { kind: 'human' })).purpose === '気軽な相談');
    const named = await run('channels.create', { name: 'home' });
    t.ok('人のチャンネルに home という名前を付けられる（一時チャットの名前とぶつからない）', named.ok && named.result.name === 'home' && !named.result.home && named.result.id !== home.id, JSON.stringify(named));
    const stillHome = await run('channels.get', { channelId: 'home' });
    t.ok('同じ名前のチャンネルができても、channelId home は一時チャットのまま', stillHome.ok && stillHome.result.id === home.id);

    // ---- 家に選ばない（心拍・予約の予算の数え先）
    const list = await channels.list();
    const owlHome = pickHome({ id: 'b_owl' }, list);
    t.ok('一時チャットは bot の家に選ばない（ほかに入っているチャンネルが無ければ家は無い）', owlHome === null, JSON.stringify(owlHome));
    t.ok('pulse.channelId に一時チャットを指していても選ばない', pickHome({ id: 'b_owl', pulse: { channelId: home.id } }, list) === null);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
  await homeSendSwitch(t);
}

// 画面の側（web/client.mjs の sendToHomeBot）: 送る中身・始めた会話・下書きの版は押した時に決める（ADR 0347 第 2 段）。
// 投稿の応答が届く前に別の会話（B）へ移っても、B の欄の字・添付・開いている会話には触れず、始めた会話（A）の下書きだけを片付ける
async function homeSendSwitch(t) {
  const source = (await fs.readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const cut = (name) => {
    let start = source.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`client.mjs に ${name} が無い`);
    if (source.slice(start - 6, start) === 'async ') start -= 6;
    return source.slice(start, source.indexOf('\n}', start) + 2);
  };
  const prompt = { value: '' };
  const errorLine = { textContent: '' };
  const state = { current: 'A', drafts: new Map(), attached: [], sessions: [{ id: 'A', unsent: true }, { id: 'B' }] };
  const posts = [], persisted = [], deleted = [], went = [], notes = [];
  let hold = null, n = 0;
  const context = vm.createContext({
    state, $: (id) => (id === 'prompt' ? prompt : errorLine), draftRevision: 'rA', randomId: () => `id${++n}`,
    homeAttempts: new Map(), homeSending: new Set(), t: (k) => k,
    orderedAttachments: () => state.attached.slice(),
    saveDraft: async () => { state.drafts.set(state.current ?? '', { text: prompt.value, attached: state.attached.slice(), revision: context.draftRevision }); },
    cmd: (command, args) => { posts.push({ command, args }); return new Promise((res, rej) => { hold = { res, rej }; }); },
    persistDraft: async (id, d) => { persisted.push({ id, ...d }); }, dropBlankDraft: () => {},
    renderAttached: () => {}, fitPrompt: () => {}, notify: (m) => notes.push(m),
    homeDest: { reset: () => {} }, viewAddress: { go: (a) => went.push(a) }, deleteSessionRow: async (row) => { deleted.push(row.id); },
  });
  vm.runInContext(`${cut('clearHomeDraft')}\n${cut('sendToHomeBot')}`, context);
  const settle = async () => { for (let k = 0; k < 5; k++) await new Promise(setImmediate); };

  prompt.value = 'A からの相談';
  state.attached = [{ path: 'C:/up/a.png', name: 'a.png', mime: 'image/png' }];
  const sending = context.sendToHomeBot({ id: 'b_owl' });
  context.sendToHomeBot({ id: 'b_owl' });   // 応答を待つ間に、もう一度押した
  t.ok('[画面] 応答を待つ間に押し直しても投稿は 1 回', posts.length === 1 && posts[0].args.args.to === 'b_owl' && posts[0].args.args.attachments?.length === 1);
  // 応答が届く前に B へ移って、B の欄に書いた
  state.current = 'B';
  prompt.value = 'B の書きかけ';
  state.attached = [{ path: 'C:/up/b.png', name: 'b.png', mime: 'image/png' }];
  context.draftRevision = 'rB';
  hold.res({ channelId: 'home-real', id: 'post-1' });
  await sending; await settle();
  t.ok('[画面] 移った先（B）の欄の字・添付・開いている会話はそのまま', prompt.value === 'B の書きかけ' && state.attached.length === 1 && state.attached[0].name === 'b.png'
    && state.current === 'B' && context.draftRevision === 'rB' && went.length === 0, JSON.stringify({ value: prompt.value, went }));
  t.ok('[画面] 始めた会話（A）の下書きだけを空にし、空の会話 A を片付ける', persisted.length === 1 && persisted[0].id === 'A' && persisted[0].text === '' && deleted.join() === 'A',
    JSON.stringify({ persisted, deleted }));

  // 失敗したら移った先の欄には出さず知らせる。送り直しは同じ clientId（二重に作らない）
  state.current = 'C'; state.sessions.push({ id: 'C' });
  prompt.value = 'C から'; state.attached = []; context.draftRevision = 'rC';
  const failing = context.sendToHomeBot({ id: 'b_owl' });
  state.current = 'B'; prompt.value = 'B の書きかけ'; context.draftRevision = 'rB';
  hold.rej(new Error('offline'));
  await failing;
  t.ok('[画面] 移った後の失敗は通知で知らせ、移った先の欄・下書きに触れない', notes.length === 1 && errorLine.textContent === '' && prompt.value === 'B の書きかけ' && persisted.length === 1);
  state.current = 'C'; prompt.value = 'C から'; context.draftRevision = 'rC';
  const retry = context.sendToHomeBot({ id: 'b_owl' });
  hold.res({ channelId: 'home-real', id: 'post-2' });
  await retry; await settle();
  t.ok('[画面] 同じ中身の送り直しは同じ clientId', posts.at(-1).args.args.clientId === posts.at(-2).args.args.clientId && went.length === 1);
}
