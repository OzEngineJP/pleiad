// 訪問者の OS を見分けて <html data-os="win|mac|linux|android|ios|other"> を付ける。
// ダウンロードのボタンの出し分けと、/download/ で塗るボタンは styles.css の [data-for] [data-primary] が見る。
// 描く前に決めるため、<head> で同期に読む（module にしない）。JS が無いときは data-os が無く、「ダウンロード」→ /download/ の形になる。
// Android の UA には Linux が、iPadOS の UA には Macintosh が入るので、スマホ・タブレットを先に見る。
(() => {
  const ua = navigator.userAgent;
  const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  let os = 'other';
  if (/Android/i.test(platform) || /Android/i.test(ua)) os = 'android';
  else if (/iPhone|iPad|iPod/.test(ua) || /iPhone|iPad|iPod/.test(platform) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) os = 'ios';
  else if (/Mobi/i.test(ua) || (navigator.userAgentData && navigator.userAgentData.mobile)) os = 'other';
  else if (/^Win/i.test(platform) || /Windows NT/.test(ua)) os = 'win';
  else if (/^Mac/i.test(platform) || /Macintosh|Mac OS X/.test(ua)) os = 'mac';
  else if (/CrOS|Chrome OS/i.test(ua + platform)) os = 'other';
  else if (/Linux|X11|BSD/i.test(platform) || /Linux|X11|BSD/i.test(ua)) os = 'linux';
  document.documentElement.dataset.os = os;
})();
