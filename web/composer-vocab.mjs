// 入力欄のモデル・エフォートの一覧が「いま選んでいるもの」の一覧かを決める（DOM を触らない。tests/unit/composer-vocab.mjs から直接呼ぶ）。
// エージェント・アカウントを切り替えた直後は、前のエージェントの一覧を出さない。同じ取得の鍵なら、取得中も取得済みも 1 本に相乗りする。
import { createAccountRequestCache } from './agent-accounts.mjs';

/** モデルの一覧の鍵。一覧はエージェントと（公式の接続先のときの）アカウントで決まる */
export const vocabKey = ({ backend = '', account = '', endpoint = '' } = {}) => JSON.stringify([backend, endpoint ? '' : account]);

/** 一覧を取ってあるのが、いま選んでいるものか（取っていない・別のものなら false） */
export const vocabReady = (loadedKey, wantedKey) => loadedKey != null && loadedKey === wantedKey;

/** 選んだモデルが一覧に無いときに当てる既定（'' があれば '' 、無ければ先頭） */
export const defaultModelOf = (models) => ('' in (models ?? {}) ? '' : Object.keys(models ?? {})[0] ?? '');

/** efforts の問い合わせ（接続先を選んでいるときはアカウントを送らない） */
export const effortRequest = ({ backend, account = '', endpoint = '', model = '', cwd = '' }) => ({
  backend, account: endpoint ? '' : account, model, cwd: cwd || undefined, ...(endpoint ? { endpoint } : {}),
});

/** エフォートの段の鍵。問い合わせの全キー（モデル・作業場所・接続先が違えば別の段） */
export const effortsKeyOf = (selection) => JSON.stringify(effortRequest(selection));

/**
 * エフォートの段の取得。エージェント・アカウント・接続先・作業場所・モデルが同じなら、取得中も取得済みも使い回す
 * （失敗は覚えない）。ログイン・アカウント・接続先・モデルの一覧が変わったら invalidate() で捨てる。
 * invalidate のたびに generation が進む（表示側が「捨てられた後の取得か」を見分ける）
 */
export function createEffortsLoader({ cmd }) {
  const requests = createAccountRequestCache({ read: (key) => cmd('efforts', JSON.parse(key)) });
  let generation = 0;
  return {
    get generation() { return generation; },
    load: (selection) => requests.get(effortsKeyOf(selection)),
    invalidate: () => { generation += 1; requests.invalidate(); },
  };
}

/** 捨てられた取得を取り直す回数の上限（捨てる操作が続いても、いつかは表示を決める） */
const RETRY_LIMIT = 3;

/**
 * 表示しているエフォートの段が、いま選んでいるもの（モデル・作業場所・接続先まで含めて）の段かを持つ。
 *  - ready: 表示してよい段か（鍵が同じ。取り直し中・失敗の代わりの段でも、表示は途切れさせない）
 *  - fresh: 取り直さなくてよい段か（ready で、取得に成功し、その後 loader が捨てられていない）。ログイン・アカウント・接続先の変更で
 *    loader を捨てたら、同じ鍵でも fresh でなくなり、次の adopt が取り直す。失敗して代わりの段を採った鍵も fresh でない
 *  - adopt: 取得が終わったとき、(1) 後から始めた adopt があれば、(2) 待っている間に選び直されていれば、結果を捨てる
 *    （遅れて届いた前のモデルの段で、後から選んだモデルの段を上書きしない）。取得中に loader が捨てられて応答が空（undefined）になったら、
 *    空の段を採らずに取り直す
 */
export function createEffortsView({ loader }) {
  const generationOf = () => loader.generation ?? 0;
  let key = null, efforts = {}, seq = 0, inflight = null, adoptedGeneration = -1, failed = false;
  const ready = (selection) => key != null && key === effortsKeyOf(selection);
  function adopt(selection, current, fallback, attempt = 0) {
    const wanted = effortsKeyOf(selection);
    if (inflight?.key === wanted && inflight.generation === generationOf()) return inflight.promise;   // 同じ段を取っている最中の呼び出しは同じ約束を待つ
    const mine = ++seq, started = generationOf();
    const promise = loader.load(selection).then((got) => ({ got }), () => ({ failure: true })).then(({ got, failure }) => {
      if (inflight?.promise === promise) inflight = null;
      if (mine !== seq || effortsKeyOf(current()) !== wanted) return false;
      // 捨てられた取得の応答は空になる。空の段を採らず、捨てた後の世代で取り直す（回数に上限）
      if (!failure && (got == null || generationOf() !== started) && attempt < RETRY_LIMIT) return adopt(selection, current, fallback, attempt + 1);
      failed = Boolean(failure) || got == null;
      key = wanted; efforts = failed ? fallback : got; adoptedGeneration = generationOf();
      return true;
    });
    inflight = { key: wanted, promise, generation: started };
    return promise;
  }
  return {
    get efforts() { return efforts; },
    ready,
    fresh: (selection) => ready(selection) && !failed && adoptedGeneration === generationOf(),
    adopt,
  };
}
