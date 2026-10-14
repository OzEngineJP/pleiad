'use strict';
// 自動更新のダウンロード後の確かめ（ADR 0207。ADR 0176 を改める）。electron-updater の NsisUpdater.verifySignature を差し替える。
// 既定の verifySignature は、入っている app-update.yml に publisherName が無いと何も確かめない（無署名の版の app-update.yml には書かれない）。
// 差し替えると、方針（desktop/update-trust.json）で毎回確かめる:
//   1. 中身: ファイルの sha512 が、ダウンロードした latest.yml の値と一致する（electron-updater も取る途中で確かめる。差し込みの前の念押し）
//   2. 署名: WinVerifyTrust の結果で分ける
//      - S_OK（Windows が信頼する署名）: 署名者の指紋が signers にあるか、発行元が publishers（と app-update.yml の publisherName）に合えば合格。
//        合わない発行元の署名は通さない（将来の認証局の署名へ戻る道。発行元は electron-updater の既定の確かめで比べる）
//      - CERT_E_UNTRUSTEDROOT（信頼されないルート = 自己署名）: 同じ状態データから取った署名者の SHA-1 指紋が signers にあるときだけ合格
//      - TRUST_E_NOSIGNATURE（署名が無い）: unsigned が accept のときだけ合格
//      - それ以外（TRUST_E_BAD_DIGEST = 署名の後の改ざん、期限切れ、形の違うファイルなど）は不合格
// 署名者の証明書は WinVerifyTrust の状態データからだけ読む（別の読み方で取ると、検証した署名と別のものを見かねない）。
// koffi を読めない・呼べないときは分けられないので、publishers に合う署名（既定の確かめ）だけを通し、ほかは不合格（閉じる側に倒す）。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TRUST_FILE = path.join(__dirname, 'update-trust.json');

const S_OK = 0;
const CERT_E_UNTRUSTEDROOT = 0x800B0109;
const TRUST_E_NOSIGNATURE = 0x800B0100;
const WTD_UI_NONE = 2;
const WTD_REVOKE_NONE = 0;
const WTD_CHOICE_FILE = 1;
const WTD_STATEACTION_VERIFY = 1;
const WTD_STATEACTION_CLOSE = 2;
const WTD_REVOCATION_CHECK_NONE = 0x10;
// WINTRUST_ACTION_GENERIC_VERIFY_V2 {00AAC56B-CD44-11d0-8CC2-00C04FC295EE}
const GENERIC_VERIFY_V2 = { Data1: 0x00AAC56B, Data2: 0xCD44, Data3: 0x11D0, Data4: [0x8C, 0xC2, 0x00, 0xC0, 0x4F, 0xC2, 0x95, 0xEE] };

