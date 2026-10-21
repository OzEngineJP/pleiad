/** 遅い履歴要求だけを 1 行で記録する。段階は重なる（transcript 内の read / extras など）。 */
export function createLoadTiming({ now = () => performance.now(), log = line => console.log(line), threshold = 200 } = {}) {
  const started = now(), stages = {};
  const add = (stage, ms) => { stages[stage] = (stages[stage] ?? 0) + ms; };
  return {
    add,
    async run(stage, work) {
      const start = now();
      try { return await work(); } finally { add(stage, now() - start); }
    },
    finish(mode) {
      const total = now() - started;
      if (total >= threshold) log(`  [loadSession] ${JSON.stringify({ mode, totalMs: Math.round(total),
        ...Object.fromEntries(Object.entries(stages).map(([key, ms]) => [key, Math.round(ms)])) })}`);
    },
  };
}
