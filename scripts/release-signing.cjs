const { loadTrust, normalizeThumbprint } = require('../desktop/update-signature.cjs');

// 今の版の自動更新が、次の版を受け入れられるかを先に確かめる（desktop/update-trust.json・desktop/update-signature.cjs。ADR 0209）。
// 自己署名は、方針の signers にある指紋でだけ通る。Windows が信頼する署名（Azure の認証局）は、方針の publishers にある発行元でだけ通る。
// 無署名は、方針の unsigned が accept のときだけ通る。どれも、手元の方針（このビルドが同梱するもの）で確かめる
function assertUpdateSigner(thumbprint, signers = loadTrust().signers) {
  if (!signers.includes(normalizeThumbprint(thumbprint))) {
    throw new Error(`Signing certificate ${normalizeThumbprint(thumbprint)} is not listed in desktop/update-trust.json. A build signed with it could not be installed by the auto-updater. Ship the new fingerprint in a build the current policy accepts first`);
  }
}
function assertUpdatePublisher(publisherName, publishers = loadTrust().publishers) {
  if (!publishers.includes(publisherName)) {
    throw new Error(`Publisher "${publisherName}" is not listed in desktop/update-trust.json. A build signed by it could not be installed by the auto-updater. Ship the publisher in a build the current policy accepts first`);
  }
}

// 無署名のビルドに渡してはいけない署名の設定（electron-builder が環境から拾って署名しないように）
const SIGNING_ENV = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'PLY_WIN_CERTIFICATE_SHA1', 'AZURE_CLIENT_SECRET'];

// Only public signing configuration is returned. Credentials stay in the environment.
// PLY_WINDOWS_SIGNING: none（無署名。今の配布）・store（証明書ストアの証明書）・pfx（CSC_LINK）・azure（Azure Artifact Signing）。既定は pfx
function releaseSigning(env = process.env, platform = process.platform, { signers, publishers, trust } = {}) {
  const required = name => {
    if (!env[name]?.trim()) throw new Error(`Missing signing setting: ${name}`);
    return env[name].trim();
  };
  if (platform === 'darwin') {
    for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) required(name);
    return { mac: { hardenedRuntime: true, notarize: true } };
  }
  if (platform !== 'win32') throw new Error('Signed desktop builds require Windows or macOS');
  const method = env.PLY_WINDOWS_SIGNING || 'pfx';
  if (method === 'none') {
    const present = SIGNING_ENV.filter(name => env[name]?.trim());
    if (present.length) throw new Error(`PLY_WINDOWS_SIGNING=none must not be given signing settings: ${present.join(', ')}`);
    if (!(trust ?? loadTrust()).unsigned) throw new Error('desktop/update-trust.json does not accept unsigned updates. An unsigned build could not receive the next unsigned update');
    // forceCodeSigning（electron-builder.release.cjs）は Windows だけ外す。signExecutable: false で、環境に何があっても署名しない。
    // verifyUpdateCodeSignature: false で app-update.yml に publisherName を書かない（確かめは desktop/update-signature.cjs が方針で行う）
    return { win: { forceCodeSigning: false, signExecutable: false, verifyUpdateCodeSignature: false } };
  }
  const publisherName = required('PLY_WIN_PUBLISHER');
  const win = { verifyUpdateCodeSignature: true };
  if (method === 'azure') {
    for (const name of ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET']) required(name);
    const endpoint = required('PLY_AZURE_ENDPOINT');
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.codesigning.azure.net') || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid Azure signing endpoint');
    assertUpdatePublisher(publisherName, publishers ?? trust?.publishers);
    win.azureSignOptions = { publisherName, endpoint, codeSigningAccountName: required('PLY_AZURE_ACCOUNT'), certificateProfileName: required('PLY_AZURE_PROFILE') };
  } else if (method === 'pfx' || method === 'store') {
    win.signtoolOptions = { publisherName, signingHashAlgorithms: ['sha256'] };
    if (method === 'pfx') {
      required('CSC_LINK'); required('CSC_KEY_PASSWORD');
      // pfx は証明書の指紋を環境から知らない。PLY_WIN_CERTIFICATE_SHA1 を渡したときだけ検査する
      if (env.PLY_WIN_CERTIFICATE_SHA1?.trim()) assertUpdateSigner(env.PLY_WIN_CERTIFICATE_SHA1.trim(), signers ?? trust?.signers);
    } else {
      const certificateSha1 = required('PLY_WIN_CERTIFICATE_SHA1');
      if (!/^[a-f\d]{40}$/i.test(certificateSha1)) throw new Error('Invalid signing certificate thumbprint');
      assertUpdateSigner(certificateSha1, signers ?? trust?.signers);
      win.signtoolOptions.certificateSha1 = certificateSha1;
    }
  } else throw new Error('PLY_WINDOWS_SIGNING must be none, store, pfx, or azure');
  return { win };
}
module.exports = { releaseSigning, SIGNING_ENV };
