// 入力欄の設定のチップ・一覧に出す字を決める関数（DOM を触らない。tests/unit/composer-labels.mjs から直接呼ぶ）。
// 画面の組み立ては web/composer-controls.mjs、仕様は docs/design-system.md「入力欄の設定」。
import { t } from "./i18n.mjs";

/**
 * モデルの表示。'' は実際に当たるモデルの名前にする（resolvesTo）。分からなければ '' の行の名前（「既定に従う」など）
 * @returns {{ id: string, entry: object|null, label: string }}
 */
export function resolvedModel(models, value) {
  const id = value || models?.[""]?.resolvesTo || "";
  const entry = models?.[id] ?? null;
  const label = id ? entry?.label ?? id : models?.[""]?.resolvedLabel ?? models?.[""]?.label ?? t("chat.next.useDefault");
  return { id, entry, label };
}

/**
 * 記録にある生のモデル id（claude-sonnet-5 など）を画面の名前にする。一覧にあればその名前、
 * 無ければ Claude の id の形（claude-<系統>-<版>[-<版>][-<日付>]）を「Sonnet 5」「Haiku 4.5」と読む。どちらでもなければ id のまま
 */
export function modelDisplayName(models, id) {
  if (!id) return "";
  const entry = models?.[id] ?? Object.entries(models ?? {}).find(([k, m]) => k && m?.resolvedModel === id)?.[1];
  if (entry?.label) return entry.label;
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
  return id;
}

/**
 * エフォートの段。efforts は core/effort.mjs の effortOptions の形。
 * 既定の段が分からない（resolvesTo が無い）ときは「既定」の段を作らない（本当の段ではないため）。
 * そのとき値が ''（既定に従う）なら unset: スライダーのつまみはどの段も指さない
 * @returns {{ stops: string[], def: string|null, current: string, unset: boolean }}
 */
export function effortStops(efforts, value) {
  const levels = Object.keys(efforts ?? {}).filter((k) => k !== "");
  const raw = efforts?.[""]?.resolvesTo ?? null;
  const def = raw && levels.includes(raw) ? raw : null;
  if (!levels.length) return { stops: [], def: null, current: "", unset: false };
  const current = value && levels.includes(value) ? value : def ?? "";
  return { stops: levels, def, current, unset: !current };
}

/** チップの字: 「Opus 5.5 · high」。段を持たないモデル・段が分からない（既定に従う）ときは名前だけ */
export function modelChipLabel(models, model, efforts, effort) {
  const { label } = resolvedModel(models, model);
  const { current } = effortStops(efforts, effort);
  return current ? `${label} · ${current}` : label;
}

/**
 * モデルの一覧に出す行の id。隠した行は選んでいるとき・既定のときだけ。
 * 段違いを系統（family）にまとめた一覧（antigravity。core/backends/antigravity-models.mjs）は、系統ごとに 1 行:
 * 選んでいる id > 既定の id > 表に出す id の順で、その系統を代表させる
 */
export function modelRowIds(models, value) {
  const def = models?.[""]?.resolvesTo;
  const ids = Object.keys(models ?? {}).filter((id) => id !== "" && (!models[id].hidden || id === value || id === def));
  const pick = new Map();   // family -> id
  for (const id of ids) {
    const family = models[id].family;
    if (!family) continue;
    const prev = pick.get(family);
    const rank = (x) => (x === value ? 0 : x === def ? 1 : models[x].hidden ? 3 : 2);
    if (prev === undefined || rank(id) < rank(prev)) pick.set(family, id);
  }
  return ids.filter((id) => !models[id].family || pick.get(models[id].family) === id);
}

/** 系統の中に既定の id があるか（系統の行に「既定」の札を付ける） */
export function holdsDefault(models, id) {
  const def = models?.[""]?.resolvesTo;
  if (!def) return false;
  return id === def || Boolean(models[id]?.family && models[id].family === models[def]?.family);
}

