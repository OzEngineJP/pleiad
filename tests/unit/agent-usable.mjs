import { agentLevel, usableReport, gateKind, listKind, canPick } from '../../web/agent-usable.mjs';

export const name = 'agent-usable';
export const title = 'Usable-agent decision: when the empty-agent notice is shown (and when it must not be)';
export default async function(t) {
  const SDK_READY = { ready: true, consent: true, version: '0.3.288' };
  const SDK_NONE = { ready: false, consent: false, version: '0.3.288', fetching: null, error: null };
  const claude = { id: 'claude', capabilities: { compatEndpoints: true } };
  const codex = { id: 'codex', capabilities: { compatEndpoints: true } };
  const agy = { id: 'antigravity', capabilities: {} };
  const report = (agents, auth, endpoints) => usableReport({ agents, auth: new Map(Object.entries(auth)), endpoints });
  const level = (st, o = {}) => agentLevel({ st, ...o }).level;

  // --- 1 つのエージェントの見立て
  t.ok('uninstalled is not usable', level({ installed: false, supported: true }) === 'no');
  t.ok('uninstalled stays unusable even with a confirmed endpoint', level({ installed: false, supported: true }, { endpointConfirmed: true }) === 'no');
  t.ok('logged out is not usable', level({ installed: true, supported: true, loggedIn: false }) === 'no');
  t.ok('logged in is usable', level({ installed: true, supported: true, loggedIn: true }) === 'usable');
  t.ok('a confirmed compatible endpoint is usable without login', level({ installed: true, supported: true, loggedIn: false }, { endpointConfirmed: true }) === 'usable');
  t.ok('login in progress is not usable yet', level({ installed: true, supported: true, pending: true }) === 'no');
  t.ok('unconfirmed (passive check cannot tell) is "maybe"', level({ installed: true, supported: true, unconfirmed: true }) === 'maybe');
  t.ok('check failure is "maybe"', level({ installed: true, supported: true, checkFailed: true }) === 'maybe');
  t.ok('verdict not returned yet is "maybe"', level(undefined) === 'maybe');
  t.ok('a failed status call is "maybe"', level({ supported: false, error: 'offline' }) === 'maybe');
  t.ok('an agent without a login door is usable once installed', level({ installed: true, supported: false }) === 'usable');
  t.ok('expired login (known after a 401) is not usable', level({ installed: true, supported: true, loggedIn: true, expired: true }) === 'no');
  t.ok('unknown endpoints turn a would-be "no" into "maybe" for agents that can have one', level({ installed: true, supported: true, loggedIn: false }, { endpointsKnown: false, canEndpoint: true }) === 'maybe');
  t.ok('…but not for agents that cannot', level({ installed: true, supported: true, loggedIn: false }, { endpointsKnown: false, canEndpoint: false }) === 'no');

  // --- Claude の SDK
  t.ok('body ok but SDK missing is not usable', agentLevel({ st: { installed: true, supported: true, loggedIn: true, sdk: SDK_NONE } }).reason === 'sdkMissing');
  t.ok('SDK fetching is "maybe" (never a wrongly shown dialog)', level({ installed: true, supported: true, loggedIn: true, sdk: { ...SDK_NONE, fetching: { received: 1, total: 10 } } }) === 'maybe');
  t.ok('SDK re-fetched in the background after an update (consent given) is "maybe"', level({ installed: true, supported: true, loggedIn: true, sdk: { ...SDK_NONE, consent: true } }) === 'maybe');
  t.ok('SDK fetch that failed is not usable', level({ installed: true, supported: true, loggedIn: true, sdk: { ...SDK_NONE, consent: true, error: { kind: 'network' } } }) === 'no');
  t.ok('body + SDK ready is usable', level({ installed: true, supported: true, loggedIn: true, sdk: SDK_READY }) === 'usable');
  t.ok('CLI missing is not usable even if the SDK is ready', level({ installed: false, sdk: SDK_READY }) === 'no');

  // --- 0 件の判定
  const none = { claude: { installed: false, supported: true, sdk: SDK_NONE }, codex: { installed: false, supported: true }, antigravity: { installed: false, supported: true } };
  t.ok('all uninstalled → 0', report([claude, codex, agy], none).count0);
  t.ok('not logged in → 0', report([claude, codex], { claude: { installed: true, supported: true, loggedIn: false, sdk: SDK_NONE }, codex: { installed: true, supported: true, loggedIn: false } }).count0);
  t.ok('Claude logged in but SDK missing (only that) → 0', report([claude], { claude: { installed: true, supported: true, loggedIn: true, sdk: SDK_NONE } }).count0);
  t.ok('an unconfirmed agent means "do not count as 0"', !report([claude, agy], { claude: none.claude, antigravity: { installed: true, supported: true, unconfirmed: true } }).count0);
  t.ok('a check error means "do not count as 0"', !report([codex], { codex: { supported: false, error: 'x' } }).count0);
  t.ok('verdict not yet returned means "do not count as 0"', !report([claude, codex], { claude: none.claude }).count0);
  t.ok('a confirmed compatible endpoint alone is usable', !report([codex], { codex: { installed: true, supported: true, loggedIn: false } }, new Set(['codex'])).count0);
  t.ok('endpoint list unreadable → "do not count as 0"', !report([codex], { codex: { installed: true, supported: true, loggedIn: false } }, null).count0);
  const one = report([claude, codex], { claude: none.claude, codex: { installed: true, supported: true, loggedIn: true } });
  t.ok('exactly one usable → not 0, and it is the one', !one.count0 && one.usable.join() === 'codex' && one.none.join() === 'claude');
  t.ok('no agents at all is not "0" (nothing to fix there)', !report([], {}).count0);

  // --- いつ案内を出すか
  const status = (extra = {}) => ({ agents: [{ id: 'claude' }, { id: 'codex' }], ...extra });
  const zero = report([claude, codex], { claude: none.claude, codex: { installed: true, supported: true, loggedIn: false } });
  const fine = report([claude, codex], { claude: none.claude, codex: { installed: true, supported: true, loggedIn: true } });
  t.ok('first run → onboarding (even when something is usable)', gateKind({ status: status(), report: fine }) === 'first');
  t.ok('finished setup, 0 usable → shown every launch', gateKind({ status: status({ setupComplete: true, seen: true }), report: zero }) === 'none');
  t.ok('finished setup, 0 usable, no version marker is consulted (same answer on the next launch)', gateKind({ status: status({ setupComplete: true, seen: true, notifiedVersion: '1' }), report: zero }) === 'none');
  t.ok('finished setup, one usable → not shown', gateKind({ status: status({ setupComplete: true }), report: fine }) === null);
  t.ok('remote window / phone: never gated (first run)', gateKind({ status: status(), report: zero, remote: true }) === null);
  t.ok('remote window / phone: never gated (0 usable)', gateKind({ status: status({ setupComplete: true }), report: zero, remote: true }) === null);
  t.ok('no agents configured → not shown', gateKind({ status: { agents: [] }, report: report([], {}) }) === null);
  const unsure = report([claude, agy], { claude: none.claude, antigravity: { installed: true, supported: true, unconfirmed: true } });
  t.ok('unconfirmed → not shown', gateKind({ status: status({ setupComplete: true }), report: unsure }) === null);

  // --- 空の会話の中の一覧（押し出さないので、裏で SDK を取っている最中も出す）
  const refetch = report([claude], { claude: { installed: true, supported: true, loggedIn: true, sdk: { ...SDK_NONE, consent: true } } });
  t.ok('list: 0 usable → shown', listKind(zero) === true);
  t.ok('list: SDK re-fetching in the background → shown (the dialog is not)', listKind(refetch) === true && gateKind({ status: status({ setupComplete: true }), report: refetch }) === null);
  t.ok('list: unconfirmed → not shown', listKind(unsure) === false);
  t.ok('list: one usable → not shown', listKind(fine) === false);
  t.ok('list: nothing known yet → not shown', listKind(report([], {})) === false);

  // --- 閉じられない窓は「使えるものが 0 個と確かに分かったとき」だけ。期限切れ・取得の失敗・判定前は窓にしない
  const settled = { setupComplete: true, seen: true };
  const expiredOnly = report([claude], { claude: { installed: true, supported: true, loggedIn: true, expired: true, sdk: SDK_READY } });
  t.ok('expired login alone: not usable, but no closed window at launch', level({ installed: true, supported: true, loggedIn: true, expired: true }) === 'no' && gateKind({ status: status(settled), report: expiredOnly }) === null);
  t.ok('expired login alone: the in-conversation list is shown (re-login there)', listKind(expiredOnly) === true && expiredOnly.none.join() === 'claude');
  t.ok('expired login with another agent logged out: still no window', gateKind({ status: status(settled), report: report([claude, codex], { claude: { installed: true, supported: true, loggedIn: true, expired: true, sdk: SDK_READY }, codex: { installed: true, supported: true, loggedIn: false } }) }) === null);
  const failedFetch = report([claude], { claude: { installed: true, supported: true, loggedIn: true, sdk: { ...SDK_NONE, consent: true, error: { kind: 'network' } } } });
  t.ok('SDK fetch failed after consent (offline after an update): no closed window, the list is shown', gateKind({ status: status(settled), report: failedFetch }) === null && listKind(failedFetch) === true);
  t.ok('SDK refetching after consent: no closed window, the list is shown', gateKind({ status: status(settled), report: refetch }) === null && listKind(refetch) === true);
  const neverFetched = report([claude], { claude: { installed: true, supported: true, loggedIn: true, sdk: SDK_NONE } });
  t.ok('SDK never fetched (no consent record): the window is the way to fetch it', gateKind({ status: status(settled), report: neverFetched }) === 'none');
  const accountOnly = report([claude], { claude: { installed: true, supported: true, loggedIn: false, accountReady: true, sdk: SDK_READY } });
  t.ok('only a registered account (no CLI login): maybe usable → no closed window, no "0" list', level({ installed: true, supported: true, loggedIn: false, accountReady: true, sdk: SDK_READY }) === 'maybe' && gateKind({ status: status(settled), report: accountOnly }) === null && listKind(accountOnly) === false);
  const sdkOnlyFirst = report([claude], { claude: { sdk: { ...SDK_NONE, consent: false } } });
  t.ok('only the SDK event arrived (auth status not yet) → undecided, not 0', level({ sdk: SDK_NONE }) === 'maybe' && !sdkOnlyFirst.count0 && listKind(sdkOnlyFirst) === false);

  // --- 初回の窓で選べる行（canPick）。確かめたが確かめられなかった行・登録したアカウントだけの行は選べる。未確認・はっきり使えない行は選べない
  const pick = (st, o = {}) => canPick(agentLevel({ st, ...o }));
  t.ok('pick: usable is pickable', pick({ installed: true, supported: true, loggedIn: true }) === true);
  t.ok('pick: a check that failed (checkFailed) is pickable', pick({ installed: true, supported: true, loggedIn: false, unconfirmed: true, checkFailed: true }) === true);
  t.ok('pick: the status call itself failed is pickable', pick({ supported: false, error: 'boom' }) === true);
  t.ok('pick: only a registered account is pickable', pick({ installed: true, supported: true, loggedIn: false, accountReady: true }) === true);
  t.ok('pick: never checked (unconfirmed) is not pickable', pick({ installed: true, supported: true, loggedIn: false, unconfirmed: true }) === false);
  t.ok('pick: not installed is not pickable', pick({ installed: false, supported: true }) === false);
  t.ok('pick: confirmed logged out is not pickable', pick({ installed: true, supported: true, loggedIn: false }) === false);
  t.ok('pick: SDK missing is not pickable even if the check failed', pick({ installed: true, supported: true, loggedIn: false, checkFailed: true, sdk: SDK_NONE }) === false);
  t.ok('pick: still undecided (no status yet) is not pickable', pick(undefined) === false);
  const stuck = report([agy], { antigravity: { installed: true, supported: true, loggedIn: false, unconfirmed: true, checkFailed: true } });
  t.ok('first run: the one agent whose check keeps failing is pickable, and the usable list stays empty', canPick(stuck.levels.get('antigravity')) && stuck.usable.length === 0);

  // --- SDK の取得を試みて失敗した（理由がある）状態は、同意の記録が無くても閉じられない窓の条件に数えない
  const failedNoConsent = report([claude], { claude: { installed: true, supported: true, loggedIn: true, sdk: { ...SDK_NONE, consent: false, error: { kind: 'offline', detail: 'x' } } } });
  t.ok('SDK fetch failed without a consent record: no closed window, the list is shown', gateKind({ status: status(settled), report: failedNoConsent }) === null && listKind(failedNoConsent) === true && failedNoConsent.count0 === false);
  t.ok('SDK fetch failed without a consent record: not pickable on the first run', pick({ installed: true, supported: true, loggedIn: true, sdk: { ...SDK_NONE, consent: false, error: { kind: 'offline' } } }) === false);
}
