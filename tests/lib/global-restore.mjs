// suite が global に残したものを、suite の終わりに、ランナーが suite の前の状態へ戻す。
//
// 呼ぶのは createGuardedRunner().run（tests/lib/runner.mjs）の 1 か所だけ。--jobs 1（同じプロセス）も、--jobs N（tests/lib/run-worker.mjs の worker）も
// そこを通るので、どちらでも同じ動きになる。
//
// なぜ: 「値を退避 → 差し替え → 代入で戻す」と、元から無かった項目が値 undefined の自前の項目として残る（`globalThis.CSS = undefined`）。
//   `'CSS' in globalThis` や `Object.hasOwn` で有無を見て分岐する別の suite は、それを「ある」と読んで落ちる（web-account-models → computer-settings）。
//   同じ worker に続けて流れたときにだけ起きるので、suite の順番が変わると出たり消えたりし、落ち方は worker ごとの死になる（CI は worker の死を流し直さない: ADR 0162）。
//   後片付けを suite ごとに正しく書く前提をやめ、ランナーが 1 か所で戻す。suite 側で正しく戻すこと（tests/lib/keep-props.mjs）は引き続き望ましい。ここは取りこぼしの受け皿。
//
// 控えて戻すもの（対象）。suite の本体（default の関数）が動いている間の変化だけを見る:
//   globalThis    自前の項目（文字列と Symbol）の有無と記述子。
//   document      試験用の代役（tests/lib/dom-stub.mjs）の自前の項目。suite が globalThis.document を別の物に替えても、最初の物の項目を戻す。
//   N.prototype   代役の要素（dom-stub の N）のプロトタイプ。差し替えて代入で戻す suite が多く、`'focus' in el` に同じ形の取りこぼしが当たる。
//   process.env   名前と値。ランナーには suite ごとの環境変数の隔離が無い（worker ごとの一時データ置き場だけ）。今の漏れは 0 件だが、同じ形で防ぐ。
//                 環境変数は秘密を持ちうるので、知らせるのは名前だけ（値は書かない。globalThis の項目も名前だけ）。
//   戻し方: suite の前に無かった項目は消し、消された項目と替えられた項目は元の記述子（環境変数は元の文字列）へ戻す。
//
// 対象にしないもの: 項目の中身の変更（location.href の書き換え・Object.prototype や組み込みのプロトタイプの汚染・console のメソッドの差し替え・process.chdir など）。
//   Node の「差し替え可能な遅延の属性」（navigator など。getter のまま、差し替えは内部に持つ）も、記述子が変わらないので見えない。
//
// 残すものと、残さないものの知らせ方:
//   KEEP_GLOBALS    ライブラリが最初に読まれたとき 1 回だけ足す項目。suite が最初に読み込んでしまっても消さない（消すと、あとから読まれる別のコピーと食い違う。そもそも消せないものもある）。
//                   規則（`__` で始まる・Symbol など）では決めず、1 つずつ理由を付けて書く: 規則にすると suite の取りこぼし（`globalThis.__fake = …`）まで残り、漏れが見えなくなる。
//                   ライブラリが増えて、この一覧に無い項目が戻されたせいで壊れたら、その項目の名前が直前の suite の出力の `[global]` の行に出ているので、ここへ足す。
//   上の一覧に当たらない足された項目は、戻したうえで、その suite の出力に `[global] …` を 1 行出す（名前だけ）。判定は増やさず、suite の結果は変えない。
//   例外（知らせずに戻す）: 値が無い・undefined のまま有無だけが変わる項目（上の `CSS = undefined` の形）。既存の多くの suite が今も出していて、毎回出すと本物の知らせが埋もれる。
//   PLEIAD_TEST_GLOBALS=diff で、知らせない分も含めて suite ごとに全部の変化を出す（どの suite が何を残したか）。off で何もしない（昔の動き。原因を切り分けるとき用）。
//
// 戻す処理は suite の結果を変えない: 例外を外へ出さない（configurable でない項目・Proxy の例外・読めない対象は、戻せなかったと知らせるだけ）。
// 遅れて動く処理（suite が結果を返した後のタイマーなど）の変化は見ない。戻すのは、suite の本体とランナーの後始末（保持役の待ち・worktree の確認）が終わった後の 1 回だけ。
//   次の suite の頭でも見る案は採らない: worker は suite を import してから run を呼ぶので、頭で「前の戻した状態から変わったもの」を戻すと、suite が import 時に足した global まで消す。
//   全件の記録（worker 12 本）で、suite の間（戻した後から次の suite の import まで）に起きた変化は 0 件だった。
import { N } from "./dom-stub.mjs";
import { RESTART_GLOBAL_KEY } from "./restart.mjs";

