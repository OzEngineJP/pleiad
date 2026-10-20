// 仮想のキー「Pleiad Plus」の音声通話（core/voice/ + core/api-keys.mjs の useEndpoint('voice')）。
// 偽の Plus（tests/lib/fake-plus.mjs）の中継の口へ ID トークンを付けて送り、書き起こし・読み上げ・誤りの code ごとの振る舞いを確かめる。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVoiceSession } from '../../core/voice/session.mjs';
import { createSttClient } from '../../core/voice/stt.mjs';
import { createTtsClient } from '../../core/voice/tts.mjs';
import { normalizeVoiceSettings } from '../../core/voice/settings.mjs';
import { createApiKeys } from '../../core/api-keys.mjs';
import { createSecretStore, plainCipher } from '../../core/secret-store.mjs';
import { startFakePlus } from '../lib/fake-plus.mjs';
import { toneFrame } from '../lib/fake-openrouter.mjs';

export const name = 'voice-plus';
export const title = '仮想のキー Pleiad Plus の通話: 書き起こし・読み上げに ID トークン・トークンの更新で切らない・credit_exhausted・rate_limited';

const STT_PATH = '/v1/proxy/voice/audio/transcriptions';
const TTS_PATH = '/v1/proxy/voice/audio/speech';
const PHRASES = { code: 'x', table: 'x', log: 'x' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(10); } return fn(); }

const pcm = (n = 4800) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i += 2) b.writeInt16LE(8000, i); return b; };

