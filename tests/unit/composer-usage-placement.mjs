// 入力欄の設定の面: 使用量の棒は、使用枠を決める行に 1 本だけ（承認済み（2026-11-24）。docs/design-system.md「入力欄の設定」）。
//
//   01/02 アカウントの行がある面: エージェントの行は棒を出さず、アカウントの行だけに棒（登録したアカウントを選んでいても「ログイン中」でも）
//   03    アカウントの行が無い面（未登録・アカウントの無いエージェント・スレッドの面）: エージェントの行に 1 本（今のまま）
//   04    互換の接続先: 面に使用量の棒を出さない（アカウントを登録していないエージェントでも）
//   05    エージェントの一覧: アカウントを登録したエージェントは棒を出さない。登録していないエージェントは今のまま
//   06    アカウントの一覧: 変えない（行ごとにそのアカウントの値）
// 描画（web/composer-controls.mjs の renderModel）を DOM の代役の上で動かし、行ごとの棒の有無を読む。
import { agentRowUsage } from "../../web/composer-labels.mjs";

export const name = "composer-usage-placement";
export const title = "入力欄の設定: 使用量の棒は、使用枠を決める行に 1 本だけ";

const usage = (used) => ({ used, high: used >= 80 });
const WEEK = { claude: 3, codex: 12 };   // antigravity は取れない（null）

const BACKENDS = [{ id: "claude", label: "Claude Code" }, { id: "codex", label: "Codex" }, { id: "antigravity", label: "Antigravity" }];
const ACCOUNTS = [
  { value: "", label: "ログイン中", usage: usage(3) },
  { value: "acc-seamth", label: "seamth", usage: usage(1) },
  { value: "acc-personal", label: "個人用", usage: usage(41) },
];
const COMPAT = { options: [{ value: "", label: "公式" }, { value: "ep-or", label: "OpenRouter" }], selected: "ep-or", row: { roles: { main: "qwen3-coder" } }, manage() {} };

/** 面に出す target。over で場面ごとに差し替える */
const target = (over = {}) => ({
  backends: BACKENDS, backend: "claude", backendSwitchable: true,
  backendUsage: (id) => (WEEK[id] == null ? null : usage(WEEK[id])),
  models: {}, model: "", efforts: {}, effort: "", effortDisabled: true, modes: {}, mode: "",
  ...over,
});

