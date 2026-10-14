// 自動更新のインストーラーの確かめ（desktop/update-signature.cjs。ADR 0207。ADR 0176 を改める）。
//   - 中身: ファイルの sha512 が latest.yml の値と違う・分からない・読めないなら、署名を見る前に不合格
//   - 無署名（TRUST_E_NOSIGNATURE）: 方針の unsigned が accept なら合格、reject なら不合格
//   - 自己署名（CERT_E_UNTRUSTEDROOT）: 状態データから読んだ署名者の SHA-1 指紋が signers にあるときだけ合格。開いた状態データは必ず CLOSE する
//   - Windows が信頼する署名（S_OK）: 指紋が signers にあるか、発行元が publishers（+ app-update.yml の publisherName）に合えば合格
//   - それ以外（TRUST_E_BAD_DIGEST = 署名の後の改ざんなど）は、無署名を受け入れる方針でも不合格
//   - 方針（update-trust.json）の形・同梱、electron-updater の差し込み口、リリースのビルドの検査（scripts/release-signing.cjs）、
//     無署名を出す前の確かめ（scripts/release-unsigned-guard.mjs）
//   - 本物（Windows）: 本物の koffi で WinVerifyTrust を呼べる（実ファイルの確かめは scripts/verify-update-signature.ps1）
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { compareTags, releasesToCheck, unsignedBlockers } from '../../scripts/release-unsigned-guard.mjs';

const require = createRequire(import.meta.url);
const sig = require('../../desktop/update-signature.cjs');
const { releaseSigning, SIGNING_ENV } = require('../../scripts/release-signing.cjs');

export const name = 'desktop-update-signature';
export const title = '自動更新のインストーラーの確かめ（latest.yml の sha512 + 方針で無署名・固定した自己署名・認めた発行元）';

const UNTRUSTED_ROOT = 0x800B0109, BAD_DIGEST = 0x80096010, NO_SIGNATURE = 0x800B0100;
const sha1 = bytes => crypto.createHash('sha1').update(bytes).digest('hex').toUpperCase();
const DER = Buffer.from('fake certificate der bytes');
const DER_SHA1 = sha1(DER);
const OTHER_SHA1 = 'A'.repeat(40);
const SHA = 'c2hhNTEyIG9mIHRoZSBpbnN0YWxsZXI=';

/** koffi の身代わり。WinVerifyTrust の結果・署名者の証明書・どこで失敗させるかを決め、呼び出しを記録する */
function fakeKoffi({ hresult = UNTRUSTED_ROOT, der = DER, state = 'STATE', failAt = null } = {}) {
  const calls = [];
  const fail = at => { if (failAt === at) throw new Error(`${at} exploded`); };
  const koffi = {
    calls,
    struct: structName => ({ structName }),
    sizeof: () => 88,
    load: () => ({
      func: signature => {
        if (signature.includes('WinVerifyTrust')) return (hwnd, action, data) => {
          calls.push({ call: 'WinVerifyTrust', hwnd, action: { ...action }, ui: data.dwUIChoice, revoke: data.fdwRevocationChecks, union: data.dwUnionChoice, stateAction: data.dwStateAction, file: data.pFile.pcwszFilePath, state: data.hWVTStateData });
          fail(data.dwStateAction === 1 ? 'verify' : 'close');
          if (data.dwStateAction === 1) { data.hWVTStateData = state; return hresult | 0; }   // LONG は符号付きで返る
          return 0;
        };
        if (signature.includes('WTHelperProvDataFromStateData')) return handle => { calls.push({ call: 'provider', handle }); fail('provider'); return 'PROV'; };
        if (signature.includes('WTHelperGetProvSignerFromChain')) return (provider, signer, counter, index) => { calls.push({ call: 'signer', provider, signer, counter, index }); fail('signer'); return 'SGNR'; };
        return () => 0;
      },
    }),
    decode: (pointer, type, length) => {
      calls.push({ call: 'decode', pointer, type: type?.structName ?? type });
      if (type?.structName === 'PleiadWtProvSgnr') return { csCertChain: 1, pasCertChain: 'CHAIN' };
      if (type?.structName === 'PleiadWtProvCert') return { pCert: 'CERT' };
      if (type?.structName === 'PleiadWtCertContext') return { pbCertEncoded: 'DER', cbCertEncoded: der.length };
      if (type === 'uint8_t' && pointer === 'DER' && length === der.length) return [...der];
      throw new Error('unexpected decode');
    },
  };
  return koffi;
}

