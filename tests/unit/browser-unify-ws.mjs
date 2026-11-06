import { createBrowserUnifyWs, isBrowserUnifyCommand } from '../../core/browser-unify-ws.mjs';
import { COMMANDS } from '../../core/protocol.mjs';
import { commandAllowed, COMMAND_ACCESS } from '../../core/review-mode.mjs';

export const name = 'browser-unify-ws';
export const title = 'ブラウザーの一本化の WS のコマンド（vizOnce: 可視化の「一度だけ読み込む」の印）';

export default async function (t) {
  const asked = [];
  const ws = createBrowserUnifyWs({ isolatedRoutes: { once: origins => { asked.push(origins); return origins.length ? 'TOKEN123456A' : null; } } });
  const got = await ws.handle({ command: 'vizOnce', args: { origins: ['https://cdn.example'] } });
  t.ok('vizOnce は隔離の経路の once に出どころを渡し、印を返す', got.token === 'TOKEN123456A' && asked[0][0] === 'https://cdn.example');
  const refused = await Promise.all([{}, { origins: 'https://a.example' }, { origins: [1] }, { origins: Array(51).fill('https://a.example') }, { origins: ['x'.repeat(2049)] }]
    .map(args => ws.handle({ command: 'vizOnce', args }).then(() => null, e => e.code)));
  t.ok('形の違う origins（無い・文字列・数・51 個・長すぎ）は INVALID で断る', refused.every(code => code === 'INVALID') && asked.length === 1);
  const none = await createBrowserUnifyWs({}).handle({ command: 'vizOnce', args: { origins: ['https://a.example'] } });
  t.ok('隔離の経路が無ければ印は null（画面は srcdoc で描く）', none.token === null);
  const unknown = await ws.handle({ command: 'nope', args: {} }).then(() => null, e => e.code);
  t.ok('知らないコマンドは UNKNOWN_COMMAND', unknown === 'UNKNOWN_COMMAND' && !isBrowserUnifyCommand('nope'));
  t.ok('vizOnce は protocol の COMMANDS にあり、審査モードでは断る（振り分けに載っている）',
    isBrowserUnifyCommand('vizOnce') && COMMANDS.has('vizOnce') && COMMAND_ACCESS.vizOnce === false && !commandAllowed('vizOnce'));
}
