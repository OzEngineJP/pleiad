// コンテキストの画面の小さな部品（DOM を使わない部分）。
//   - 開始時と今の差分（行単位）
//   - MCP の追加シートのコマンドの分け方
import { placeStatus } from '../../web/session-context.mjs';
import { lineDiff } from '../../web/line-diff.mjs';
import { estimateTokens } from '../../web/token-estimate.mjs';
import { splitCommand, joinCommand } from '../../web/mcp-config.mjs';

export const name = 'context-ui';
export const title = 'この会話のコンテキストの作業場所の一言・差分・MCP のコマンドの分け方';

export default function (t) {
  // 右パネルの作業場所の面の一言（contextSettings の今の場所から）
  const place = (overrides, from = null, saved = true) => ({ saved, overrides, kinds: { instruction: { from }, skill: { from: null }, mcp: { from: null } }, roots: { instruction: { from: null }, skill: { from: null }, mcp: { from: null } } });
  t.ok('上書きが無ければ「全体の設定どおり」', placeStatus(place(0)).text === '全体の設定どおり' && !placeStatus(place(0)).over && placeStatus(null).text === '全体の設定どおり');
  t.ok('このフォルダーだけの上書きは数を添えて青い字', placeStatus(place(2)).text === 'このフォルダーだけの設定 · 2 項目' && placeStatus(place(2)).over);
  t.ok('上の場所の上書きに従っていれば、その場所の名前', placeStatus(place(0, 'D:\\dev', false)).text === 'D:\\dev の設定どおり', placeStatus(place(0, 'D:\\dev', false)).text);

  // トークン数の見積もり（設定の画面とサーバーで同じ数）
  t.ok('英数字は 4 文字で 1、それ以外は 1 文字で 1', estimateTokens('abcdefgh') === 2 && estimateTokens('日本語') === 3 && estimateTokens('') === 0 && estimateTokens('ab 日本') === 3);

  const ops = lineDiff('a\nb\nc\nd', 'a\nB\nc\nd\ne');
  t.ok('変わった行だけ − / + にする', ops.map(o => o.t + o.s).join('|') === ' a|-b|+B| c| d|+e', ops.map(o => o.t + o.s).join('|'));
  t.ok('同じなら全部そのまま', lineDiff('x\ny', 'x\ny').every(o => o.t === ' '));
  const big = Array.from({ length: 1500 }, (_, i) => `line ${i}`);
  const large = lineDiff(big.join('\n'), big.map((l, i) => i === 700 ? 'changed' : l).join('\n'));
  t.ok('長いファイルでも前後の一致を落として比べる', large.filter(o => o.t !== ' ').length === 2);
  const huge = lineDiff(Array.from({ length: 1200 }, (_, i) => `a${i}`).join('\n'), Array.from({ length: 1200 }, (_, i) => `b${i}`).join('\n'));
  t.ok('大きすぎるときは削除と追加の塊にする（固まらない）', huge.length === 2400 && huge[0].t === '-' && huge[2399].t === '+');

  t.ok('コマンドと引数に分ける', JSON.stringify(splitCommand('npx -y @modelcontextprotocol/server-github')) === JSON.stringify({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] }));
  t.ok('引用符の中の空白は区切らない', JSON.stringify(splitCommand('node "C:/Program Files/x.mjs" --flag')) === JSON.stringify({ command: 'node', args: ['C:/Program Files/x.mjs', '--flag'] }));
  t.ok('分けたものを戻すと同じ意味になる', JSON.stringify(splitCommand(joinCommand('node', ['C:/Program Files/x.mjs', '-y']))) === JSON.stringify({ command: 'node', args: ['C:/Program Files/x.mjs', '-y'] }));
}
