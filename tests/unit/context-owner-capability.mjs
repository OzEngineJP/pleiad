// 会話の場所別コンテキスト設定は、実装された能力だけを選べる。保存済みの設定は表示を保つ。
import { setupSessionContext } from '../../web/session-context.mjs';
import { N } from '../lib/dom-stub.mjs';

export const name = 'context-owner-capability';
export const title = 'Pleiad コンテキスト非対応の会話は担当を選べず、保存済みの担当と理由を表示する';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const nodes = (root) => [root, ...root.children.flatMap(nodes)];

export default async function (t) {
  const { lang: originalLanguage, setLanguage } = await import('../../web/i18n.mjs');
  const saved = { document: globalThis.document, window: globalThis.window, raf: globalThis.requestAnimationFrame };
  globalThis.document = {
    createElement: tag => new N(tag), createElementNS: (_ns, tag) => new N(tag),
    createTextNode: text => { const node = new N('span'); node.textContent = text; return node; }, querySelector: () => null,
  };
  globalThis.window = { addEventListener() {} };
  globalThis.requestAnimationFrame = fn => fn();
  try {
    await setLanguage('ja');
    for (const capability of [false, 'turn']) for (const owner of ['native', 'ply']) {
      let body, opened = false, writes = 0, resolveBackends;
      const backends = new Promise(resolve => { resolveBackends = resolve; });
      const kinds = Object.fromEntries(['instruction', 'skill', 'mcp'].map(kind => [kind, { value: { owner, user: null, directory: null } }]));
      const view = { defaults: { kinds }, places: [{ current: true, saved: false, kinds, roots: {} }] };
      const cmd = async (command) => {
        if (command === 'backends') return backends;
        if (command === 'contextSettings') return view;
        if (command === 'setContextSettings') { writes++; return view; }
        if (command === 'nativeInstructions' || command === 'scanContext') return { entries: [] };
        return {};
      };
      const panel = setupSessionContext({ cmd, preview: {
        panelOpen: () => opened, openPanel: opts => { opened = true; body = opts.body; },
        updatePanel: (_key, opts) => { body = opts.body; },
      }, session: () => ({ id: 'session', backend: 'agent-under-test', cwd: '/project' }), labelOf: () => 'Example Agent',
      info: () => ({ report: { status: 'native', cwd: '/project', entries: [] }, owners: { instruction: owner, skill: owner, mcp: owner } }),
      refreshInfo() {}, openSettings() {} });
      panel.open();
      await settle();
      await nodes(body).find(n => n.dataset?.act === 'placeStart').onclick();
      await settle();
      const choices = () => nodes(body).filter(n => n.dataset?.owner?.endsWith(':ply') && !n.dataset.owner.startsWith('hooks:'));
      t.ok(`能力の確認待ちは Pleiad 担当を選べない（${capability}/${owner}）`, choices().length === 3 && choices().every(n => n.disabled));
      resolveBackends([{ id: 'agent-under-test', capabilities: { plyContext: capability } }]);
      await settle();
      const unavailable = capability === false;
      t.ok(`能力から担当の選べる状態を決める（${capability}/${owner}）`, choices().length === 3 && choices().every(n => Boolean(n.disabled) === unavailable));
      t.ok(`保存済みの担当の選択表示を保つ（${capability}/${owner}）`, choices().every(n => n.getAttribute('aria-checked') === String(owner === 'ply')) && writes === 0);
      if (unavailable) {
        t.ok(`非対応の理由と設定を保持する説明が出る（${owner}）`, body.textContent.includes('Example Agent') && body.textContent.includes('保存済みの担当は保持'));
        for (const choice of choices()) choice.onclick();
        await settle();
        t.ok(`無効な選択は設定を書き換えない（${owner}）`, writes === 0);
      }
    }
    const invalidReplies = [
      ['reject', () => { throw new Error('offline'); }],
      ['non-array', () => ({})],
      ['empty', () => []],
      ['missing-backend', () => [{ id: 'another-agent', capabilities: { plyContext: 'turn' } }]],
      ['missing-capability', () => [{ id: 'agent-under-test', capabilities: {} }]],
    ];
    for (const [label, reply] of invalidReplies) {
      let body, opened = false, writes = 0, requests = 0;
      const kinds = Object.fromEntries(['instruction', 'skill', 'mcp'].map(kind => [kind, { value: { owner: 'ply', user: null, directory: null } }]));
      const view = { defaults: { kinds }, places: [{ current: true, saved: false, kinds, roots: {} }] };
      const cmd = async (command) => {
        if (command === 'backends') { requests++; return requests === 1 ? reply() : [{ id: 'agent-under-test', capabilities: { plyContext: 'conversation' } }]; }
        if (command === 'contextSettings') return view;
        if (command === 'setContextSettings') { writes++; return view; }
        if (command === 'nativeInstructions' || command === 'scanContext') return { entries: [] };
        return {};
      };
      const panel = setupSessionContext({ cmd, preview: {
        panelOpen: () => opened, openPanel: opts => { opened = true; body = opts.body; }, updatePanel: (_key, opts) => { body = opts.body; },
      }, session: () => ({ id: 'session', backend: 'agent-under-test', cwd: '/project' }), labelOf: () => 'Example Agent',
      info: () => ({ report: { status: 'native', cwd: '/project', entries: [] }, owners: { instruction: 'ply', skill: 'ply', mcp: 'ply' } }),
      refreshInfo() {}, openSettings() {} });
      panel.open(); await settle();
      await nodes(body).find(n => n.dataset?.act === 'placeStart').onclick(); await settle();
      const choices = () => nodes(body).filter(n => n.dataset?.owner?.endsWith(':ply') && !n.dataset.owner.startsWith('hooks:'));
      t.ok(`不完全な能力応答では担当を選べず理由と再試行を出す（${label}）`, choices().length === 3 && choices().every(n => n.disabled)
        && body.textContent.includes('受け取れるか確認できません') && nodes(body).some(n => n.tagName === 'BUTTON' && n.textContent === '再試行'));
      t.ok(`能力が不明でも保存済み担当は保持する（${label}）`, choices().every(n => n.getAttribute('aria-checked') === 'true') && writes === 0);
      for (const choice of choices()) choice.onclick(); await settle();
      t.ok(`能力が不明な選択は設定を書かない（${label}）`, writes === 0);
      nodes(body).find(n => n.tagName === 'BUTTON' && n.textContent === '再試行').onclick(); await settle();
      t.ok(`再試行で対応が分かれば選択できる（${label}）`, requests === 2 && choices().every(n => !n.disabled) && !body.textContent.includes('受け取れるか確認できません'));
      t.ok(`再試行の成功でも保存済み担当を変更しない（${label}）`, choices().every(n => n.getAttribute('aria-checked') === 'true') && writes === 0);
    }
  } finally {
    await setLanguage(originalLanguage);
    globalThis.document = saved.document; globalThis.window = saved.window; globalThis.requestAnimationFrame = saved.raf;
  }
}
