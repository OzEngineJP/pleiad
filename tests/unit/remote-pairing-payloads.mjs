// ペアリングの QR の文字列（core/remote/pairing.mjs）を、Kotlin・Swift と同じ tests/remote/vectors.json の pleiad.pairing.payloads で確かめる。
// デスクトップがアプリの入れ方に出す QR（web/remote-parts.mjs の INSTALL_URL）が、読み違えたときに installLink と言い分けられることも見る。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pairingPayload, parsePairingPayload } from '../../core/remote/pairing.mjs';
import { t as tr } from '../../core/i18n.mjs';
import { INSTALL_URL } from '../../web/remote-parts.mjs';

export const name = 'remote-pairing-payloads';
export const title = 'リモート: ペアリングの QR の読み書き（pairingPayload・parsePairingPayload）を 3 版で共有するベクトル';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VECTORS = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'remote', 'vectors.json'), 'utf8'));
const SUBS = ['installLink', 'notCode', 'unsupportedVersion', 'broken', 'hostIdMismatch'];

/** 投げた文言から sub を引く（JS 版は訳した文言で投げる） */
function subOf(text) {
  try { parsePairingPayload(text); return null; } catch (e) {
    return SUBS.find(sub => e.message === tr(`remote.pairingCode.${sub}`)) ?? `?${e.message}`;
  }
}

export default async function (t) {
  const { pairing, host } = VECTORS.pleiad;
  const publicKey = Buffer.from(host.publicKey, 'hex');
  const secret = Buffer.from(pairing.secret, 'hex');
  const cases = pairing.payloads ?? [];
  t.ok('vectors.json にペアリングの QR の事例がある', cases.length > 0);

  for (const v of cases.filter(v => v.build)) {
    const made = pairingPayload({ ...v.build, hostId: host.hostId, publicKey, secret });
    t.ok(`pairingPayload が vectors.json の文字列を作る: ${v.name}`, made === v.input, made === v.input ? undefined : made);
  }
  for (const v of cases.filter(v => v.ok)) {
    let got;
    try { got = parsePairingPayload(v.input); } catch (e) { got = { error: e.message }; }
    const ok = got.relayUrl === v.ok.relayUrl && got.hostId === v.ok.hostId && got.hostName === v.ok.hostName
      && Buffer.compare(Buffer.from(got.publicKey ?? []), publicKey) === 0 && Buffer.compare(Buffer.from(got.secret ?? []), secret) === 0;
    t.ok(`読める: ${v.name}`, ok, ok ? undefined : JSON.stringify(got));
  }
  for (const v of cases.filter(v => v.error)) {
    const sub = subOf(v.input);
    t.ok(`読めない（${v.error}）: ${v.name}`, sub === v.error, String(sub));
  }

  t.ok('デスクトップのアプリの入れ方の QR（INSTALL_URL）が vectors.json の installUrl と同じ', INSTALL_URL === pairing.installUrl, INSTALL_URL);
  t.ok('INSTALL_URL は installLink の事例として載っている', cases.some(v => v.input === INSTALL_URL && v.error === 'installLink'));
}
