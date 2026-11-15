// 試験 context-doc-main-equivalence と context-doc-main-touch-<組> の中身。
// 指示・Skills の名前 × エージェントの表（ADR 0337）が、旧い保存（context-scans.json）の動きを変えていないかを、
// main の実装で採った記録（tests/fixtures/context-doc-main-plans.json。tests/lib/record-main-doc-plans.mjs で作る）と突き合わせる。
//
// A. 触っていない人: 旧い保存の組み合わせ × 作業場所 × 6 エージェントの計画（起動の設定・Pleiad が渡す物）が main と同じ
// B. 表の初期のマス: 設定（全体）と右の欄（作業場所）のマスのオン／オフが、main でそのエージェントが実際に見ていた物と同じ
// C/D. 押せるマスを 1 つずつ押す: 押したマスの物だけ、そのエージェントの見え方が変わり（ほかのエージェント・ほかの物は変わらない）、
//      押した後の表とエージェントの見え方がそろう。押し戻すと、main と同じ見え方に戻る
//
// 「見え方」は tests/lib/context-doc-fixture.mjs の sees（起動の設定からエージェントが見る物を出す見立て）で、
// 新しいコードの判定（core/backends/context-capabilities.mjs）とは別に書いてある。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  AGENT_IDS, COMBOS, CWDS, DOC_KINDS, keyOf, loadTree, makeFixture, planTurn, recordPlans, sees, tokenizer, writeCombo,
} from './context-doc-fixture.mjs';
import { ROOT } from './server.mjs';

const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'context-doc-main-plans.json');
// 押して確かめる組み合わせ（旧「任せる」・旧「Pleiad がそろえる」・場所ごとの上書き・除外・追加の場所）。
// 1 組で 1 本の試験（context-doc-main-touch-<組>）にする（1 組を押し切るのに、ほかの試験と並べて 20〜50 秒かかる。まとめると 1 本の上限に収まらない）。
// 足すときは、ここと同じ名前の試験を tests/unit に作り、tests/run.mjs に入れる
export const TOUCH_COMBOS = ['default', 'instPly', 'skillPly', 'bothPly', 'placePly', 'instPlyExclude', 'skillPlyExclude', 'bothPlyRoots'];
const MAX_DETAIL = 12;

/**
 * plans: A と B を確かめる。touch: C/D で押して確かめる組み合わせ（TOUCH_COMBOS の中の物）
 */
