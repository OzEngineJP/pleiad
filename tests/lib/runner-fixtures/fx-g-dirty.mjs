import fs from "node:fs";
import path from "node:path";
import { N } from "../dom-stub.mjs";
import { state } from "./fx-g-state.mjs";
export const name = "fx-g-dirty";
export const title = "ランナーの試験用: globalThis・document・N.prototype・process.env に、足す・消す・替えるの残りものをする suite（次の fx-g-probe に届かないことの確認）";

// 読み込み時（suite の本体の前）に置くもの。ランナーが控えるのは本体が動いている間だけなので、これは「suite の前からあったもの」になり、本体が消す・替えるのを戻す対象になる
globalThis.__fxGRemoved = "removed-original";
globalThis.__fxGSwapped = { gen: "original" };
Object.defineProperty(globalThis, "__fxGDescriptor", { value: "descriptor-original", writable: true, enumerable: false, configurable: true });
process.env.FX_G_REMOVED = "env-removed-original";
process.env.FX_G_CHANGED = "env-changed-original";
// 試験を流しているシェルが継いでいるかもしれない名前（Claude Code や Pleiad のシェルは持つ）を、この suite の前には無い状態にする。
// 本体が足す形（KEEP_ENV の項目が「足された」）を、手元のシェルの環境に関わらず同じにするため
delete process.env.NoDefaultCurrentDirectoryInExePath;

export default async function (t) {
  state.document = globalThis.document;
  state.location = globalThis.location;

  // globalThis: 足す（値あり・値が undefined・Symbol）・消す・替える（値・記述子）
  globalThis.__fxGAdded = "added-by-dirty";
  globalThis.__fxGHollow = undefined;   // 元の不具合の形（代入で戻したつもりの `globalThis.CSS = undefined`）
  globalThis[Symbol.for("fx.g.sym")] = "sym-by-dirty";
  delete globalThis.__fxGRemoved;
  globalThis.__fxGSwapped = { gen: "replaced" };
  Object.defineProperty(globalThis, "__fxGDescriptor", { get() { return "descriptor-replaced"; }, configurable: true });

  // 試験用の document（代役）の自前の項目: 足す・消す・替える
  document.fxDocAdded = "doc-added";
  document.fxDocHollow = undefined;
  delete document.createElementNS;
  document.createElement = () => "doc-swapped";
  // document・location 自体を別の物に替える（installDomStub() をもう一度呼ぶ suite の形）
  globalThis.document = { createElement: () => "doc-replaced" };
  globalThis.location = new URL("http://replaced.invalid/");

  // 代役の要素のプロトタイプ: 足す・消す・替える
  N.prototype.fxProtoAdded = () => "proto-added";
  N.prototype.matches = () => "proto-swapped";
  delete N.prototype.after;

  // 環境変数: 足す・消す・替える
  process.env.FX_G_ADDED = "env-added";
  delete process.env.FX_G_REMOVED;
  process.env.FX_G_CHANGED = "env-changed";
  // ライブラリが最初に読まれたとき 1 回だけ足す環境変数（KEEP_ENV）。Claude の SDK は、読み込まれたときに同じ名前へ "1" を代入する（形だけ写す）
  process.env.NoDefaultCurrentDirectoryInExePath = "1";

  // ライブラリが最初に読まれたとき 1 回だけ足す項目（KEEP_GLOBALS）。suite が最初に読み込んでしまう形。zod は本物を読む
  await import("zod");
  // graceful-fs が足す項目と同じ形（同じ Symbol・getter だけの configurable でない項目）。本物を読むと fs を書き換えてしまうので、形だけ写す
  const queue = Symbol.for("graceful-fs.queue");
  if (!Object.hasOwn(globalThis, queue)) Object.defineProperty(globalThis, queue, { get() { return []; } });
  // undici（Node の fetch）が足す項目と同じ形（同じ Symbol・設定不可の値の項目）。本物の fetch を使うと接続の部品まで作るので、形だけ写す。
  // Node 24 は控えるための記述子の読みで先に読み込まれていて、ここでは足さない（Node 22 は suite の本体が初めて使う）
  const dispatcher = Symbol.for("undici.globalDispatcher.1");
  if (!Object.hasOwn(globalThis, dispatcher)) Object.defineProperty(globalThis, dispatcher, { value: { simulatedBy: "fx-g-dirty" }, writable: true, enumerable: false, configurable: false });

  // 戻せないもの（configurable でない）。戻せなくても suite の結果は変わらず、知らせる行に名前が出る
  Object.defineProperty(globalThis, "__fxGSticky", { value: "sticky", configurable: false });

  fs.writeFileSync(path.join(process.env.RUNNER_FIXTURE_OUT, "g-dirty.json"), JSON.stringify({ pid: process.pid, inWorker: typeof process.send === "function" }));
  t.ok("global・document・process.env を汚した", true);
  t.ok("ライブラリの global を足した", Object.hasOwn(globalThis, "__zod_globalConfig"));
}