export const GLOBALS_ENV = "PLEIAD_TEST_GLOBALS";
export const GLOBALS_MODES = Object.freeze(["on", "diff", "off"]);

/** on（既定）= 戻して、値のある変化だけ 1 行知らせる / diff = 戻して、全部の変化を出す / off = 戻さない。おかしな値は例外（黙って既定に戻さない） */
export function globalsModeFromEnv(env = process.env) {
  const raw = String(env[GLOBALS_ENV] ?? "").trim();
  if (raw === "") return "on";
  if (!GLOBALS_MODES.includes(raw)) throw new Error(`${GLOBALS_ENV} は ${GLOBALS_MODES.join("・")} のどれか: ${JSON.stringify(raw)}`);
  return raw;
}

/** suite が足しても消さない globalThis の項目。{ key, why }。足すときは、どのライブラリが何のために足すかを why に書く */
export const KEEP_GLOBALS = Object.freeze([
  { key: "__zod_globalConfig", why: "zod が最初に読まれたとき `??=` で 1 回だけ置く設定の入れ物。消すと、あとから読まれる別のコピーが別の入れ物を作って食い違う" },
  { key: "__zod_globalRegistry", why: "zod が最初に読まれたとき `??=` で 1 回だけ置く登録簿。理由は __zod_globalConfig と同じ" },
  { key: Symbol.for("graceful-fs.queue"), why: "graceful-fs が最初に読まれたとき、getter だけの設定不可の項目として置く（消せない。読み込みは 1 回だけで、置き直されない）" },
]);

/** ランナー自身が suite のたびに入れ直す項目。suite の取りこぼしではないので、見ない・戻さない */
export const RUNNER_OWNED_GLOBALS = Object.freeze([
  { key: RESTART_GLOBAL_KEY, why: "createGuardedRunner が suite の後に uninstallRestartMode → installRestartFromEnv で入れ直す（tests/lib/restart.mjs）" },
]);

// ---------------------------------------------------------------------------------------------------------------------
// 記述子の扱い

const show = (key) => (typeof key === "symbol" ? key.toString() : String(key));
const errorText = (error) => String(error?.message ?? error).split("\n")[0].slice(0, 120);
const isData = (desc) => Boolean(desc) && "value" in desc;
/** 項目が無い、または値の無い自前の項目（値 undefined のデータ）。有無だけが変わったこの形の項目は、知らせずに戻す */
const hollow = (desc) => desc === undefined || (isData(desc) && desc.value === undefined);

function sameDescriptor(a, b) {
  if (a.configurable !== b.configurable || a.enumerable !== b.enumerable || isData(a) !== isData(b)) return false;
  return isData(a) ? a.writable === b.writable && Object.is(a.value, b.value) : a.get === b.get && a.set === b.set;
}

/**
 * 自前の項目の記述子を全部読む。
 * 記述子を読んだだけで値になる遅延の項目がある（V8 の遅延の data 項目。Node の FormData・Headers など）。その読み込みの途中で別の項目が足されることもある
 * （undici が最初に読まれると、configurable でない `Symbol(undici.globalDispatcher.1)` などを足す）。項目の一覧を先に取って後から読むと、それが
 * 「suite が足したもの」に見える（しかも消せない）ので、読んでいる間に一覧が変わらなくなるまで読み直す。読み直しは数回まで（常に増える対象でも止まる）。
 */
function ownDescriptors(object) {
  let keys = Reflect.ownKeys(object);
  for (let attempt = 0; ; attempt++) {
    const map = new Map();
    for (const key of keys) {
      const desc = Reflect.getOwnPropertyDescriptor(object, key);
      if (desc) map.set(key, desc);
    }
    const again = Reflect.ownKeys(object);
    if (attempt >= 4 || (again.length === keys.length && again.every((key, i) => key === keys[i]))) return map;
    keys = again;
  }
}

/**
 * Node の遅延の global（crypto など）は、最初に触られた所で getter が自分を値の項目に置き換える。
 * 値が元の getter の返す物と同じなら中身は変わっていないので、戻さず知らせない（戻すと、触るたびに知らせることになる）。
 */