const quiet = () => { const lines = []; return { lines, info: m => lines.push(`info ${m}`), warn: m => lines.push(`warn ${m}`), error: m => lines.push(`error ${m}`) }; };
const policy = (extra = {}) => ({ unsigned: true, publishers: [], signers: [DER_SHA1], ...extra });
const throws = fn => { try { fn(); return null; } catch (error) { return error.message; } };

export default async function (t) {
  // 発行元の確かめ（electron-updater の既定）の身代わり。names に 'Trusted Publisher' があれば合格
  const defaultVerify = async names => (names.includes('Trusted Publisher') ? null : `publisherNames: ${names.join(', ')}, raw info: {"Status": 0}`);
  const make = (koffi, extra = {}) => sig.createUpdateVerifier({ defaultVerify, koffi, trust: policy(), logger: quiet(), hashFile: async () => SHA, ...extra });
  const closes = koffi => koffi.calls.filter(c => c.call === 'WinVerifyTrust' && c.stateAction === 2).length;
  const verifies = koffi => koffi.calls.filter(c => c.call === 'WinVerifyTrust').length;

  // ---- 中身（latest.yml の sha512）: 署名より先に確かめる
  {
    const koffi = fakeKoffi({ hresult: NO_SIGNATURE });
    const mismatch = await make(koffi, { hashFile: async () => 'b3RoZXI=' })('C:\\u.exe', { sha512: SHA });
    t.ok('中身: sha512 が latest.yml と違えば不合格（無署名を受け入れる方針でも）。理由に両方の値', typeof mismatch === 'string' && mismatch.includes('sha512 mismatch') && mismatch.includes('b3RoZXI=') && mismatch.includes(SHA), String(mismatch));
    t.ok('中身: sha512 が違えば WinVerifyTrust を呼ばない', verifies(koffi) === 0);
    const unknown = await make(fakeKoffi({ hresult: NO_SIGNATURE }))('C:\\u.exe', {});
    t.ok('中身: latest.yml の sha512 が分からなければ不合格', typeof unknown === 'string' && unknown.includes('sha512 of the update is unknown'), String(unknown));
    const unreadable = await make(fakeKoffi({ hresult: NO_SIGNATURE }), { hashFile: async () => { throw new Error('EBUSY: locked'); } })('C:\\u.exe', { sha512: SHA });
    t.ok('中身: ファイルを読めなければ不合格', typeof unreadable === 'string' && unreadable.includes('could not be read') && unreadable.includes('EBUSY'), String(unreadable));
    const file = path.join(os.tmpdir(), `ply-update-sha-${process.pid}.bin`);
    fs.writeFileSync(file, 'installer bytes');
    try {
      t.ok('中身: fileSha512 は latest.yml と同じ base64 の sha512', await sig.fileSha512(file) === crypto.createHash('sha512').update('installer bytes').digest('base64'));
    } finally { fs.rmSync(file, { force: true }); }
    let rejected = false;
    try { await sig.fileSha512(file); } catch { rejected = true; }
    t.ok('中身: fileSha512 は無いファイルで例外', rejected);
  }

  // ---- 無署名
  {
    const koffi = fakeKoffi({ hresult: NO_SIGNATURE });
    const log = quiet();
    const accepted = await make(koffi, { logger: log })('C:\\u.exe', { sha512: SHA });
    t.ok('無署名: 方針が受け入れるなら合格', accepted === null, String(accepted));
    t.ok('無署名: 合格は updater.log に残る', log.lines.some(l => l.startsWith('info') && l.includes('unsigned')));
    t.ok('無署名: 署名者は読まず、CLOSE は呼ぶ', !koffi.calls.some(c => c.call === 'provider') && closes(koffi) === 1);
    const refused = await make(fakeKoffi({ hresult: NO_SIGNATURE }), { trust: policy({ unsigned: false }) })('C:\\u.exe', { sha512: SHA });
    t.ok('無署名: 方針が reject なら不合格（理由に HRESULT）', typeof refused === 'string' && refused.includes('0x800B0100 TRUST_E_NOSIGNATURE') && refused.includes('not accepted'), String(refused));
  }

  // ---- 自己署名（信頼されないルート）
  {
    const koffi = fakeKoffi();
    const log = quiet();
    const result = await make(koffi, { logger: log })('C:\\u.exe', { sha512: SHA });
    t.ok('自己署名: 指紋が signers にあれば合格', result === null, String(result));
    const verifyCall = koffi.calls.find(c => c.call === 'WinVerifyTrust');
    t.ok('自己署名: WINTRUST_ACTION_GENERIC_VERIFY_V2・UI なし・失効確認なし・ファイル・VERIFY で呼ぶ',
      verifyCall.action.Data1 === 0x00AAC56B && verifyCall.action.Data2 === 0xCD44 && verifyCall.action.Data3 === 0x11D0 && verifyCall.action.Data4.join() === '140,194,0,192,79,194,149,238'
      && verifyCall.ui === 2 && verifyCall.revoke === 0 && verifyCall.union === 1 && verifyCall.stateAction === 1 && verifyCall.file === 'C:\\u.exe' && verifyCall.hwnd === -1);
    const order = koffi.calls.map(c => c.call);
    t.ok('自己署名: 署名者は同じ状態データ（VERIFY が返したもの）から読み、その後に CLOSE を同じ状態データで呼ぶ',
      order.join() === 'WinVerifyTrust,provider,signer,decode,decode,decode,decode,WinVerifyTrust' && koffi.calls[1].handle === 'STATE' && koffi.calls[2].provider === 'PROV' && koffi.calls[2].signer === 0 && koffi.calls[2].counter === 0
      && koffi.calls.at(-1).stateAction === 2 && koffi.calls.at(-1).state === 'STATE');
    t.ok('自己署名: 合格は updater.log に残る（指紋つき）', log.lines.some(l => l.startsWith('info') && l.includes(DER_SHA1)));
    t.ok('自己署名: 指紋は大文字小文字・コロンを問わず方針と突き合わせる（loadTrust が揃える）', sig.normalizeThumbprint(DER_SHA1.toLowerCase().replace(/(..)/g, '$1:').slice(0, -1)) === DER_SHA1);

    const other = fakeKoffi();
    const reason = await make(other, { trust: policy({ signers: [OTHER_SHA1] }) })('C:\\u.exe', { sha512: SHA });
    t.ok('自己署名: 指紋が signers に無ければ不合格（無署名を受け入れる方針でも）。理由に HRESULT と見つけた指紋', typeof reason === 'string' && reason.includes('0x800B0109 CERT_E_UNTRUSTEDROOT') && reason.includes(DER_SHA1) && reason.includes('not an accepted update signer'), String(reason));
    t.ok('自己署名: 不合格でも CLOSE を呼ぶ', closes(other) === 1);
    const listedPublisher = await make(fakeKoffi(), { trust: policy({ signers: [OTHER_SHA1], publishers: ['Trusted Publisher'] }) })('C:\\u.exe', { sha512: SHA });
    t.ok('自己署名: 発行元の一覧は自己署名を通さない（Windows が信頼しない署名は指紋だけ）', typeof listedPublisher === 'string' && listedPublisher.includes('CERT_E_UNTRUSTEDROOT'), String(listedPublisher));

    const noState = fakeKoffi({ state: null });
    const noStateReason = await make(noState)('x', { sha512: SHA });
    t.ok('自己署名: 状態データが無ければ不合格（読み直さない）', typeof noStateReason === 'string' && noStateReason.includes('no state data') && !noState.calls.some(c => c.call === 'provider'));
    t.ok('自己署名: 証明書が空なら不合格', typeof await make(fakeKoffi({ der: Buffer.alloc(0) }))('x', { sha512: SHA }) === 'string');
  }

  // ---- Windows が信頼する署名（S_OK）
  {
    const koffi = fakeKoffi({ hresult: 0 });
    let asked = false;
    const pinned = await make(koffi, { defaultVerify: async () => { asked = true; return 'should not be asked'; } })('C:\\u.exe', { sha512: SHA });
    t.ok('信頼する署名: 指紋が signers にあれば合格（発行元は比べない）', pinned === null && !asked, String(pinned));
    t.ok('信頼する署名: S_OK でも署名者を読み、CLOSE は呼ぶ', koffi.calls.some(c => c.call === 'signer') && closes(koffi) === 1);
    const unlisted = await make(fakeKoffi({ hresult: 0 }), { trust: policy({ signers: [] }) })('C:\\u.exe', { sha512: SHA });
    t.ok('信頼する署名: 発行元が一覧に無ければ不合格（無署名を受け入れる方針でも、知らない発行元は通さない）', typeof unlisted === 'string' && unlisted.includes('0x00000000 S_OK') && unlisted.includes('not an accepted publisher') && unlisted.includes(DER_SHA1), String(unlisted));
    t.ok('信頼する署名: 発行元が一覧にあれば合格', await make(fakeKoffi({ hresult: 0 }), { trust: policy({ signers: [], publishers: ['Trusted Publisher'] }) })('C:\\u.exe', { sha512: SHA }) === null);
    t.ok('信頼する署名: 入っている app-update.yml の publisherName も発行元として足す', await make(fakeKoffi({ hresult: 0 }), { trust: policy({ signers: [] }) })('C:\\u.exe', { sha512: SHA, publisherNames: ['Trusted Publisher'] }) === null);
    const throwsDefault = await make(fakeKoffi({ hresult: 0 }), { trust: policy({ signers: [], publishers: ['Trusted Publisher'] }), defaultVerify: async () => { throw new Error('powershell is gone'); } })('x', { sha512: SHA });
    t.ok('信頼する署名: 発行元の確かめが例外なら不合格（理由に残る）', typeof throwsDefault === 'string' && throwsDefault.includes('powershell is gone'), String(throwsDefault));
  }

  // ---- そのほかの結果は不合格
  for (const [label, hresult, expected] of [['TRUST_E_BAD_DIGEST（署名の後の改ざん）', BAD_DIGEST, '0x80096010 TRUST_E_BAD_DIGEST'], ['TRUST_E_SUBJECT_FORM_UNKNOWN', 0x800B0003, '0x800B0003 TRUST_E_SUBJECT_FORM_UNKNOWN'], ['知らない HRESULT', 0x800B010A, '0x800B010A CERT_E_CHAINING']]) {
    const fake = fakeKoffi({ hresult });
    const result = await make(fake, { trust: policy({ publishers: ['Trusted Publisher'] }) })('C:\\u.exe', { sha512: SHA });
    t.ok(`ほか: ${label} は不合格（無署名を受け入れ、指紋も発行元もある方針でも）`, typeof result === 'string' && result.includes(expected), String(result));
    t.ok(`ほか: ${label} では署名者を読まず、CLOSE は呼ぶ`, !fake.calls.some(c => c.call === 'provider' || c.call === 'signer') && closes(fake) === 1);
  }

  // ---- 失敗は更新全体を壊さず、閉じる側に倒す
  {
    for (const failAt of ['provider', 'signer']) {
      const koffi = fakeKoffi({ failAt });
      const result = await make(koffi)('x', { sha512: SHA });
      t.ok(`失敗: 状態データを読む途中（${failAt}）の例外は不合格の理由になり、CLOSE は呼ぶ`, typeof result === 'string' && result.includes(`${failAt} exploded`) && closes(koffi) === 1, String(result));
    }
    const verifyFails = fakeKoffi({ failAt: 'verify' });
    const verifyReason = await make(verifyFails)('x', { sha512: SHA });
    t.ok('失敗: WinVerifyTrust を呼べなければ、無署名を受け入れる方針でも不合格（無署名かどうか分からない）', typeof verifyReason === 'string' && verifyReason.includes('could not be called') && verifyReason.includes('verify exploded'), String(verifyReason));
    t.ok('失敗: VERIFY が例外なら状態データは開かれていないので CLOSE しない', closes(verifyFails) === 0);
    const noKoffi = await make(null, { loadKoffi: () => { throw new Error('koffi is missing'); } })('x', { sha512: SHA });
    t.ok('失敗: koffi を読めなければ不合格の理由', typeof noKoffi === 'string' && noKoffi.includes('koffi is missing'));
    const publisherOnly = await make(null, { loadKoffi: () => { throw new Error('koffi is missing'); }, trust: policy({ publishers: ['Trusted Publisher'] }) })('x', { sha512: SHA });
    t.ok('失敗: koffi を読めなくても、発行元の合う署名（既定の確かめ）なら合格', publisherOnly === null, String(publisherOnly));
    const bundled = await sig.createUpdateVerifier({ defaultVerify, koffi: fakeKoffi({ hresult: NO_SIGNATURE }), hashFile: async () => SHA })('x', { sha512: SHA });
    t.ok('既定: 方針を渡さなければ同梱の update-trust.json で確かめる', bundled === null, String(bundled));
  }

  // ---- 方針（update-trust.json）
  {
    const trust = sig.loadTrust();
    t.ok('方針: 同梱の方針は無署名を受け入れ、今の評価版の自己署名の指紋も残す（橋渡しの版から無署名へ移る間）', trust.unsigned === true && trust.signers.includes('BCEE9BE88BEE6BB94909FC74C0622420CAE50910') && trust.signers.every(s => /^[0-9A-F]{40}$/.test(s)) && Array.isArray(trust.publishers));
    t.ok('方針: loadSigners は方針の signers', JSON.stringify(sig.loadSigners()) === JSON.stringify(trust.signers));
    const raw = JSON.parse(fs.readFileSync(sig.TRUST_FILE, 'utf8'));
    t.ok('方針: 方針を狭める順序（今の方針で通る形で先に配る）をファイルに書いている', raw.note.includes('先に配る'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ply-trust-'));
    const load = data => { const file = path.join(dir, 'trust.json'); fs.writeFileSync(file, JSON.stringify(data)); return throws(() => sig.loadTrust(file)) ?? sig.loadTrust(file); };
    try {
      const loaded = load({ unsigned: 'reject', publishers: [' Example '], signers: [{ sha1: DER_SHA1.toLowerCase() }, { sha1: DER_SHA1 }] });
      t.ok('方針: 発行元の空白を落とし、指紋は大文字にして重複を除く', loaded.unsigned === false && loaded.publishers[0] === 'Example' && JSON.stringify(loaded.signers) === JSON.stringify([DER_SHA1]));
      t.ok('方針: unsigned が accept / reject 以外なら例外', typeof load({ unsigned: true, publishers: [], signers: [] }) === 'string');
      t.ok('方針: publishers が名前の並びでなければ例外', typeof load({ unsigned: 'accept', publishers: [''], signers: [] }) === 'string' && typeof load({ unsigned: 'accept', signers: [] }) === 'string');
      t.ok('方針: 形の違う指紋は例外', typeof load({ unsigned: 'accept', publishers: [], signers: [{ sha1: '12345' }] }) === 'string');
      t.ok('方針: 何も受け入れない方針は例外（更新が二度と届かなくなる）', String(load({ unsigned: 'reject', publishers: [], signers: [] })).includes('accepts no update'));
      fs.writeFileSync(path.join(dir, 'trust.json'), '{ broken');
      t.ok('方針: 読めない方針は例外（確かめは不合格になる）', typeof throws(() => sig.loadTrust(path.join(dir, 'trust.json'))) === 'string');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    const config = parse(fs.readFileSync(new URL('../../electron-builder.yml', import.meta.url), 'utf8'));
    t.ok('方針: アプリに同梱される（files の desktop/** に入り、除外されない）', config.files.includes('desktop/**') && !config.files.some(f => typeof f === 'string' && f.startsWith('!') && /update-(trust|sign)/.test(f)));
    t.ok('方針: 40 桁でない指紋は例外', typeof throws(() => sig.normalizeThumbprint('12345')) === 'string');
  }

  // ---- electron-updater への差し込み
  {
    const nsisSource = fs.readFileSync(require.resolve('electron-updater/out/NsisUpdater.js'), 'utf8');
    const { NsisUpdater } = require('electron-updater/out/NsisUpdater');
    t.ok('差し込み口: NsisUpdater は verifySignature を持ち、ダウンロードの後に this.verifySignature を呼ぶ（版を上げたら確かめる）',
      typeof NsisUpdater.prototype.verifySignature === 'function' && 'verifyUpdateCodeSignature' in NsisUpdater.prototype && nsisSource.includes('await this.verifySignature(destinationFile)'));
    t.ok('差し込み口: ダウンロードした exe は latest.yml と同じ選び方（findFile の exe）', nsisSource.includes('findFile)(provider.resolveFiles(downloadUpdateOptions.updateInfoAndProvider.info), "exe")'));
    // electron-updater も取る途中で sha512 を確かめる（無署名で残る中身の守り。sha512 の違いは ERR_CHECKSUM_MISMATCH）
    const { DigestTransform } = require('builder-util-runtime');
    const good = crypto.createHash('sha512').update('installer').digest('base64');
    const sink = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
    const ok = await pipeline(Readable.from([Buffer.from('installer')]), new DigestTransform(good), sink()).then(() => null, error => error.code);
    const bad = await pipeline(Readable.from([Buffer.from('tampered!')]), new DigestTransform(good), sink()).then(() => null, error => error.code);
    t.ok('差し込み口: electron-updater の DigestTransform は sha512 の違いで止まる', ok === null && bad === 'ERR_CHECKSUM_MISMATCH', `${ok} / ${bad}`);

    class Win {
      verifyUpdateCodeSignature = null;
      logger = quiet();
      configOnDisk = { value: Promise.resolve({ publisherName: 'Trusted Publisher' }) };
      async verifySignature() { return 'original'; }
    }
    const win = new Win();
    const installed = sig.installUpdateSignatureVerifier(win, { platform: 'win32', defaultVerify, koffi: fakeKoffi({ hresult: 0 }), trust: policy({ signers: [] }), hashFile: async () => SHA, sha512Of: () => SHA });
    t.ok('差し込み: Windows の NsisUpdater の verifySignature を差し替え、app-update.yml の publisherName を発行元に足す', installed === true && await win.verifySignature('x') === null);
    const noPublisher = new Win();
    noPublisher.configOnDisk = { value: Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) };
    sig.installUpdateSignatureVerifier(noPublisher, { platform: 'win32', defaultVerify, koffi: fakeKoffi({ hresult: NO_SIGNATURE }), trust: policy(), hashFile: async () => SHA, sha512Of: () => SHA });
    t.ok('差し込み: app-update.yml に publisherName が無くても（無署名の版）確かめる', await noPublisher.verifySignature('x') === null);
    const wrongSha = new Win();
    sig.installUpdateSignatureVerifier(wrongSha, { platform: 'win32', defaultVerify, koffi: fakeKoffi({ hresult: NO_SIGNATURE }), trust: policy(), hashFile: async () => SHA, sha512Of: () => 'b3RoZXI=' });
    t.ok('差し込み: latest.yml の sha512 と違えば不合格', String(await wrongSha.verifySignature('x')).includes('sha512 mismatch'));
    const shaThrows = new Win();
    sig.installUpdateSignatureVerifier(shaThrows, { platform: 'win32', defaultVerify, koffi: fakeKoffi({ hresult: NO_SIGNATURE }), trust: policy(), hashFile: async () => SHA, sha512Of: () => { throw new Error('no provider'); } });
    t.ok('差し込み: sha512 を取れなければ不合格', String(await shaThrows.verifySignature('x')).includes('unknown'));
    t.ok('差し込み: Windows 以外は何もしない', sig.installUpdateSignatureVerifier(new Win(), { platform: 'darwin' }) === false);
    t.ok('差し込み: 確かめを持たない updater（macOS の MacUpdater など）には何もしない', sig.installUpdateSignatureVerifier({ verifyUpdateCodeSignature: null }, { platform: 'win32' }) === false);

    const files = [
      { url: new URL('https://example.com/Ply-Setup-arm64.exe'), info: { url: 'Ply-Setup-arm64.exe', sha512: 'ARM' } },
      { url: new URL('https://example.com/Ply-Setup-x64.exe'), info: { url: 'Ply-Setup-x64.exe', sha512: 'X64' } },
      { url: new URL('https://example.com/Ply-Setup-x64.exe.blockmap'), info: { url: 'Ply-Setup-x64.exe.blockmap', sha512: 'MAP' } },
    ];
    const expected = sig.expectedSha512({ updateInfoAndProvider: { info: { version: '1.0.0' }, provider: { resolveFiles: () => files } } });
    t.ok('sha512: latest.yml の、この CPU の exe の sha512 を使う', expected === (process.arch === 'arm64' ? 'ARM' : process.arch === 'x64' ? 'X64' : 'ARM'), String(expected));
    t.ok('sha512: 更新の情報が無ければ null', sig.expectedSha512({}) === null);
  }

  // ---- リリースのビルド（scripts/release-signing.cjs）
  {
    const publisher = { PLY_WIN_PUBLISHER: 'Example Publisher' };
    const listed = 'bcee9be88bee6bb94909fc74c0622420cae50910';
    const unsigned = releaseSigning({ PLY_WINDOWS_SIGNING: 'none' }, 'win32', { trust: policy() });
    t.ok('ビルド: none は署名しない（Windows だけ forceCodeSigning を外し、app-update.yml に publisherName を書かない）', JSON.stringify(unsigned) === JSON.stringify({ win: { forceCodeSigning: false, signExecutable: false, verifyUpdateCodeSignature: false } }));
    t.ok('ビルド: none は発行元の名前を要らない', unsigned.win.signtoolOptions === undefined);
    for (const name of SIGNING_ENV) {
      const message = throws(() => releaseSigning({ PLY_WINDOWS_SIGNING: 'none', [name]: 'secret-value' }, 'win32', { trust: policy() }));
      t.ok(`ビルド: none に署名の設定（${name}）を渡すと止める（中身は出さない）`, typeof message === 'string' && message.includes(name) && !message.includes('secret-value'), String(message));
    }
    const refuses = throws(() => releaseSigning({ PLY_WINDOWS_SIGNING: 'none' }, 'win32', { trust: policy({ unsigned: false }) }));
    t.ok('ビルド: 方針が無署名を受け入れないなら none は止める（次の無署名の更新を受けられない版を出さない）', typeof refuses === 'string' && refuses.includes('does not accept unsigned'), String(refuses));
    t.ok('ビルド: none は同梱の方針で確かめる', releaseSigning({ PLY_WINDOWS_SIGNING: 'none' }, 'win32').win.signExecutable === false);

    t.ok('ビルド: store の証明書の指紋が方針にあれば通る', releaseSigning({ ...publisher, PLY_WINDOWS_SIGNING: 'store', PLY_WIN_CERTIFICATE_SHA1: listed }, 'win32').win.signtoolOptions.certificateSha1 === listed);
    const store = throws(() => releaseSigning({ ...publisher, PLY_WINDOWS_SIGNING: 'store', PLY_WIN_CERTIFICATE_SHA1: OTHER_SHA1 }, 'win32'));
    t.ok('ビルド: store の証明書の指紋が方針に無ければ止める', typeof store === 'string' && store.includes('update-trust.json') && store.includes(OTHER_SHA1));
    t.ok('ビルド: テストの一覧を渡せる', releaseSigning({ ...publisher, PLY_WINDOWS_SIGNING: 'store', PLY_WIN_CERTIFICATE_SHA1: OTHER_SHA1 }, 'win32', { signers: [OTHER_SHA1] }).win.signtoolOptions.certificateSha1 === OTHER_SHA1);
    const pfx = { ...publisher, CSC_LINK: 'key', CSC_KEY_PASSWORD: 'password' };
    t.ok('ビルド: pfx は指紋を渡したときだけ検査する', typeof throws(() => releaseSigning({ ...pfx, PLY_WIN_CERTIFICATE_SHA1: OTHER_SHA1 }, 'win32')) === 'string' && releaseSigning(pfx, 'win32').win.verifyUpdateCodeSignature === true && releaseSigning({ ...pfx, PLY_WIN_CERTIFICATE_SHA1: listed }, 'win32').win.verifyUpdateCodeSignature === true);
    const azure = { ...publisher, PLY_WINDOWS_SIGNING: 'azure', PLY_AZURE_ENDPOINT: 'https://eus.codesigning.azure.net/', PLY_AZURE_ACCOUNT: 'a', PLY_AZURE_PROFILE: 'p', AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' };
    t.ok('ビルド: Azure（認証局）の署名は、発行元が方針の publishers にあれば通る', releaseSigning(azure, 'win32', { publishers: ['Example Publisher'] }).win.azureSignOptions.publisherName === 'Example Publisher');
    const azureUnlisted = throws(() => releaseSigning(azure, 'win32', { publishers: [] }));
    t.ok('ビルド: Azure の発行元が方針に無ければ止める（認証局の署名へ戻る前に、発行元を載せた版を配る）', typeof azureUnlisted === 'string' && azureUnlisted.includes('Example Publisher') && azureUnlisted.includes('update-trust.json'), String(azureUnlisted));
    t.ok('ビルド: none 以外は発行元の名前が要る', typeof throws(() => releaseSigning({ PLY_WINDOWS_SIGNING: 'store', PLY_WIN_CERTIFICATE_SHA1: listed }, 'win32')) === 'string');
    t.ok('ビルド: 知らない方式は止める', String(throws(() => releaseSigning({ ...publisher, PLY_WINDOWS_SIGNING: 'skip' }, 'win32'))).includes('none, store, pfx, or azure'));
    t.ok('ビルド: macOS は方針を読まず、署名と公証のまま', releaseSigning({ PLY_WINDOWS_SIGNING: 'none', CSC_LINK: 'k', CSC_KEY_PASSWORD: 'p', APPLE_ID: 'a', APPLE_APP_SPECIFIC_PASSWORD: 'b', APPLE_TEAM_ID: 'c' }, 'darwin', { signers: [] }).mac.notarize === true);
    const release = fs.readFileSync(new URL('../../electron-builder.release.cjs', import.meta.url), 'utf8');
    t.ok('ビルド: リリースの設定は署名の設定を win に重ねる（win.forceCodeSigning が全体の forceCodeSigning より優先される）', /config\.win = \{ \.\.\.config\.win, \.\.\.signing\.win \}/.test(release) && /forceCodeSigning: true/.test(release));
  }

  // ---- 無署名を出す前の確かめ（scripts/release-unsigned-guard.mjs）
  {
    t.ok('ガード: 版の並びは semver（正式は同じ版の beta より新しい）', compareTags('v1.2.10', 'v1.2.9') > 0 && compareTags('v1.3.0', 'v1.3.0-beta.9') > 0 && compareTags('v1.3.0-beta.10', 'v1.3.0-beta.9') > 0 && compareTags('v1.0.0', 'v1.0.0') === 0 && compareTags('android-v1', 'v1.0.0') === null);
    const list = [
      { tag_name: 'v0.13.18', draft: false }, { tag_name: 'v0.14.0-beta.2', draft: false, prerelease: true }, { tag_name: 'v0.14.0', draft: true },
      { tag_name: 'android-v3', draft: false }, { tag_name: 'v0.13.17', draft: false },
    ];
    const checks = releasesToCheck(list, 'v0.13.18', 'v0.14.0');
    t.ok('ガード: Latest（正式の利用者）と、一番新しい公開済みの版（先行版の利用者）を確かめる。下書き・出す版・形の違うタグは除く', JSON.stringify(checks) === JSON.stringify([{ tag: 'v0.13.18', channel: 'stable' }, { tag: 'v0.14.0-beta.2', channel: 'beta' }]), JSON.stringify(checks));
    t.ok('ガード: Latest が一番新しければ 1 つだけ', JSON.stringify(releasesToCheck([{ tag_name: 'v1.0.0', draft: false }], 'v1.0.0', 'v1.0.1')) === JSON.stringify([{ tag: 'v1.0.0', channel: 'stable' }]));
    t.ok('ガード: 版が 1 つも無ければ確かめるものは無い（通す）', releasesToCheck([], null, 'v1.0.0').length === 0);
    const accepts = new Map([['v0.13.18', { updateAcceptsUnsigned: true }], ['v0.14.0-beta.2', { updateAcceptsUnsigned: true }]]);
    t.ok('ガード: 両方が無署名を受け入れる版なら通す', unsignedBlockers(checks, accepts).length === 0);
    const oldStable = new Map([['v0.13.18', { signing: 'self-signed evaluation' }], ['v0.14.0-beta.2', { updateAcceptsUnsigned: true }]]);
    const blocked = unsignedBlockers(checks, oldStable);
    t.ok('ガード: 受け入れない版（BUILD-INFO に印が無い）が残っていれば止める', blocked.length === 1 && blocked[0].includes('v0.13.18') && blocked[0].includes('stable'), blocked.join(' | '));
    t.ok('ガード: BUILD-INFO が取れない版も止める', unsignedBlockers(checks, new Map()).length === 2);
  }

  // ---- 本物の koffi（Windows）
  if (process.platform === 'win32') {
    const koffi = require('koffi');
    // 信頼されたルートの署名（node.exe）は S_OK で返り、署名者の指紋を読める
    const trusted = sig.inspectSignature(koffi, process.execPath);
    t.ok('本物: 本物の koffi で WinVerifyTrust を呼べ、信頼された署名（node.exe）は S_OK で指紋を読める', trusted.hresult === sig.S_OK && /^[0-9A-F]{40}$/.test(trusted.thumbprint ?? ''), JSON.stringify(trusted));
    const missing = sig.inspectSignature(koffi, 'C:\\no\\such\\ply-update.exe');
    t.ok('本物: 無いファイルは S_OK にならない', missing.hresult !== sig.S_OK && missing.thumbprint === null, JSON.stringify(missing));
    const self = fileURLPath(import.meta.url);
    const script = sig.inspectSignature(koffi, self);
    t.ok('本物: 署名の無いファイルは TRUST_E_SUBJECT_FORM_UNKNOWN か TRUST_E_NOSIGNATURE', script.hresult === 0x800B0003 || script.hresult === NO_SIGNATURE, JSON.stringify(script));
    const verify = sig.createUpdateVerifier({ defaultVerify, trust: policy({ signers: [] }) });
    const nodeResult = await verify(process.execPath, { sha512: await sig.fileSha512(process.execPath) });
    t.ok('本物: 信頼された署名でも、発行元が方針に無ければ不合格', typeof nodeResult === 'string', String(nodeResult));
  }
}

function fileURLPath(url) {
  return decodeURIComponent(new URL(url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
}
