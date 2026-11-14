// 試験が global・試験用の document・prototype の項目を差し替えるときの後片付け。
// 差し替える前に項目の元の記述（値・アクセサ）を控え、返した関数で元の形へ戻す。元から無かった項目は delete する。
//
// 控えた値だけを `target[key] = 控えた値` と書き戻すと、元から無かった項目が「値 undefined のプロパティ」で残る。
// 同じ worker で後に流れる suite の `'CSS' in globalThis` のような有無の判定が「ある」と読み、代わりを入れずに落ちる。
//
// 使い方: const restore = keepProps(globalThis, ['CSS', 'window']);  …差し替える…  restore();（try の finally で）
export function keepProps(target, keys) {
  const before = keys.map((key) => [key, Object.getOwnPropertyDescriptor(target, key)]);
  return () => {
    for (const [key, desc] of before) {
      if (desc) Object.defineProperty(target, key, desc);
      else delete target[key];
    }
  };
}