function lazyMaterialized(before, now, object) {
  if (isData(before) || !isData(now) || typeof before.get !== "function") return false;
  try { return Object.is(before.get.call(object), now.value); } catch { return false; }
}

/** 戻せたら null、戻せなければ理由 */
function tryDelete(object, key) {
  try { return Reflect.deleteProperty(object, key) ? null : "configurable でない"; } catch (error) { return errorText(error); }
}
function tryDefine(object, key, desc) {
  try { return Reflect.defineProperty(object, key, desc) ? null : "元の記述子へ戻せない（configurable でない）"; } catch (error) { return errorText(error); }
}

// ---------------------------------------------------------------------------------------------------------------------
// 控える・戻す

/** 控える対象。suite のたびに作り直す（globalThis.document が前の suite で替えられていても、今の物を見るため） */
export function defaultTargets() {
  const targets = [{ label: "globalThis", kind: "object", object: globalThis, keep: KEEP_GLOBALS, owned: RUNNER_OWNED_GLOBALS }];
  const doc = globalThis.document;
  if (doc !== null && typeof doc === "object") targets.push({ label: "document", kind: "object", object: doc });
  targets.push({ label: "N.prototype", kind: "object", object: N.prototype });
  targets.push({ label: "process.env", kind: "env", object: process.env });
  return targets;
}

/** 対象の今の状態を控える。例外は出さない（控えられない対象は、戻すときに知らせる） */
export function snapshotGlobals(targets = defaultTargets) {
  let list;
  try { list = typeof targets === "function" ? targets() : targets; } catch (error) { return [{ target: { label: "対象の一覧" }, error }]; }
  return list.map((target) => {
    try { return { target, before: target.kind === "env" ? new Map(Object.entries(target.object)) : ownDescriptors(target.object) }; } catch (error) { return { target, error }; }
  });
}

function restoreObject(target, before) {
  const { object, label, keep = [], owned = [] } = target;
  const items = [];
  const add = (what, key, how, quiet, why) => items.push({ label, what, key: show(key), how, quiet, why });
  const now = ownDescriptors(object);
  const ownedKey = (key) => owned.some((o) => o.key === key);
  for (const [key, nowDesc] of now) {
    if (ownedKey(key)) continue;
    const beforeDesc = before.get(key);
    if (beforeDesc === undefined) {
      const kept = keep.find((k) => k.key === key);
      if (kept) { add("added", key, "kept", true, kept.why); continue; }
      const failure = tryDelete(object, key);
      add("added", key, failure ? "failed" : "restored", failure ? false : hollow(nowDesc), failure ?? undefined);
    } else if (!sameDescriptor(beforeDesc, nowDesc)) {
      if (lazyMaterialized(beforeDesc, nowDesc, object)) { add("changed", key, "left", true); continue; }
      const failure = tryDefine(object, key, beforeDesc);
      add("changed", key, failure ? "failed" : "restored", failure ? false : hollow(beforeDesc) && hollow(nowDesc), failure ?? undefined);
    }
  }
  for (const [key, beforeDesc] of before) {
    if (ownedKey(key) || now.has(key)) continue;
    const failure = tryDefine(object, key, beforeDesc);
    add("removed", key, failure ? "failed" : "restored", failure ? false : hollow(beforeDesc), failure ?? undefined);
  }
  return items;
}

function restoreEnv(target, before) {
  const { object: env, label } = target;
  const items = [];
  const add = (what, name, how, why) => items.push({ label, what, key: name, how, quiet: false, why });
  const attempt = (what, name, action) => {
    try { action(); add(what, name, "restored"); } catch (error) { add(what, name, "failed", errorText(error)); }
  };
  const now = new Map(Object.entries(env));
  for (const [name, value] of now) {
    if (!before.has(name)) attempt("added", name, () => { delete env[name]; });
    else if (before.get(name) !== value) attempt("changed", name, () => { env[name] = before.get(name); });
  }
  for (const [name, value] of before) if (!now.has(name)) attempt("removed", name, () => { env[name] = value; });
  return items;
}

/**
 * 控えた状態へ戻し、何をしたかの一覧を返す。例外は出さない。
 * 項目: { label: 対象, what: added|removed|changed|snapshot|restore, key: 名前, how: restored|kept|left|failed, quiet: 知らせない分か, why }
 */
