// 「使えるエージェントはあるか」を決める唯一の場所（docs/desktop-onboarding.md「使えるエージェントが無いとき」、ADR 0313）。
// 画面は副作用を持たない純関数だけを通す。迷うときは「出さない」側に倒す（出し間違えると、利用者が会話に入れなくなる）。
//
// 1 つのエージェントの見立て（level）:
//   'usable'  使える。
//   'maybe'   分からない（確かめていない・確認が失敗した・裏で取得している最中）。0 件とは数えない。
//   'no'      使えないと分かっている。
// 取りうる理由（reason）は画面の行の文言に使う: 'notInstalled' | 'loggedOut' | 'pending' | 'expired' | 'sdkMissing' | 'sdkFetching'
//   | 'unconfirmed' | 'checkFailed' | 'unknown' | 'ok'
//
// エージェントごとの違い（Claude だけ SDK が要る・互換の接続先を持つ）は、id ではなく状態の形と能力の印（capabilities）から読む。

/**
 * @param {object} p
 * @param {object|undefined} p.st                 authStatus の状態（state.auth.get(id)）。まだ返っていなければ undefined
 * @param {boolean} [p.endpointConfirmed]         確かめ済みの互換の接続先を持つ
 * @param {boolean} [p.endpointsKnown]            接続先の一覧を読めたか（読めなければ、持てるエージェントは 'maybe' に倒す）
 * @param {boolean} [p.canEndpoint]               能力の印 compatEndpoints
 * @returns {{ level: 'usable'|'maybe'|'no', reason: string }}
 */
export function agentLevel({ st, endpointConfirmed = false, endpointsKnown = true, canEndpoint = false }) {
  if (!st) return { level: 'maybe', reason: 'unknown' };
  // 状態の問い合わせそのものが失敗した（{ supported:false, error }）。切れていると断定しない
  if (st.error && st.installed === undefined) return { level: 'maybe', reason: 'checkFailed' };
  if (st.installed === false) return { level: 'no', reason: 'notInstalled' };
  const sdk = st.sdk;
  // 本体の見立て
  let body;
  if (st.expired && st.loggedIn) body = { level: 'no', reason: 'expired' };
  else if (st.supported === false) body = st.error ? { level: 'maybe', reason: 'checkFailed' } : { level: 'usable', reason: 'ok' };   // ログインの口を持たない（入っていれば使える）
  else if (st.pending) body = { level: 'no', reason: 'pending' };
  else if (st.loggedIn) body = { level: 'usable', reason: 'ok' };
  else if (endpointConfirmed) body = { level: 'usable', reason: 'ok' };
  else if (st.checkFailed) body = { level: 'maybe', reason: 'checkFailed' };
  else if (st.unconfirmed) body = { level: 'maybe', reason: 'unconfirmed' };
  else if (canEndpoint && !endpointsKnown) body = { level: 'maybe', reason: 'unknown' };
  else body = { level: 'no', reason: 'loggedOut' };
  // 確かめ済みの接続先は期限切れのログインとは関係なく使える
  if (body.reason === 'expired' && endpointConfirmed) body = { level: 'usable', reason: 'ok' };
  if (body.level === 'no') return body;
  // SDK（Claude だけ。状態に sdk が載る）。取れていなければ使えない。ただし同意済みで裏で取っている最中は「分からない」
  if (sdk && !sdk.ready) {
    if (!sdk.error && (sdk.fetching || sdk.consent)) return { level: 'maybe', reason: 'sdkFetching' };
    return { level: 'no', reason: 'sdkMissing' };
  }
  return body;
}

/**
 * 全エージェントの見立てと、0 件かどうか。
 * @param {object} p
 * @param {{id:string, capabilities?:object}[]} p.agents
 * @param {Map<string, object>} p.auth
 * @param {Set<string>|null} [p.endpoints]   確かめ済みの接続先を持つエージェントの id。null は「読めなかった」
 */
export function usableReport({ agents, auth, endpoints = new Set() }) {
  const levels = new Map();
  for (const a of agents) {
    levels.set(a.id, agentLevel({
      st: auth.get(a.id),
      endpointConfirmed: Boolean(endpoints?.has(a.id)),
      endpointsKnown: endpoints !== null,
      canEndpoint: Boolean(a.capabilities?.compatEndpoints),
    }));
  }
  const ids = (level) => agents.filter((a) => levels.get(a.id).level === level).map((a) => a.id);
  const usable = ids('usable'), maybe = ids('maybe'), none = ids('no');
  return { levels, usable, maybe, none, count0: agents.length > 0 && usable.length === 0 && maybe.length === 0 };
}

/**
 * 空の会話の中の一覧（「使えるエージェントがありません」）を出すか。ダイアログと違い、押し出さないので、
 * 使えるものが無く、残りが「裏で SDK を取っている最中」だけのときも出す（取れたら自分で消える）。
 * 分からないものがある（未確認・確認の失敗）ときは出さない
 */
export function listKind(report) {
  if (!report.levels.size || report.usable.length) return false;
  return report.maybe.every((id) => report.levels.get(id)?.reason === 'sdkFetching');
}

/**
 * 起動のときに初回の案内（または「使えるエージェントがありません」）を出すか。
 *   'first'   初めて（まだ案内を見ていない・設定を終えていない）
 *   'none'    設定を終えた人で、使えるものが 0 件と分かっている
 *   null      出さない
 * 出さないとき: 分からないものがある・リモートの窓・スマホ・エージェントが 1 つも無い
 */
export function gateKind({ status, report, remote = false }) {
  if (remote) return null;
  if (!status?.agents?.length) return null;
  if (!status.seen && !status.setupComplete) return 'first';
  return report.count0 ? 'none' : null;
}
