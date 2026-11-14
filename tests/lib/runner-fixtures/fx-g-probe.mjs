import fs from "node:fs";
import path from "node:path";
import { N } from "../dom-stub.mjs";
import { state } from "./fx-g-state.mjs";
export const name = "fx-g-probe";
export const title = "ランナーの試験用: fx-g-dirty の後に流れて、global・document・process.env に何が残っているかを記録する";

const own = (object, key) => Object.hasOwn(object, key);

export default async function (t) {
  // 「suite の前の状態」と違うまま残っているもの（leaks）と、残すと決めたとおり残っているもの（kept）を、形ごとの名前で記録する
  const leaks = [];
  const kept = [];
  const leak = (condition, label) => { if (condition) leaks.push(label); };
  const keep = (condition, label) => { if (condition) kept.push(label); };
  const doc = state.document;   // fx-g-dirty が始める前の document（globalThis.document が替えられていても、元の物の中身を見る）

  leak(own(globalThis, "__fxGAdded"), "global:add");
  leak(own(globalThis, "__fxGHollow") || "__fxGHollow" in globalThis, "global:add-hollow");
  leak(own(globalThis, Symbol.for("fx.g.sym")), "global:add-symbol");
  leak(globalThis.__fxGRemoved !== "removed-original", "global:remove");
  leak(globalThis.__fxGSwapped?.gen !== "original", "global:swap-value");
  leak(Object.getOwnPropertyDescriptor(globalThis, "__fxGDescriptor")?.value !== "descriptor-original", "global:swap-descriptor");

  leak(!doc || own(doc, "fxDocAdded"), "document:add");
  leak(!doc || own(doc, "fxDocHollow"), "document:add-hollow");
  leak(!doc || typeof doc.createElementNS !== "function", "document:remove");
  leak(!doc || !(doc.createElement("x") instanceof N), "document:swap");
  leak(globalThis.document !== doc, "document:replace-object");
  leak(globalThis.location !== state.location, "location:replace-object");

  leak(own(N.prototype, "fxProtoAdded"), "proto:add");
  leak(String(N.prototype.matches).includes("proto-swapped"), "proto:swap");
  leak(typeof N.prototype.after !== "function", "proto:remove");

  leak("FX_G_ADDED" in process.env, "env:add");
  leak(process.env.FX_G_REMOVED !== "env-removed-original", "env:remove");
  leak(process.env.FX_G_CHANGED !== "env-changed-original", "env:change");

  keep(own(globalThis, "__zod_globalConfig"), "keep:zod-config");
  keep(own(globalThis, "__zod_globalRegistry"), "keep:zod-registry");
  keep(own(globalThis, Symbol.for("graceful-fs.queue")), "keep:graceful-fs");
  keep(own(globalThis, Symbol.for("undici.globalDispatcher.1")), "keep:undici");
  keep("NoDefaultCurrentDirectoryInExePath" in process.env, "keep:env");
  keep(own(globalThis, "__fxGSticky"), "keep:sticky");

  fs.writeFileSync(path.join(process.env.RUNNER_FIXTURE_OUT, "g-probe.json"), JSON.stringify({ pid: process.pid, inWorker: typeof process.send === "function", leaks, kept }));
  t.ok("記録した", true);
}
