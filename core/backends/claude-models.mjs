// Claude のモデルの一覧を組み立てる。SDK 非依存（テストから表で叩けるように、claude.mjs から分けた）。
//
// 材料は SDK の supportedModels()（ModelInfo[]。value / resolvedModel / description / supportedEffortLevels）と、
// モデルごとに CLI が実際に使うエフォート（getSettings の applied.effort）、利用者の設定のモデル
// （env の ANTHROPIC_MODEL か settings.json の model）とエフォート（effortLevel）。取れないときは固定の一覧に戻す。
//
// 返す形は codex の models() と揃える:
//   { [id]: { label, note, efforts?: string[], defaultEffort?: string|null, hidden?: true } }
//   ''（既定に従う）には resolvesTo（実際に使われる id）と、その efforts / defaultEffort を写す。
// hidden は「一覧には出さないが、保存済みの値としては有効」（以前の固定の別名 fable / opus …）。

import { t } from "../i18n.mjs";

// 取れないときの一覧（以前の固定の語彙）。エイリアスで渡すと SDK 側が実 ID に解決する。
// 表示名と説明は言語が実行中に変わるので、読むたびに引く（ゲッター。スプレッドしても値になる）
export const FALLBACK_MODELS = {
  "":       { get label() { return t("models.default"); }, get note() { return t("claude.models.defaultNote"); } },
  fable:    { label: "Fable",  get note() { return t("claude.models.fableFallback"); } },
  opus:     { label: "Opus",   get note() { return t("claude.models.opus"); } },
  sonnet:   { label: "Sonnet", get note() { return t("claude.models.sonnet"); } },
  haiku:    { label: "Haiku",  get note() { return t("claude.models.haiku"); } },
};
const ALIASES = ["fable", "opus", "sonnet", "haiku"];
const NOTES = {
  get fable() { return t("claude.models.fable"); },
  get opus() { return t("claude.models.opus"); },
  get sonnet() { return t("claude.models.sonnet"); },
  get haiku() { return t("claude.models.haiku"); },
};

/** 'opus[1m]' / 'claude-opus-5-5[1m]' → 'opus'。知らない系統は null */
export const familyOf = (s) => /(fable|opus|sonnet|haiku)/i.exec(String(s ?? ""))?.[1].toLowerCase() ?? null;

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** 'claude-opus-5-5[1m]' → 'Opus 5.5 (1M)'、'claude-haiku-4-5-20251001' → 'Haiku 4.5'。読めなければ null */
export function labelFromId(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[(\d+[mk])\])?$/i.exec(String(id ?? ""));
  if (!m) return null;
  return `${cap(m[1].toLowerCase())} ${m[2]}${m[3] ? "." + m[3] : ""}${m[4] ? ` (${m[4].toUpperCase()})` : ""}`;
}

/**
 * 版付きの名前。displayName は「Opus (1M context)」のように版が無いので、
 * description の先頭（「Opus 5.5 with 1M context · Best for …」）を優先する。
 */
export function labelOf(row) {
  const head = String(row?.description ?? "").split(" · ")[0].trim();
  if (/^[A-Z][\w-]*\s+\d/.test(head)) {
    const m = /^(.+?)\s+with\s+(\d+[MK])\s+context$/i.exec(head);
    return m ? `${m[1]} (${m[2].toUpperCase()})` : head;
  }
  return labelFromId(row?.resolvedModel) ?? row?.displayName ?? row?.value ?? "";
}

function entryOf(row, efforts, preferredEffort) {
  const family = familyOf(row.resolvedModel ?? row.value);
  const levels = row.supportsEffort === false ? [] : [...(row.supportedEffortLevels ?? [])];
  // preferredEffort は、CLI が実際に当てる段（efforts）を利用者の設定のもとで引けなかったときの代わり。
  // effortLevel がそのまま効くとは限らない（claude.mjs の appliedFor）
  const effort = levels.includes(preferredEffort) ? preferredEffort : efforts?.[row.value];
  return {
    label: labelOf(row),
    note: NOTES[family] ?? String(row.description ?? "").split(" · ").slice(1).join(" · "),
    efforts: levels,
    defaultEffort: levels.includes(effort) ? effort : null,
  };
}

/** 設定のモデル名（'opus[1m]' / 'claude-sonnet-5' / 'sonnet'）を一覧の id に当てる */
function match(out, listed, name) {
  const want = String(name ?? "").trim();
  if (!want) return null;
  const low = want.toLowerCase();
  // 一覧の id（別名・版つきの value。大文字小文字は問わない）か、行の resolvedModel の一致だけ当てる。
  // 一覧に無い名前を系統名へ縮めない（'claude-fable-5-2' を 'fable' にすると、'fable' の指す版は CLI が決めるので、
  // 頼んだのと別の版で走ってしまう。当たらない名前はそのまま送り、CLI/API が使えなければ理由を返す）
  const key = Object.keys(out).find((k) => k !== "" && k.toLowerCase() === low);
  if (key) return key;
  const same = listed.find((r) => String(r.resolvedModel ?? "").toLowerCase() === low);
  return same ? same.value : null;
}