export function restoreGlobals(snapshot) {
  const items = [];
  for (const entry of snapshot ?? []) {
    const { target } = entry;
    if (entry.error) { items.push({ label: target.label, what: "snapshot", key: "", how: "failed", quiet: false, why: errorText(entry.error) }); continue; }
    try {
      items.push(...(target.kind === "env" ? restoreEnv(target, entry.before) : restoreObject(target, entry.before)));
    } catch (error) {
      items.push({ label: target.label, what: "restore", key: "", how: "failed", quiet: false, why: errorText(error) });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------------------------------------------------
// 知らせる

const NAMES_MAX = 8;
const listNames = (keys) => keys.slice(0, NAMES_MAX).join("・") + (keys.length > NAMES_MAX ? ` ほか ${keys.length - NAMES_MAX} 件` : "");
const uniq = (list) => [...new Set(list.filter(Boolean))].join(" / ");

function phrase({ label, what, how, quiet, keys, whys }) {
  const names = listNames(keys);
  // 名前の後ろに助詞が続く。値の無い項目は、名前に注記を付けて空白なしで続ける
  const subject = quiet ? `${names}（値の無い項目）` : `${names} `;
  if (what === "snapshot") return `${label} を控えられなかった（${uniq(whys)}）`;
  if (what === "restore") return `${label} を戻す途中で失敗した（${uniq(whys)}）`;
  if (how === "failed") return `${label} の ${names} は${what === "added" ? "消せ" : "戻せ"}なかった（${uniq(whys)}）`;
  // 残した項目の理由は KEEP_GLOBALS の why に書いてある（行には出さない。diff の行が長くなる）
  if (what === "added") return how === "kept" ? `${label} に足された ${names} は残した（KEEP_GLOBALS の項目）` : `${label} に足された ${subject}を消した`;
  if (what === "removed") return `${label} から消された ${subject}を戻した`;
  return how === "left"
    ? `${label} の ${names} は、遅延の読み込みで値の項目になっただけなので、そのままにした`
    : `${label} の ${subject}が替わっていたので戻した`;
}

/**
 * 一覧を、suite の出力に出す行にする。名前だけで、値は出さない。
 * on: 知らせない分を除いて 1 行 / diff: 知らせない分も含め、対象と種類ごとに 1 行
 */
export function formatReport(items, mode = "on") {
  const shown = mode === "diff" ? items : items.filter((item) => !item.quiet);
  if (!shown.length) return [];
  const groups = new Map();
  for (const item of shown) {
    const id = [item.label, item.what, item.how, item.quiet].join("\u0000");
    if (!groups.has(id)) groups.set(id, { label: item.label, what: item.what, how: item.how, quiet: item.quiet, keys: [], whys: [] });
    const group = groups.get(id);
    if (item.key !== "") group.keys.push(item.key);
    group.whys.push(item.why);
  }
  const phrases = [...groups.values()].map(phrase);
  if (mode === "diff") return phrases.map((p) => `  [global] ${p}`);
  // 案内は globalThis に足された項目だけ（KEEP_GLOBALS は globalThis にしか効かない。document などの項目に付けると、足しても直らない案内になる）
  const hint = shown.some((item) => item.what === "added" && item.how === "restored" && item.label === "globalThis")
    ? "。残してよい項目（ライブラリが 1 回だけ足すもの）なら tests/lib/global-restore.mjs の KEEP_GLOBALS へ"
    : "";
  return [`  [global] suite の後に元の状態へ戻した — ${phrases.join(" / ")}${hint}`];
}

/**
 * ランナーが使う口。begin() で suite の前の状態を控え、end(控え) で戻して、出す行（文字列の配列）を返す。
 * targets は、控える対象の一覧（または一覧を返す関数。既定は defaultTargets）。試験が代役の対象を渡すために開けてある。
 */
export function createGlobalGuard({ mode = globalsModeFromEnv(), targets = defaultTargets } = {}) {
  return {
    mode,
    begin() { return mode === "off" ? null : snapshotGlobals(targets); },
    end(snapshot) {
      if (!snapshot) return [];
      try { return formatReport(restoreGlobals(snapshot), mode); } catch (error) { return [`  [global] 戻す処理が失敗した（suite の結果には影響しない）: ${errorText(error)}`]; }
    },
  };
}
