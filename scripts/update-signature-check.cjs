'use strict';
// scripts/verify-update-signature.ps1 から呼ぶ手元確認用。desktop/update-signature.cjs の本物の koffi と、electron-updater の本物の
// 既定の確かめ（発行元）で、1 つのファイルを更新として確かめ、結果を JSON で出す（result: null = 受け入れる、文字列 = 不合格の理由）。
//   node scripts/update-signature-check.cjs <ファイル> [--expect <latest.yml の sha512 を取るファイル>] [--unsigned accept|reject] [--signer <指紋>]... [--publisher <名前>]...
// 方針を 1 つも渡さないと desktop/update-trust.json。--expect を省くと、ファイル自身の sha512（latest.yml と一致する場合）
const { loadTrust, fileSha512, inspectSignature, createUpdateVerifier, normalizeThumbprint } = require('../desktop/update-signature.cjs');
const { verifySignature } = require('electron-updater/out/windowsExecutableCodeSignatureVerifier');

const [file, ...args] = process.argv.slice(2);
if (!file) { console.error('usage: update-signature-check.cjs <file> [--expect <file>] [--unsigned accept|reject] [--signer <sha1>]... [--publisher <name>]...'); process.exit(2); }
const options = { expect: file, unsigned: null, signers: [], publishers: [] };
for (let i = 0; i < args.length; i += 2) {
  const [flag, value] = [args[i], args[i + 1]];
  if (value == null) { console.error(`missing value for ${flag}`); process.exit(2); }
  if (flag === '--expect') options.expect = value;
  else if (flag === '--unsigned') options.unsigned = value;
  else if (flag === '--signer') options.signers.push(normalizeThumbprint(value));
  else if (flag === '--publisher') options.publishers.push(value);
  else { console.error(`unknown option ${flag}`); process.exit(2); }
}
const custom = options.unsigned != null || options.signers.length || options.publishers.length;
const trust = custom ? { unsigned: options.unsigned === 'accept', signers: options.signers, publishers: options.publishers } : loadTrust();
(async () => {
  const quiet = { info() {}, warn() {}, error() {} };
  let hresult = null;
  try { hresult = `0x${inspectSignature(require('koffi'), file).hresult.toString(16).toUpperCase().padStart(8, '0')}`; } catch (error) { hresult = `error: ${error.message}`; }
  const result = await createUpdateVerifier({ defaultVerify: verifySignature, logger: quiet, trust })(file, { sha512: await fileSha512(options.expect) });
  console.log(JSON.stringify({ file, hresult, result }));
})();