/** 系統と版で名乗るモデル（Claude の「Opus 5.5」）の系統。新しい版だけを上に出し、この形の一覧で知らない系統は「ほかのモデル」 */
const CLAUDE_FAMILIES = ["fable", "opus", "sonnet", "haiku"];
const newer = (a, b) => {
  const x = a.split(".").map(Number), y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/**
 * モデルの一覧を「上（今の世代）」と「ほかのモデル」に分ける（docs/design-system.md「入力欄の設定」）。
 * 分け方はエージェントの id ではなく一覧の中身で決める:
 * - 段違いを系統（family）にまとめた一覧（Antigravity）は分けない（系統の行がもう 1 つずつ）
 * - 系統と版で名乗る一覧（Claude。名前の頭が CLAUDE_FAMILIES）は、系統ごとに一番新しい版だけを上に、古い版と知らない系統は下へ。
 *   版の無い名前（取れなかったときの「Opus」）は上
 * - ほかは補足が「previous generation」「legacy」のものを下へ
 * 既定のモデル（系統）は常に上。quiet は下の行のうち補足を出さない行（系統で同じ補足・legacy の補足。名前だけで足りる）
 * @returns {{ main: string[], other: string[], quiet: Set<string> }}
 */
export function splitModelRows(models, ids) {
  const old = new Set();
  const familyOf = (id) => {
    const label = String(models?.[id]?.label ?? "");
    return { m: /^(\w+)\s+(\d+(?:\.\d+)?)/.exec(label), family: label.split(/\s/)[0].toLowerCase() };
  };
  if (ids.some((id) => models?.[id]?.family)) {
    // 系統にまとめた一覧は分けない
  } else if (ids.some((id) => CLAUDE_FAMILIES.includes(familyOf(id).family))) {
    const parsed = new Map(), top = new Map();
    for (const id of ids) {
      const { m, family } = familyOf(id);
      if (!CLAUDE_FAMILIES.includes(family)) { old.add(id); continue; }
      if (!m) continue;
      parsed.set(id, { family, version: m[2] });
      const prev = top.get(family);
      if (!prev || newer(m[2], prev)) top.set(family, m[2]);
    }
    for (const [id, p] of parsed) if (p.version !== top.get(p.family)) old.add(id);
  } else {
    for (const id of ids) if (/previous generation|legacy/i.test(String(models?.[id]?.note ?? ""))) old.add(id);
  }
  for (const id of ids) if (holdsDefault(models, id)) old.delete(id);
  const main = ids.filter((id) => !old.has(id)), other = ids.filter((id) => old.has(id));
  const noteOf = (id) => String(models?.[id]?.note ?? "");
  const quiet = new Set(other.filter((id) => {
    const note = noteOf(id);
    return !note || /legacy/i.test(note) || ids.some((x) => x !== id && noteOf(x) === note);
  }));
  return { main, other, quiet };
}

// ---------------------------------------------------------------- 使用量の棒

/**
 * エージェントの行（1 段目と一覧）に出す週の使用量。使用量の棒は、使用枠を決める行に 1 本だけ置く
 * （承認済み（2026-11-24）。docs/design-system.md「入力欄の設定」）。
 *   - アカウントの行がある面は、棒をアカウントの行だけにする。エージェントの行の値は「ログイン中」のもので、選んでいるアカウントとは別のものを指す
 *   - 互換の接続先はアカウントの枠を使わないので、その接続先で動くエージェントの行に棒を出さない
 *   - アカウントの行が無い面（アカウント未登録・アカウントの無いエージェント・スレッドの面）は、エージェントの行に 1 本
 * 今のエージェントは、面が出しているアカウントの行（d.accounts）と接続先（d.endpoint.row）で決める。
 * 一覧のほかのエージェントは d.backendHasAccounts(id)（アカウントを登録しているか。面にアカウントの行が無ければ渡さない）で決める。
 * @param {{ backend?: string, accounts?: any[]|null, endpoint?: { row?: any }|null, backendUsage?: (id: string) => any, backendHasAccounts?: (id: string) => boolean }} d
 * @returns {{ used: number, high: boolean }|null} 棒を出さないときは null
 */
export function agentRowUsage(d, id) {
  const held = id === d.backend ? Boolean(d.endpoint?.row || d.accounts) : Boolean(d.backendHasAccounts?.(id));
  return held ? null : d.backendUsage?.(id) ?? null;
}

// ---------------------------------------------------------------- 接続先

/** 長い字を真ん中で詰める（モデル ID は頭と末尾で見分けることが多い） */
export function middleEllipsis(text, max) {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) / 2), tail = Math.floor((max - 1) / 2);
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

/**
 * 接続先を選ぶエージェントのモデルのチップの字: 「接続先 · モデル」（段が決まっていれば「 · 段」）。
 * 接続先の名前とモデル ID はそれぞれ長さを詰め、段は削らない（末尾が切れると段が見えなくなるため）。
 * 全体の字は title に出す（full。モデルは省かない元の ID）。
 * head は「接続先 · モデル」まで、tail は段（札をモデルの直後に挟むため。text は head と tail をつないだもの）
 * @returns {{ text: string, full: string, head: string, tail: string }}
 */
export function endpointChipLabel({ connection, model, fullModel, effort } = {}) {
  // model はチップに出す表示名（web/compat-models.mjs の compatModelLabel）、fullModel は title に出す送る ID
  const parts = [connection || t("composer.endpoint.pick"), fullModel || model, effort].filter(Boolean);
  const full = parts.join(" · ");
  const head = [middleEllipsis(connection || t("composer.endpoint.pick"), 18), model ? middleEllipsis(model, 26) : ""].filter(Boolean).join(" · ");
  const tail = effort || "";
  return { text: [head, tail].filter(Boolean).join(" · "), full, head, tail };
}