export default async function (t) {
  const { N } = await import("../lib/dom-stub.mjs");
  const { renderModel } = await import("../../web/composer-controls.mjs");

  const find = (node, pred, out = []) => {
    for (const c of node.children ?? []) { if (c instanceof N && pred(c)) out.push(c); find(c, pred, out); }
    return out;
  };
  const rowOf = (pop, key) => find(pop, (n) => n.attrs["data-key"] === key)[0] ?? null;
  const bars = (row) => (row ? find(row, (n) => n._classes().includes("usage-mini")).length : -1);
  const percent = (row) => find(row, (n) => n._classes().includes("meta"))[0]?.textContent ?? "";
  const noop = () => {};
  const open = (d, view) => {
    const pop = new N("div");
    const args = { pop, target: d, on: { backend: noop, model: noop, effort: noop, endpoint: noop, account: noop }, hide: noop };
    renderModel(args);
    if (view) rowOf(pop, `nav:${view}`).click();
    return pop;
  };
  const top = (d) => open(d);
  const list = (d, view) => open(d, view);

  // 純粋な規則
  t.ok("規則: 今のエージェントはアカウントの行があれば null", agentRowUsage(target({ accounts: ACCOUNTS, account: "acc-seamth" }), "claude") === null);
  t.ok("規則: 今のエージェントは互換の接続先で null（アカウントの行が無くても）", agentRowUsage(target({ endpoint: COMPAT }), "claude") === null);
  t.ok("規則: アカウントの行も接続先も無ければ値を返す", agentRowUsage(target(), "claude")?.used === 3);
  t.ok("規則: backendUsage が無い面は null", agentRowUsage({ backend: "claude" }, "claude") === null);
  t.ok("規則: 一覧のほかのエージェントは backendHasAccounts が真で null、偽・未指定で値", agentRowUsage(target({ backendHasAccounts: (id) => id === "codex" }), "codex") === null
    && agentRowUsage(target({ backendHasAccounts: () => false }), "codex")?.used === 12 && agentRowUsage(target(), "codex")?.used === 12);

  // 01 登録したアカウントを選んでいる
  {
    const pop = top(target({ accounts: ACCOUNTS, account: "acc-seamth" }));
    t.ok("01: エージェントの行に棒が無い", bars(rowOf(pop, "nav:agent")) === 0);
    t.ok("01: アカウントの行に 1 本（選んでいるアカウントの値）", bars(rowOf(pop, "nav:account")) === 1 && /1/.test(percent(rowOf(pop, "nav:account"))), percent(rowOf(pop, "nav:account")));
    t.ok("01: エージェントの行は › で一覧へ進める（押せる行のまま）", typeof rowOf(pop, "nav:agent").onclick === "function");
  }
  // 02 「ログイン中」を選んでいる
  {
    const pop = top(target({ accounts: ACCOUNTS, account: "" }));
    t.ok("02: エージェントの行に棒が無く、アカウントの行に 1 本（同じ値を 2 回出さない）",
      bars(rowOf(pop, "nav:agent")) === 0 && bars(rowOf(pop, "nav:account")) === 1 && /3/.test(percent(rowOf(pop, "nav:account"))));
  }
  // 03 アカウントの行が無い
  {
    const pop = top(target());
    t.ok("03: 未登録（アカウントの行が無い）ならエージェントの行に 1 本", bars(rowOf(pop, "nav:agent")) === 1 && !rowOf(pop, "nav:account") && /3/.test(percent(rowOf(pop, "nav:agent"))));
    const agy = top(target({ backend: "antigravity" }));
    t.ok("03: アカウントの無いエージェント（取れた値が無い Antigravity）は棒を出さない（今のまま）", bars(rowOf(agy, "nav:agent")) === 0);
    const withUsage = top(target({ backend: "antigravity", backendUsage: () => usage(20) }));
    t.ok("03: アカウントの無いエージェントでも値が取れれば、エージェントの行に 1 本", bars(rowOf(withUsage, "nav:agent")) === 1);
  }
  // 04 互換の接続先
  {
    const withAccounts = top(target({ accounts: ACCOUNTS, account: "", endpoint: COMPAT }));
    t.ok("04: アカウントを登録していても、面に棒が 1 本も無い（アカウントの行は「使いません」）",
      bars(rowOf(withAccounts, "nav:agent")) === 0 && bars(rowOf(withAccounts, "nav:account")) === 0);
    const noAccounts = top(target({ endpoint: COMPAT }));
    t.ok("04: アカウントを登録していないエージェントでも、エージェントの行に棒が無い", bars(rowOf(noAccounts, "nav:agent")) === 0);
  }
  // 05 エージェントの一覧
  {
    const registered = list(target({ accounts: ACCOUNTS, account: "acc-seamth", backendHasAccounts: (id) => id === "claude" }), "agent");
    t.ok("05: 今のエージェント（アカウントの行がある）は一覧でも棒を出さない", bars(rowOf(registered, "backend:claude")) === 0);
    t.ok("05: アカウントを登録していないエージェント（Codex）は今のまま", bars(rowOf(registered, "backend:codex")) === 1 && /12/.test(percent(rowOf(registered, "backend:codex"))));
    const both = list(target({ backend: "codex", accounts: ACCOUNTS, account: "", backendHasAccounts: (id) => id === "claude" || id === "codex" }), "agent");
    t.ok("05: アカウントを登録したエージェントは、今のエージェントでなくても棒を出さない", bars(rowOf(both, "backend:claude")) === 0 && bars(rowOf(both, "backend:codex")) === 0);
    const none = list(target(), "agent");
    t.ok("05: アカウントの行が無い面（スレッドの面など）の一覧は今のまま", bars(rowOf(none, "backend:claude")) === 1 && bars(rowOf(none, "backend:codex")) === 1);
    const compat = list(target({ accounts: ACCOUNTS, account: "", endpoint: COMPAT, backendHasAccounts: (id) => id === "claude" }), "agent");
    t.ok("05: 互換の接続先で動く今のエージェントの行は棒を出さず、ほかのエージェントは規則どおり", bars(rowOf(compat, "backend:claude")) === 0 && bars(rowOf(compat, "backend:codex")) === 1);
  }
  // 06 アカウントの一覧
  {
    const pop = list(target({ accounts: ACCOUNTS, account: "acc-seamth", backendHasAccounts: (id) => id === "claude" }), "account");
    const rows = ACCOUNTS.map((a) => rowOf(pop, `account:${a.value}`));
    t.ok("06: アカウントの一覧は行ごとに棒（変えない）", rows.every((r) => bars(r) === 1), rows.map(bars).join());
    t.ok("06: 値は行ごとのアカウントのもの", ["3", "1", "41"].every((n, i) => percent(rows[i]).includes(n)), rows.map(percent).join(" | "));
  }
}