export default async function (t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ply-voice-plus-'));
  const plus = await startFakePlus();
  const secrets = createSecretStore({ file: path.join(root, 'api-key-secrets.json'), cipher: plainCipher });
  let seq = 0;
  // Pleiad Plus のセッションの身代わり。ID トークンは呼ぶたびに新しい JWT（jti が連番）。中継が credit_exhausted を返した直後のように、枠を使い切った表示にしておく
  const snap = { signedIn: true, available: true, state: 'on', uid: 'u-1', account: { status: 'plus', usage: { credits: 100 }, limits: { creditsPerMonth: 100 } } };
  const session = {
    snapshot: () => snap,
    getIdToken: async ({ force } = {}) => plus.issueIdToken('u-1', { jti: `tok-${++seq}${force ? 'f' : ''}` }),
    status: async () => ({}),
  };
  const apiKeys = createApiKeys({ dataDir: root, secrets, plus: { apiBase: () => plus.url, session: () => session } });
  await apiKeys.init();
  await apiKeys.setUse('voice', 'plus');
  const configOf = (ep) => ({ baseUrl: ep.baseUrl, kind: ep.kind, authorization: ep.authorization,
    creditBlocked: ep.creditBlocked, credit: ep.credit, noteCredit: ep.noteCredit, refreshAccount: ep.refreshAccount });

  /** 実の聞き取り・読み上げの口を持つ通話（送り先は apiKeys.useEndpoint('voice') の中継） */
  const start = async ({ settings = {} } = {}) => {
    const sent = [], binary = [];
    let closed = 0;
    const ep = await apiKeys.useEndpoint('voice');
    const config = configOf(ep);
    const usage = { add: async () => {}, flush: async () => {}, today: async () => ({ callSeconds: 0, sttSeconds: 0, ttsChars: 0 }) };
    const sess = createVoiceSession({
      send: (o) => sent.push(o), sendBinary: (b) => binary.push(b), close: () => { closed++; }, log: () => {},
      clients: {
        stt: createSttClient({ config, model: 'stt/main', fallbackModel: settings.sttFallbackModel === '' ? '' : (settings.sttFallbackModel ?? 'stt/fallback') }),
        tts: createTtsClient({ config, model: 'tts/m', voice: 'eve' }),
      },
      hello: async () => {
        const e = await apiKeys.useEndpoint('voice');
        const exhausted = e?.creditBlocked?.() === true;
        return { settings: normalizeVoiceSettings(settings), config: exhausted ? null : (e ? configOf(e) : null),
          ...(exhausted ? { startError: { code: 'credit_exhausted', resetAt: e.credit?.().resetAt ?? null } } : {}),
          uiLang: 'ja', phrases: PHRASES, usage, todayCallSeconds: 0 };
      },
    });
    const frames = (voiced, n) => { for (let i = 0; i < n; i++) sess.onMessage(toneFrame(voiced), true); };
    const hello = () => sess.onMessage(JSON.stringify({ t: 'hello', target: { kind: 'chat', sessionId: 's1' } }), false);
    const msg = (type, extra = {}) => sess.onMessage(JSON.stringify({ t: type, ...extra }), false);
    const callsTo = (p) => plus.state.calls.filter((c) => c.path === p);
    return { sent, binary, hello, msg, frames, callsTo, get closed() { return closed; }, ep, session: sess };
  };

  try {
    // ---- 書き起こし・読み上げが ID トークン付きで中継の口に届く・トークンの更新で切れない
    {
      plus.state.proxy[STT_PATH] = { status: 200, body: { text: 'こんにちは' } };
      plus.state.proxy[TTS_PATH] = { status: 200, body: pcm(), headers: { 'content-type': 'audio/pcm;rate=24000;channels=1' } };
      const h = await start();
      await h.hello();
      t.ok('ready が返る', h.sent[0]?.t === 'ready');
      h.frames(true, 8); h.frames(false, 8);
      t.ok('書き起こしが /v1/proxy/voice/audio/transcriptions に ID トークン付きで届き、確定が返る',
        await waitFor(() => h.sent.some((m) => m.t === 'final' && m.text === 'こんにちは')) && h.callsTo(STT_PATH).length >= 1 && /^Bearer .+\..+\..+$/.test(h.callsTo(STT_PATH)[0].auth ?? ''));
      h.session.onAgentEvent({ type: 'text.delta', text: 'おつかれさまです' }); h.session.onAgentEvent({ type: 'text.end' });
      t.ok('読み上げが /v1/proxy/voice/audio/speech に届き、PCM が流れる', await waitFor(() => h.callsTo(TTS_PATH).length === 1 && h.binary.length > 0));
      const auths = [...h.callsTo(STT_PATH), ...h.callsTo(TTS_PATH)].map((c) => c.auth);
      t.ok('ID トークンは覚えない（送るたびに新しい値）', new Set(auths).size === auths.length && auths.every((a) => a.startsWith('Bearer ')));
      h.frames(true, 8); h.frames(false, 8);
      t.ok('ID トークンが替わっても通話は切れない（次の発話も届く）', await waitFor(() => h.sent.filter((m) => m.t === 'final').length === 2) && h.closed === 0);
      h.session.close();
    }

    // ---- credit_exhausted: 途中なら通話を終える・やり直さない・予備のモデルに送らない
    {
      const resetAt = new Date(Date.now() + 86400_000).toISOString();
      let sttHits = 0;
      plus.state.proxy[STT_PATH] = () => (++sttHits === 1 ? { status: 200, body: { text: '一' } } : { status: 429, body: { error: { code: 'credit_exhausted', message: 'x', resetAt } } });
      const h = await start();
      await h.hello();
      h.frames(true, 8); h.frames(false, 8);
      await waitFor(() => h.sent.some((m) => m.t === 'final'));
      h.frames(true, 8); h.frames(false, 8);
      t.ok('途中の 429 credit_exhausted: {t:error, code, resetAt, fatal} で通話を終える',
        await waitFor(() => h.sent.some((m) => m.t === 'error' && m.code === 'credit_exhausted' && m.resetAt === resetAt && m.fatal === true)) && h.closed === 1);
      const hits = sttHits;
      await sleep(400);
      t.ok('やり直さない・予備のモデルへも送らない（誤りは 1 回で確定）', sttHits === hits && hits === 2);

      // resetAt を覚えている間は始めない（上流へ送らずに断る）
      const before = h.callsTo(STT_PATH).length;
      const h2 = await start();
      await h2.hello();
      t.ok('credit_exhausted を覚えている間は始めない（fatal で閉じる・上流へ送らない）',
        h2.sent[0]?.t === 'error' && h2.sent[0].code === 'credit_exhausted' && h2.sent[0].fatal === true && h2.closed === 1 && h2.callsTo(STT_PATH).length === before);
      h2.session.close();
      // アカウントの読み直しが上限未満を示した → 覚えた resetAt は解ける
      snap.account = { status: 'plus', usage: { credits: 1 }, limits: { creditsPerMonth: 100 } };
    }

    // ---- rate_limited は今の 429 と同じ（やり直す）
    {
      let sttHits = 0;
      plus.state.proxy[STT_PATH] = () => (++sttHits === 1 ? { status: 429, body: { error: { code: 'rate_limited', message: 'x' } }, headers: { 'retry-after': '0' } } : { status: 200, body: { text: 'おはよう' } });
      const h = await start({ settings: { sttFallbackModel: '' } });
      await h.hello();
      h.frames(true, 8); h.frames(false, 8);
      t.ok('429 rate_limited: 今の 429 と同じにやり直して確定が返る', await waitFor(() => h.sent.some((m) => m.t === 'final' && m.text === 'おはよう')) && sttHits >= 2);
      h.session.close();
    }

    // ---- not_plus は通話を終える
    {
      plus.state.proxy[STT_PATH] = { status: 403, body: { error: { code: 'not_plus', message: 'x' } } };
      const h = await start();
      await h.hello();
      h.frames(true, 8); h.frames(false, 8);
      t.ok('403 not_plus: 通話を終える（code がそのまま届く）', await waitFor(() => h.sent.some((m) => m.t === 'error' && m.code === 'not_plus' && m.fatal === true)));
      h.session.close();
    }
  } finally {
    await plus.close();
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}
