// ツール実行の行（v4）: 閉じた行はアイコン＋動詞＋対象＋時刻だけ。開くとツールごとのタブ（主面 ⇄ 入力）。
// 時刻のボタンは、始まりの時刻（サーバーの at・履歴の at/endAt）があるときだけ出る。
//
// DOM シムは tests/run.mjs が入口で入れている（セレクタは単純なクラス・タグだけ）。
import { renderToolCall, applyToolResult, applyToolHints } from "../../web/render.mjs";
import { markRunning } from "../../web/tool-bundle.mjs";
import { toolTimeShort, toolTimeLong, toolDuration, syncServerClock } from "../../web/server-clock.mjs";
import { transcriptToMessages } from "../../core/backends/claude-normalize.mjs";
import { streamMessages } from "../../web/stream-messages.mjs";

export const name = "tool-run-ui";
export const title = "ツールの行: アイコン・時刻ボタン・主面⇄入力のタブ";

const json = (x) => JSON.stringify(x);
const HHMM = /^\d\d:\d\d$/;

export default function (t) {
  syncServerClock(undefined);
  const at = Date.parse("2026-10-20T14:32:05");
  const end = Date.parse("2026-10-20T14:32:08");

  // ---- 閉じた行の構成
  {
    const card = renderToolCall("Bash", { command: "npm test" }, { id: "c1", at, endAt: end });
    t.ok("行頭にツールアイコン（.tic）", Boolean(card.querySelector(".tic")?.children.length));
    t.ok("時刻があると右端に HH:MM のボタン", HHMM.test(card.querySelector(".tc-time")?.textContent ?? ""), card.querySelector(".tc-time")?.textContent);
    t.ok("結果の要約は閉じた行に出さない（.tc-res は空）", (card.querySelector(".tc-res")?.textContent ?? "") === "");
    const noTime = renderToolCall("Read", { file_path: "a/b.txt" });
    t.ok("時刻の無い履歴は時刻ボタンもポップオーバーの中身も出さない",
      !noTime.querySelector(".tc-time") && !(noTime.querySelector(".tc-when-pop")?.textContent ?? "").trim());
  }

  // ---- タブ: 実行 = 出力⇄入力、編集 = 差分⇄入力、TODO = タブなし
  {
    const bash = renderToolCall("Bash", { command: "ls" });
    const tabs = [...bash.querySelector(".tc-tabs").children];
    t.ok("実行は「出力」「入力」の 2 枚", tabs.length === 2 && tabs[0].textContent === "出力" && tabs[1].textContent === "入力",
      tabs.map((b) => b.textContent).join());
    t.ok("主面が空のうちは「入力」が既定", bash.querySelector(".tc-pane-input")?.classList.contains("on") && !bash.querySelector(".tc-pane-main")?.classList.contains("on"));
    t.ok("入力の面に生の JSON の折りたたみ", Boolean(bash.querySelector(".tc-json")));

    const edit = renderToolCall("Edit", { file_path: "a/b.css", old_string: "x:1", new_string: "x:2" });
    const etabs = [...edit.querySelector(".tc-tabs").children];
    t.ok("編集は「差分」「入力」で、差分が既定（主面に差分が入る）",
      etabs[0]?.textContent === "差分" && edit.querySelector(".tc-pane-main")?.classList.contains("on") && Boolean(edit.querySelector(".tc-diff")));
    t.ok("削除行は .tc-del（色と面だけ。取り消し線は別部品）", Boolean(edit.querySelector(".tc-del")));

    const todo = renderToolCall("TodoWrite", { todos: [{ content: "a", status: "pending" }] });
    t.ok("TODO はタブを出さない（1 面＋生の JSON の折りたたみ）",
      !todo.querySelector(".tc-tabs") && Boolean(todo.querySelector(".tc-json")));
  }

  // ---- 結果: 実行は端末面、時刻の詳細はポップオーバー
  {
    const card = renderToolCall("Bash", { command: "npm run lint" }, { at });
    applyToolResult(card, { text: "a\nb\nExit code 1", isError: true, at: end });
    const term = card.querySelector(".tc-term");
    t.ok("実行の結果は主面の端末面（$ コマンド＋出力）", Boolean(term) && term.textContent.includes("$ npm run lint") && term.textContent.includes("Exit code 1"), term?.textContent?.slice(0, 80));
    t.ok("失敗の終了コードは端末面の末尾", term?.textContent.includes("exit 1"), term?.textContent);
    t.ok("結果が主面に入ったら主タブが選ばれる", card.querySelector(".tc-pane-main")?.classList.contains("on"));
    const pop = card.querySelector(".tc-when-pop");
    t.ok("ポップオーバーに開始・終了・所要・終了コード",
      pop?.textContent.includes("開始") && pop?.textContent.includes("終了") && pop?.textContent.includes("所要") && pop?.textContent.includes("終了コード 1"), pop?.textContent);
    t.ok("失敗の印（✕ 失敗）は残る", card.querySelector(".tc-res")?.textContent.includes("失敗"), card.querySelector(".tc-res")?.textContent);

    const ok = renderToolCall("Bash", { command: "npm test" }, { at });
    applyToolResult(ok, { text: "20 passed", at: end });
    t.ok("成功した行の右端は空（時刻のボタンだけ）", (ok.querySelector(".tc-res")?.textContent ?? "") === "" && HHMM.test(ok.querySelector(".tc-time")?.textContent ?? ""), ok.querySelector(".tc-res")?.textContent);
  }

  // Initial panes depend on available data, across the registered tool shapes.
  applyToolHints({ fileChange: { shape: 'edit' }, agEdit: { shape: 'edit' }, agWrite: { shape: 'write' }, arbitrary: { shape: 'generic' } });
  const matrix = [
    ['Read', { file_path: 'a' }, false], ['Bash', { command: 'echo hi' }, false],
    ['fileChange', { files: ['a'] }, false], ['Edit', { file_path: 'a' }, false],
    ['agEdit', { TargetFile: 'a', TargetContent: 'old', ReplacementContent: 'new' }, true],
    ['agWrite', { TargetFile: 'a', CodeContent: 'new' }, true],
    ['MultiEdit', { file_path: 'a', edits: [{}] }, false],
    ['Grep', { pattern: 'x' }, false], ['Glob', { pattern: '*.js' }, false],
    ['WebFetch', { url: 'https://example.com' }, false], ['Agent', { prompt: 'look' }, false],
    ['mcp__x__unknown', { x: 1 }, false], ['arbitrary', {}, false],
    ['mcp__ply_agents__ply_delegate', { task: 'look' }, false],
  ];
  for (const [tool, input, initial] of matrix) {
    const c = renderToolCall(tool, input);
    const main = () => c.querySelector('.tc-pane-main').classList.contains('on');
    t.ok(`${tool}: unopened row and data-based default`, !c.querySelector('.tc-details').open && main() === initial);
    applyToolResult(c, { text: '' });
    t.ok(`${tool}: empty result preserves data-based default`, main() === initial);
    applyToolResult(c, { text: 'result' });
    t.ok(`${tool}: result selects main before opening`, main());
  }
  for (const payload of [{ text: '0 matches' }, { count: 0 }, { images: [{ url: 'data:image/png;base64,AA==' }] }]) {
    const c = renderToolCall('mcp__x__unknown', {});
    applyToolResult(c, payload);
    t.ok('Explicit zero, JSON and image results select main', c.querySelector('.tc-pane-main').classList.contains('on'));
  }
  const plan = renderToolCall('ExitPlanMode', { plan: 'Review this plan' });
  applyToolResult(plan, { text: 'approved' });
  t.ok('Plan stays on input after success', plan.querySelector('.tc-pane-input').classList.contains('on'));
  applyToolResult(plan, { text: 'Error: rejected', isError: true });
  t.ok('Plan failure selects main', plan.querySelector('.tc-pane-main').classList.contains('on'));
  const picked = renderToolCall('Read', { file_path: 'a' });
  picked.querySelector('.tc-tabs').children[1].onclick({ preventDefault() {}, stopPropagation() {} });
  applyToolResult(picked, { text: 'arrived' });
  t.ok('Person-selected input survives arriving results', picked.querySelector('.tc-pane-input').classList.contains('on'));
  const opened = renderToolCall('Read', { file_path: 'a' }, { open: true });
  applyToolResult(opened, { text: 'arrived' });
  t.ok('Opening the initial input freezes it', opened.querySelector('.tc-pane-input').classList.contains('on'));
  const terminal = renderToolCall('PowerShell', { command: 'Get-Date' });
  t.ok('Pending shell has a prompt and cursor', terminal.querySelector('.tc-term').textContent.includes('PS> Get-Date') && Boolean(terminal.querySelector('.tc-term-cursor')));
  const surface = terminal.querySelector('.tc-term');
  Object.assign(surface, { scrollTop: 12, scrollHeight: 900, clientHeight: 200 });
  applyToolResult(terminal, { text: 'done exit 0' });
  t.ok('Result reuses terminal, preserves scrollback, removes cursor and shows exit 0', terminal.querySelector('.tc-term') === surface && surface.scrollTop === 12 && !surface.querySelector('.tc-term-cursor') && surface.textContent.endsWith('exit 0'));
  surface.scrollTop = 700;
  applyToolResult(terminal, { text: 'more exit 0' });
  t.ok('Terminal follows only at the tail', surface.scrollTop === surface.scrollHeight);

  // ---- 時刻の整形
  {
    t.ok("HH:MM と HH:MM:SS", HHMM.test(toolTimeShort(at)) && /^\d\d:\d\d:\d\d$/.test(toolTimeLong(at)),
      `${toolTimeShort(at)} / ${toolTimeLong(at)}`);
    t.ok("所要: 10 秒未満は小数 1 位、それ以上は整数秒",
      toolDuration(3400) === "3.4" && toolDuration(9999) === "10.0" && toolDuration(12_000) === "12" && toolDuration(-5) === "0.0",
      [3400, 9999, 12_000].map(toolDuration).join());
    t.ok("読めない時刻は空", toolTimeShort("x") === "" && toolTimeLong(null) === "");
  }

  // ---- markRunning が始まりを記録し、時刻ボタンを出す
  {
    const card = renderToolCall("Bash", { command: "sleep 9" });
    t.ok("時刻が無ければボタンは出ない", !card.querySelector(".tc-time"));
    markRunning(card, at);
    t.ok("markRunning が toolStarted を記録してボタンが出る", card.toolStarted === at && HHMM.test(card.querySelector(".tc-time")?.textContent ?? ""));
  }

  // ---- 履歴: Claude の transcript が tool_use / tool_result の時刻を at・endAt として返す
  {
    const msgs = transcriptToMessages([
      { type: "assistant", uuid: "a1", timestamp: "2026-10-20T14:32:05Z", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] } },
      { type: "user", uuid: "u1", timestamp: "2026-10-20T14:32:08Z", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    ]);
    const call = msgs[0]?.toolCalls?.[0];
    t.ok("tool_use の timestamp が at、tool_result の timestamp が endAt になる",
      call?.at === "2026-10-20T14:32:05Z" && call?.endAt === "2026-10-20T14:32:08Z" && call?.result?.text === "ok", json(call));
    const noTs = transcriptToMessages([
      { type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: {} }] } },
    ]);
    t.ok("timestamp の無いエントリには時刻を付けない（捏造しない）",
      noTs[0]?.toolCalls?.[0]?.at == null && !("endAt" in (noTs[0]?.toolCalls?.[0] ?? {})));
  }

  // ---- ライブの再生: stream.events を畳んだ呼び出しは at（始まり）と result.at（終わり）を持つ
  {
    const { messages } = streamMessages([
      { type: "tool.start", id: "x1", name: "Bash", input: {}, at },
      { type: "tool.result", id: "x1", text: "done", at: end },
    ]);
    const c = messages[0]?.toolCalls?.[0];
    t.ok("畳んだ呼び出しに始まりの at と結果の at が残る",
      c?.at === at && c?.result?.at === end, json(c));
    // 画面が受け取るのと同じ渡し方（client.mjs の履歴行と同じ）
    const card = renderToolCall(c.name, c.input, { id: c.id, at: c.at });
    applyToolResult(card, c.result);
    t.ok("再生した呼び出しにも開始・終了・所要が出る",
      card.querySelector(".tc-when-pop")?.textContent.includes("終了"), card.querySelector(".tc-when-pop")?.textContent);
  }
}