const HRESULT_NAMES = new Map([
  [S_OK, 'S_OK'],
  [CERT_E_UNTRUSTEDROOT, 'CERT_E_UNTRUSTEDROOT'],
  [TRUST_E_NOSIGNATURE, 'TRUST_E_NOSIGNATURE'],
  [0x80096010, 'TRUST_E_BAD_DIGEST'],
  [0x800B0101, 'CERT_E_EXPIRED'],
  [0x800B010A, 'CERT_E_CHAINING'],
  [0x800B0111, 'TRUST_E_EXPLICIT_DISTRUST'],
  [0x800B0003, 'TRUST_E_SUBJECT_FORM_UNKNOWN'],
  [0x800B0004, 'TRUST_E_SUBJECT_NOT_TRUSTED'],
]);
const hex = hr => `0x${(hr >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;
const describe = hr => HRESULT_NAMES.has(hr >>> 0) ? `${hex(hr)} ${HRESULT_NAMES.get(hr >>> 0)}` : hex(hr);

/** 40 桁の 16 進（空白・コロン・大小は問わない）を大文字に揃える。違う形は例外 */
function normalizeThumbprint(value) {
  const text = String(value ?? '').replace(/[\s:]/g, '').toUpperCase();
  if (!/^[0-9A-F]{40}$/.test(text)) throw new Error(`Invalid certificate thumbprint: ${String(value).slice(0, 60)}`);
  return text;
}

/**
 * update-trust.json の方針 { unsigned: boolean, publishers: string[], signers: string[] }（signers は大文字の 40 桁）。
 * 読めない・形が違う・何も受け入れない（unsigned が reject で、publishers も signers も空）ときは例外
 */
function loadTrust(file = TRUST_FILE) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data?.unsigned !== 'accept' && data?.unsigned !== 'reject') throw new Error(`"unsigned" must be "accept" or "reject" in ${path.basename(file)}`);
  if (!Array.isArray(data.publishers) || data.publishers.some(p => typeof p !== 'string' || !p.trim())) throw new Error(`"publishers" must be a list of names in ${path.basename(file)}`);
  if (!Array.isArray(data.signers)) throw new Error(`"signers" must be a list in ${path.basename(file)}`);
  const trust = { unsigned: data.unsigned === 'accept', publishers: data.publishers.map(p => p.trim()), signers: [...new Set(data.signers.map(s => normalizeThumbprint(s?.sha1)))] };
  if (!trust.unsigned && !trust.publishers.length && !trust.signers.length) throw new Error(`${path.basename(file)} accepts no update`);
  return trust;
}

/** 受け入れる自己署名の署名者の指紋（リリースのビルドが、署名に使う証明書を確かめる。scripts/release-signing.cjs） */
function loadSigners(file = TRUST_FILE) {
  return loadTrust(file).signers;
}

const apis = new WeakMap();   // koffi の型は名前がグローバルなので、同じ koffi では 1 回だけ定義する

function api(koffi) {
  if (apis.has(koffi)) return apis.get(koffi);
  const wintrust = koffi.load('wintrust.dll');
  const GUID = koffi.struct('PleiadWtGuid', { Data1: 'uint32', Data2: 'uint16', Data3: 'uint16', Data4: 'uint8_t[8]' });
  const FILE_INFO = koffi.struct('PleiadWtFileInfo', { cbStruct: 'uint32', pcwszFilePath: 'const char16_t*', hFile: 'void*', pgKnownSubject: 'void*' });
  const DATA = koffi.struct('PleiadWtData', {
    cbStruct: 'uint32', pPolicyCallbackData: 'void*', pSIPClientData: 'void*', dwUIChoice: 'uint32', fdwRevocationChecks: 'uint32', dwUnionChoice: 'uint32',
    pFile: 'PleiadWtFileInfo*', dwStateAction: 'uint32', hWVTStateData: 'void*', pwszURLReference: 'void*', dwProvFlags: 'uint32', dwUIContext: 'uint32', pSignatureSettings: 'void*',
  });
  // CRYPT_PROVIDER_SGNR / CRYPT_PROVIDER_CERT / CERT_CONTEXT は、使う先頭の部分だけ（読むのは先頭の要素 = 署名者の証明書）。
  // koffi は戻り値・構造体の中のポインターを開かないので、inspectSignature が koffi.decode で 1 段ずつ読む
  const CERT_CONTEXT = koffi.struct('PleiadWtCertContext', { dwCertEncodingType: 'uint32', pbCertEncoded: 'void*', cbCertEncoded: 'uint32' });
  const PROV_CERT = koffi.struct('PleiadWtProvCert', { cbStruct: 'uint32', pCert: 'void*' });
  const FILETIME = koffi.struct('PleiadWtFileTime', { dwLowDateTime: 'uint32', dwHighDateTime: 'uint32' });
  const PROV_SGNR = koffi.struct('PleiadWtProvSgnr', { cbStruct: 'uint32', sftVerifyAsOf: 'PleiadWtFileTime', csCertChain: 'uint32', pasCertChain: 'void*' });
  const table = {
    WinVerifyTrust: wintrust.func('long __stdcall WinVerifyTrust(intptr_t hwnd, PleiadWtGuid* action, _Inout_ PleiadWtData* data)'),
    WTHelperProvDataFromStateData: wintrust.func('void* __stdcall WTHelperProvDataFromStateData(void* state)'),
    WTHelperGetProvSignerFromChain: wintrust.func('void* __stdcall WTHelperGetProvSignerFromChain(void* provData, uint32 signer, int counterSigner, uint32 counterIndex)'),
    GUID, FILE_INFO, DATA, CERT_CONTEXT, PROV_CERT, FILETIME, PROV_SGNR,
  };
  apis.set(koffi, table);
  return table;
}

/**
 * ファイルの署名を WinVerifyTrust で確かめ、結果が S_OK か CERT_E_UNTRUSTEDROOT のときは、署名者の証明書の SHA-1 指紋も返す。
 * 戻り値 { hresult, thumbprint, error }（hresult は符号なしの数値。thumbprint は読めたときだけ。error は読めなかった理由）。
 * 状態データを開いたら、読み終えた後で必ず WTD_STATEACTION_CLOSE を呼ぶ。koffi の例外は呼んだ側へ投げる
 */
function inspectSignature(koffi, filePath) {
  const a = api(koffi);
  const fileInfo = { cbStruct: koffi.sizeof(a.FILE_INFO), pcwszFilePath: filePath, hFile: null, pgKnownSubject: null };
  const data = {
    cbStruct: koffi.sizeof(a.DATA), pPolicyCallbackData: null, pSIPClientData: null, dwUIChoice: WTD_UI_NONE, fdwRevocationChecks: WTD_REVOKE_NONE, dwUnionChoice: WTD_CHOICE_FILE,
    pFile: fileInfo, dwStateAction: WTD_STATEACTION_VERIFY, hWVTStateData: null, pwszURLReference: null, dwProvFlags: WTD_REVOCATION_CHECK_NONE, dwUIContext: 0, pSignatureSettings: null,
  };
  const noWindow = -1;   // INVALID_HANDLE_VALUE: UI を出さず、窓の持ち主も無い
  let opened = false, hresult;
  try {
    hresult = a.WinVerifyTrust(noWindow, GENERIC_VERIFY_V2, data) >>> 0;
    opened = true;
    if (hresult !== S_OK && hresult !== CERT_E_UNTRUSTEDROOT) return { hresult, thumbprint: null, error: null };
    if (!data.hWVTStateData) return { hresult, thumbprint: null, error: 'WinVerifyTrust returned no state data' };
    const provider = a.WTHelperProvDataFromStateData(data.hWVTStateData);
    if (!provider) return { hresult, thumbprint: null, error: 'WTHelperProvDataFromStateData returned null' };
    const signerPointer = a.WTHelperGetProvSignerFromChain(provider, 0, 0, 0);
    const signer = signerPointer ? koffi.decode(signerPointer, a.PROV_SGNR) : null;
    const leaf = signer?.csCertChain && signer.pasCertChain ? koffi.decode(signer.pasCertChain, a.PROV_CERT) : null;
    if (!leaf?.pCert) return { hresult, thumbprint: null, error: 'the signer certificate was not found' };
    const cert = koffi.decode(leaf.pCert, a.CERT_CONTEXT);
    if (!cert.pbCertEncoded || !(cert.cbCertEncoded > 0) || cert.cbCertEncoded > 64 * 1024) return { hresult, thumbprint: null, error: 'the signer certificate could not be read' };
    const der = Buffer.from(koffi.decode(cert.pbCertEncoded, 'uint8_t', cert.cbCertEncoded));
    return { hresult, thumbprint: crypto.createHash('sha1').update(der).digest('hex').toUpperCase(), error: null };
  } finally {
    // 開いた状態データは必ず閉じる（VERIFY が失敗を返しても状態データは作られていることがある）
    if (opened || data.hWVTStateData) {
      data.dwStateAction = WTD_STATEACTION_CLOSE;
      try { a.WinVerifyTrust(noWindow, GENERIC_VERIFY_V2, data); } catch { /* 閉じる失敗は結果を変えない */ }
    }
  }
}

/** ファイルの sha512（latest.yml と同じ base64） */
function fileSha512(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha512');
    fs.createReadStream(filePath).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('base64')));
  });
}

/**
 * ダウンロードした更新を確かめる関数（(filePath, { sha512, publisherNames }) => null | 不合格の理由）を作る。
 * sha512 は latest.yml の値（無ければ不合格）。publisherNames は入っている app-update.yml の publisherName（publishers に足す）
 * @param {object} deps
 * @param deps.defaultVerify electron-updater の既定の確かめ（publisherNames, path, logger）。Windows が信頼する署名の発行元を比べる
 * @param [deps.logger] electron-updater の logger（info・warn）
 * @param [deps.trust] 方針（既定は update-trust.json）
 * @param [deps.koffi] 偽物でもよい
 * @param [deps.loadKoffi] koffi を読む（既定は require('koffi')）
 * @param [deps.hashFile] ファイルの sha512（既定は fileSha512）
 */
function createUpdateVerifier({ defaultVerify, logger = null, trust = null, koffi = null, loadKoffi = () => require('koffi'), hashFile = fileSha512 }) {
  const quiet = { info() {}, warn() {}, error() {} };
  const reject = reason => { logger?.warn?.(`Update rejected: ${reason}`); return reason; };
  const accept = how => { logger?.info?.(`Update accepted: ${how}`); return null; };
  // Windows が信頼する署名の発行元を、electron-updater の既定の確かめ（Get-AuthenticodeSignature が Valid で、CN か DN が合う）で比べる
  const publisherMatches = async (names, filePath) => {
    if (!names.length) return 'no publisher is accepted';
    try { return await defaultVerify(names, filePath, logger ?? quiet); }
    catch (error) { return `the publisher check failed: ${String(error?.message ?? error)}`; }
  };

  return async function verifyUpdate(filePath, { sha512 = null, publisherNames = [] } = {}) {
    let policy;
    try { policy = trust ?? loadTrust(); }
    catch (error) { return reject(`the update trust policy is unusable: ${error.message}`); }
    if (!sha512) return reject('the expected sha512 of the update is unknown');
    let actual;
    try { actual = await hashFile(filePath); }
    catch (error) { return reject(`the update could not be read: ${String(error?.message ?? error)}`); }
    if (actual !== sha512) return reject(`sha512 mismatch: the file has ${actual}, latest.yml has ${sha512}`);

    const publishers = [...new Set([...policy.publishers, ...publisherNames.filter(Boolean)])];
    let found;
    try { found = inspectSignature(koffi ?? loadKoffi(), filePath); }
    catch (error) {
      // 分けられない。発行元の合う署名だけを通す
      const why = `WinVerifyTrust could not be called: ${String(error?.message ?? error)}`;
      const publisher = await publisherMatches(publishers, filePath);
      return publisher == null ? accept(`signed by an accepted publisher (${why})`) : reject(`${why}; publisher check: ${String(publisher).slice(0, 300)}`);
    }
    const result = describe(found.hresult);
    if (found.hresult === TRUST_E_NOSIGNATURE) {
      return policy.unsigned ? accept(`unsigned, accepted by the trust policy (sha512 matches latest.yml)`) : reject(`WinVerifyTrust returned ${result} and unsigned updates are not accepted`);
    }
    if (found.hresult === S_OK || found.hresult === CERT_E_UNTRUSTEDROOT) {
      if (found.thumbprint && policy.signers.includes(found.thumbprint)) return accept(`${result}, pinned signer ${found.thumbprint}`);
      if (found.hresult === CERT_E_UNTRUSTEDROOT) {
        return reject(`WinVerifyTrust returned ${result} and ${found.thumbprint ? `the signer ${found.thumbprint} is not an accepted update signer` : found.error}`);
      }
      const publisher = await publisherMatches(publishers, filePath);
      if (publisher == null) return accept(`${result}, accepted publisher`);
      return reject(`WinVerifyTrust returned ${result} but the signer ${found.thumbprint ?? '(unread)'} is not an accepted publisher: ${String(publisher).slice(0, 300)}`);
    }
    return reject(`WinVerifyTrust returned ${result}`);
  };
}

/** NsisUpdater がダウンロードしているインストーラーの、latest.yml の sha512（doDownloadUpdate と同じ選び方） */
function expectedSha512(updater) {
  const current = updater.updateInfoAndProvider;
  if (!current?.info || !current.provider) return null;
  const { findFile } = require('electron-updater/out/providers/Provider');
  return findFile(current.provider.resolveFiles(current.info), 'exe')?.info?.sha512 ?? null;
}

/** 入っている app-update.yml の publisherName（無ければ空） */
async function installedPublisherNames(updater) {
  try {
    const name = (await updater.configOnDisk.value)?.publisherName;
    return name == null ? [] : [].concat(name);
  } catch { return []; }
}

/** main から呼ぶ。Windows の NsisUpdater の verifySignature を差し替える（それ以外は何もしない）。差し替えたら true */
function installUpdateSignatureVerifier(updater, { platform = process.platform, defaultVerify = null, sha512Of = expectedSha512, ...rest } = {}) {
  if (platform !== 'win32' || !updater || typeof updater.verifySignature !== 'function' || !('verifyUpdateCodeSignature' in updater)) return false;
  const verify = createUpdateVerifier({ defaultVerify: defaultVerify ?? require('electron-updater/out/windowsExecutableCodeSignatureVerifier').verifySignature, logger: updater.logger, ...rest });
  updater.verifySignature = async filePath => {
    let sha512 = null;
    try { sha512 = sha512Of(updater); } catch { /* 分からなければ verifyUpdate が不合格にする */ }
    return verify(filePath, { sha512, publisherNames: await installedPublisherNames(updater) });
  };
  return true;
}

module.exports = { S_OK, CERT_E_UNTRUSTEDROOT, TRUST_E_NOSIGNATURE, TRUST_FILE, normalizeThumbprint, loadTrust, loadSigners, inspectSignature, fileSha512, createUpdateVerifier, expectedSha512, installUpdateSignatureVerifier };