export async function runEquivalence(t, { plans = false, touch = [] } = {}) {
  const recorded = JSON.parse(await fs.readFile(FIXTURE, 'utf8'));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ply-doc-eq-')));
  try {
    const fx = await makeFixture(root);
    const tree = await loadTree(ROOT);
    t.ok('記録は main で採ったもの（recordedFrom がある）', typeof recorded.recordedFrom === 'string' && recorded.recordedFrom.length >= 7, recorded.recordedFrom);

    if (plans) {
      // 押して確かめる組み合わせが、どれも 1 本の試験として登録されている（分けたせいで抜けた組み合わせが無い）
      const runner = await fs.readFile(path.join(ROOT, 'tests', 'run.mjs'), 'utf8');
      const missing = TOUCH_COMBOS.filter(c => !runner.includes(`'./unit/context-doc-main-touch-${c}.mjs'`));
      t.ok(`C/D の組み合わせ ${TOUCH_COMBOS.length} 組が、どれも試験に登録されている`, missing.length === 0, missing.join(', '));
    }

    // ---- A ----
    if (plans) {
    const now = await recordPlans(ROOT, fx, { glue: 'tree' });
    t.ok('A: エージェントが自分で読む物（native）の探索が main と同じ', isDeepStrictEqual(now.native, recorded.native));
    {
      const diffs = [];
      for (const combo of Object.keys(COMBOS)) for (const cwd of Object.keys(CWDS)) for (const agent of AGENT_IDS) {
        const a = now.plans[combo]?.[cwd]?.[agent], b = recorded.plans[combo]?.[cwd]?.[agent];
        if (!isDeepStrictEqual(a, b)) diffs.push(`${combo}/${cwd}/${agent}: ${Object.keys({ ...a, ...b }).filter(k => !isDeepStrictEqual(a?.[k], b?.[k])).join(',')}`);
      }
      t.ok(`A: 触っていない人の計画が main と同じ（${Object.keys(COMBOS).length} 組 × 作業場所 2 × エージェント 6）`, diffs.length === 0, diffs.slice(0, MAX_DETAIL).join(' / '));
    }
    }

    const mainSees = (combo, cwd, agent) => sees(agent, recorded.native[cwd][agent], recorded.plans[combo][cwd][agent]);
    const WS = tree.agentsMod.WORKSPACE_SUMMARY_KEY;
    // 固定の木 1 つ分の道具（C/D は組み合わせごとに別の木で並べて走らせる）
    const bind = (fx) => {
      const tok = tokenizer(fx);
      // Codex の app-server が返す Skills（native と同じ。記録は <R> なので今の根に戻す）
      const untok = p => path.normalize(p.replace('<R>', fx.root.replace(/\\/g, '/')));
      const nativeCodexPaths = Object.fromEntries(Object.keys(CWDS).map(c => [c, recorded.native[c].codex.skill.map(s => untok(s.path))]));
      const treeSees = async (cwd, agent) => {
        const plan = tok(await planTurn(tree, fx, { cwd: CWDS[cwd](fx), agent, codexSkillPaths: nativeCodexPaths[cwd], glue: 'tree' }));
        return sees(agent, recorded.native[cwd][agent], plan);
      };
      // 作業場所 2 × エージェント 6 の見え方（読むだけなので並べて採る）
      const allSees = async () => {
        const pairs = Object.keys(CWDS).flatMap(c => AGENT_IDS.map(a => [c, a]));
        const got = await Promise.all(pairs.map(([c, a]) => treeSees(c, a)));
        const out = Object.fromEntries(Object.keys(CWDS).map(c => [c, {}]));
        pairs.forEach(([c, a], i) => { out[c][a] = got[i]; });
        return out;
      };
      const settings = tree.settings.createContextSettings(fx.dataDir, fx.home);
      const docAgents = tree.agentsMod.createContextAgents(fx.dataDir);
      // core/server.mjs の docScanContext と同じ手順で表を作る（view: 'default' = 設定の全体、'repo'/'sub' = その作業場所の右の欄）
      const docView = async (kind, view) => {
        const isDefault = view === 'default';
        const scanDir = isDefault ? fx.home : CWDS[view](fx);
        const effective = await settings.get(scanDir, isDefault ? { level: 'default' } : {});
        const plan = tree.matrixMod.docScanPlan(effective.plan, kind);
        const scan = await tree.scan.scanContext({ cwd: scanDir, plan }, { ...fx.scanOptions, plyServers: null, scopes: isDefault ? ['user'] : ['user', 'directory'] });
        const [raw, cfg] = await Promise.all([settings.read(), docAgents.read()]);
        const matrixCwd = isDefault ? null : scanDir;
        const matrix = tree.matrixMod.buildDocMatrix({ kind, entries: scan.entries, legacyConfig: raw, docAgentsConfig: cfg, cwd: matrixCwd, home: scan.home });
        return { scan, raw, matrix, scanDir, matrixCwd, isDefault };
      };
      // 1 回押す（core/server.mjs の setDocAgent / setDocRow と同じ: applyDocTouch → 場所を保存）。v は押す直前の表
      const press = async (kind, v, { key, agent, on }) => {
        const place = v.isDefault ? null : v.scanDir;
        await docAgents.mutate(async cfg => tree.matrixMod.applyDocTouch(cfg, {
          kind, entries: v.scan.entries, legacyConfig: await settings.read(), matrixCwd: v.matrixCwd, home: v.scan.home,
          place, placeKey: place ? tree.settings.pathKey(place) : null, agent: agent ?? null, keys: [key], on,
        }));
        if (place) {
          const cur = await settings.view(place);
          if (!cur.places.some(p => p.saved && tree.settings.pathKey(p.path) === tree.settings.pathKey(place))) await settings.set({ place, add: true, cwd: v.scanDir });
        }
      };
      // 行の名前（指示は同じ名前が多いので、置き場を添える）
      const rowLabel = (kind, row) => row.key === WS ? '作業場所の行' : kind === 'skill' ? `${row.name}(${row.scope})` : tok(row.chosen?.path ?? row.name);
      // 行が表す物の鍵（指示は実体のパス、Skills は名前）。同じ物の写しも含める
      const rowKeys = (kind, row) => kind === 'skill'
        ? [row.name]
        : [...new Set([row.chosen, ...(row.duplicates ?? [])].map(c => keyOf(tok(c.realPath ?? c.path))))];
      const seen = (kind, row, s) => rowKeys(kind, row).some(k => s[kind].includes(k));
      // 表（作業場所の欄）とエージェントの見え方がそろっているか
      const consistency = (kind, matrix, seesOf, label, out) => {
        for (const row of matrix.rows) for (const agent of AGENT_IDS) {
          const on = Boolean(row.cells[agent]?.on);
          if (on !== seen(kind, row, seesOf[agent])) out.push(`${label} ${rowLabel(kind, row)}/${agent}: 表=${on ? 'オン' : 'オフ'} 見え=${on ? 'なし' : 'あり'}`);
        }
      };
      return { tok, allSees, settings, docAgents, docView, press, rowLabel, rowKeys, consistency };
    };
    // 作業場所の物（右の欄では行、全体では「作業場所の指示・Skills」の 1 行にまとまる物）
    const workspaceKeys = (kind, cwd) => {
      const out = new Set();
      for (const agent of AGENT_IDS) for (const e of recorded.native[cwd][agent][kind]) {
        if (e.scope !== 'user') out.add(kind === 'skill' ? e.name : keyOf(e.realPath));
      }
      return out;
    };

    // ---- B ----
    if (plans) {
      const { docView, rowKeys, consistency } = bind(fx);
      for (const combo of Object.keys(COMBOS)) {
        await writeCombo(fx, combo);
        const diffs = [];
        for (const kind of DOC_KINDS) {
          // 作業場所の右の欄: 行のマス ⇔ その作業場所で main のエージェントが見ていた物
          for (const cwd of Object.keys(CWDS)) {
            const { matrix } = await docView(kind, cwd);
            const main = Object.fromEntries(AGENT_IDS.map(a => [a, mainSees(combo, cwd, a)]));
            consistency(kind, matrix, main, `${kind}@${cwd}`, diffs);
            // main で見ていたのに、表に行が無い物
            for (const agent of AGENT_IDS) for (const k of main[agent][kind]) {
              if (!matrix.rows.some(r => rowKeys(kind, r).includes(k))) diffs.push(`${kind}@${cwd} ${agent}: 表に無い ${k}`);
            }
          }
          // 設定の全体: ユーザーの段の行 ⇔ 作業場所 repo（場所の上書きが無い所）で main のエージェントが見ていた物
          const { matrix } = await docView(kind, 'default');
          const main = Object.fromEntries(AGENT_IDS.map(a => [a, mainSees(combo, 'repo', a)]));
          consistency(kind, matrix, main, `${kind}@全体`, diffs);
          // 「作業場所の指示・Skills」の行: オン ⇔ そのエージェントが作業場所の物を 1 つ以上見ていた
          const ws = workspaceKeys(kind, 'repo');
          for (const agent of AGENT_IDS) {
            const on = Boolean(matrix.summaryRow.cells[agent]?.on);
            const any = main[agent][kind].some(k => ws.has(k));
            if (on !== any) diffs.push(`${kind}@全体 作業場所の行/${agent}: 表=${on ? 'オン' : 'オフ'} 見え=${any ? 'あり' : 'なし'}`);
          }
        }
        t.ok(`B: ${combo}: 表の初期のマスが main で見ていた物と同じ`, diffs.length === 0, `${diffs.length} 件: ${diffs.slice(0, MAX_DETAIL).join(' / ')}`);
      }
    }

    // ---- C/D ----（組み合わせごとに別の木を作り、並べて走らせる。1 つの組み合わせの中の押し方は順番どおり）
    const touchCombo = async (combo) => {
      const cfx = await makeFixture(path.join(root, `touch-${combo}`));
      const { allSees, docView, press, rowLabel, consistency } = bind(cfx);
      const baseline = Object.fromEntries(Object.keys(CWDS).map(c => [c, Object.fromEntries(AGENT_IDS.map(a => [a, mainSees(combo, c, a)]))]));
      const fails = [];
      let presses = 0;
      for (const kind of DOC_KINDS) {
        for (const view of ['default', 'repo']) {
          await writeCombo(cfx, combo);
          // 押す前の表（毎回 writeCombo で同じ保存に戻すので、押す直前の表もこれと同じ）
          const start = await docView(kind, view);
          const targets = [...(view === 'default' ? [start.matrix.summaryRow] : []), ...start.matrix.rows];
          for (const row of targets) {
            // 設定の全体はマスごと、右の欄は行のスイッチ（全エージェント一括）
            const actions = view === 'default'
              ? AGENT_IDS.filter(a => !row.cells[a].locked).map(a => ({ agent: a }))
              : (row.rowLocked ? [] : [{ agent: null }]);
            for (const { agent } of actions) {
              await writeCombo(cfx, combo);
              const label = `${kind}@${view === 'default' ? '全体' : view} ${rowLabel(kind, row)}${agent ? `/${agent}` : '/行'}`;
              const nextOn = agent ? !row.cells[agent].on : !row.rowSwitchOn;
              presses++;
              await press(kind, start, { key: row.key, agent, on: nextOn });
              // 押したマス（行）が変わり、同じ表のほかの行は変わらない
              const after = await docView(kind, view);
              const rowAfter = row.key === WS ? after.matrix.summaryRow : after.matrix.byKey.get(row.key);
              const changedAgents = AGENT_IDS.filter(a => rowAfter.cells[a].on !== row.cells[a].on);
              if (agent ? !isDeepStrictEqual(changedAgents, [agent]) : !changedAgents.length) fails.push(`${label}: 押したのにマスが ${JSON.stringify(changedAgents)} だけ変わった`);
              for (const r of start.matrix.rows) {
                if (r.key === row.key) continue;
                const ra = after.matrix.byKey.get(r.key);
                const moved = AGENT_IDS.filter(a => ra?.cells[a].on !== r.cells[a].on);
                if (moved.length && !(row.key === WS && r.scope !== 'user')) fails.push(`${label}: ほかの行 ${rowLabel(kind, r)} も ${moved.join(',')} が変わった`);
              }
              // エージェントの見え方: 押した物だけ、押したエージェントだけ変わる。両方の種類・両方の作業場所の表とそろう
              const [got, ...placeViews] = await Promise.all([
                allSees(),
                ...Object.keys(CWDS).flatMap(c => DOC_KINDS.map(k => docView(k, c).then(v => ({ c, k, v })))),
              ]);
              for (const { c, k, v } of placeViews) consistency(k, v.matrix, got[c], `${label} → ${k}@${c}`, fails);
              for (const c of Object.keys(CWDS)) for (const a of AGENT_IDS) {
                const otherKind = kind === 'skill' ? 'instruction' : 'skill';
                if (!isDeepStrictEqual(got[c][a][otherKind], baseline[c][a][otherKind])) fails.push(`${label}: 別の種類 ${otherKind}@${c}/${a} も変わった`);
                if (agent && a !== agent && !isDeepStrictEqual(got[c][a][kind], baseline[c][a][kind])) fails.push(`${label}: ほかのエージェント ${a}@${c} の見え方も変わった`);
              }
              // 押したのに、どの作業場所でも誰の見え方も変わらない（押しても効かないマス）
              const changedAnywhere = Object.keys(CWDS).some(c => AGENT_IDS.some(a => !isDeepStrictEqual(got[c][a][kind], baseline[c][a][kind])));
              if (!changedAnywhere) fails.push(`${label}: 押しても見え方が変わらない`);
              // 押し戻すと main と同じ
              await press(kind, after, { key: row.key, agent, on: !nextOn });
              const back = await allSees();
              for (const c of Object.keys(CWDS)) for (const a of AGENT_IDS) {
                if (!isDeepStrictEqual(back[c][a], baseline[c][a])) fails.push(`${label}: 押し戻しても ${a}@${c} が main と違う`);
              }
            }
          }
        }
      }
      return { combo, fails, presses };
    };
    for (const { combo, fails, presses } of await Promise.all(touch.map(touchCombo))) {
      t.ok(`C/D: ${combo}: 押せるマス（${presses} 回）がそれぞれ効き、表と見え方がそろい、押し戻すと main と同じ`, fails.length === 0 && presses > 0, `${fails.length} 件: ${fails.slice(0, MAX_DETAIL).join(' / ')}`);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}
