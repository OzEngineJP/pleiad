// 画面（本体の窓）が window.open・target=_blank・外のオリジンへの遷移で外へ出そうとした URL を、既定のブラウザーで開いてよい形にする。
// http と https だけ通す（設定・認証・PR のリンクは target=_blank の素の a で、会話のリンクの md-link を通らずここへ来る。
// localhost の http もここで通る）。資格情報つき・ほかのスキーム・壊れた URL は null（黙って捨てる）
function externalUrl(url) {
  try {
    const u = new URL(url);
    if ((u.protocol === 'https:' || u.protocol === 'http:') && !u.username && !u.password) return u.href;
  } catch {}
  return null;
}

module.exports = { externalUrl };