/**
 * AI が明示して書いたモデル名（'claude-sonnet-5-5' / 'Sonnet'）を、一覧の id に当てる。
 * 一覧の id・行の resolvedModel が一致する行だけ。当たらなければ null（呼び手はそのまま送る。系統名へは縮めない）。
 * @param {object} models buildClaudeModels の戻り
 * @param {Array} [rows]  SDK の ModelInfo[]（取れていなければ空）
 */
export function matchClaudeModel(models, rows, name) {
  const listed = (Array.isArray(rows) ? rows : []).filter((r) => r?.value && r.value !== "default");
  return match(models, listed, name);
}

/**
 * @param {object} o
 * @param {Array} o.rows       SDK の ModelInfo[]。空・無しなら固定の一覧
 * @param {Record<string,string>} [o.efforts] モデルの value → CLI が既定で使うエフォート
 * @param {string|null} [o.preferred] 利用者の設定のモデル（ANTHROPIC_MODEL / settings.json の model）
 * @param {string|null} [o.preferredEffort] 利用者の設定のエフォート（CLAUDE_CODE_EFFORT_LEVEL / settings.json の effortLevel）。
 *   efforts を利用者の設定のもとで引けなかったときだけ渡す（渡すと efforts より優先する）
 */
export function buildClaudeModels({ rows, efforts = {}, preferred = null, preferredEffort = null } = {}) {
  if (!Array.isArray(rows) || !rows.some((r) => r?.value && r.value !== "default")) return FALLBACK_MODELS;
  const out = { "": { ...FALLBACK_MODELS[""] } };
  const listed = rows.filter((r) => r?.value && r.value !== "default");
  for (const r of listed) out[r.value] = entryOf(r, efforts, preferredEffort);
  // 以前の固定の別名（fable / opus …）で保存された会話・既定を無効にしない。一覧には出さない。
  // 名前は版を付けず系統名だけにする。別の版の行から版つきの名前を借りると（例: 一覧に claude-fable-5-1 だけのとき
  // 「fable」が「Fable 5.1」と出る）、実際に別名が指す版は CLI が決めるので違う版で走るように見える。
  // 段・説明は同じ系統の行から借りてよい
  for (const alias of ALIASES) {
    if (out[alias]) continue;
    const same = listed.find((r) => familyOf(r.resolvedModel ?? r.value) === alias);
    out[alias] = { ...(same ? entryOf(same, efforts, preferredEffort) : FALLBACK_MODELS[alias]), label: cap(alias), hidden: true };
  }
  // 既定（''）がどれに当たるか。設定のモデルが先、無ければ SDK の既定の行（アカウントの既定）
  const fallback = rows.find((r) => r?.value === "default");
  const target = match(out, listed, preferred)
    ?? match(out, listed, fallback?.resolvedModel);
  if (target) {
    const t = out[target];
    Object.assign(out[""], { resolvesTo: target, efforts: t.efforts, defaultEffort: t.defaultEffort });
  }
  return out;
}

/**
 * 完全な一覧かどうか（CLI がときどき返す「短い一覧」に当たるかを見る）。
 * CLI 2.1.322 の実測: 完全な一覧（14 行）は、行がある系統すべてに「その系統名の別名の行」（value が fable / opus /
 * sonnet / haiku）を持つ。短い一覧（5 行）は `claude-fable-5-1[1m]` のような版つきの行だけで、系統の別名の行が
 * 欠けている。系統の行があるのに別名の行が無いものを「短い一覧」とみなす。
 * （別名の行が無いと、その系統は隠しの別名しか無く、選ぶと CLI の決める版で走る。短い一覧で完全な一覧を
 * 上書きすると、版つきの行が消えて選べなくなる）
 */
export function catalogIsComplete(rows) {
  if (!Array.isArray(rows)) return false;
  const families = new Set(), aliased = new Set();
  for (const r of rows) {
    const value = String(r?.value ?? "");
    if (value === "default") continue;
    const family = ALIASES.includes(value) ? value : familyOf(r?.resolvedModel ?? value);
    if (!family) continue;
    families.add(family);
    if (ALIASES.includes(value)) aliased.add(family);
  }
  for (const family of families) if (!aliased.has(family)) return false;
  return true;
}
