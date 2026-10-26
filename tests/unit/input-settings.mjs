// 設定 › 入力（web/input-settings.mjs）。「次のメッセージの候補」の行は、候補を出せるエージェント
// （能力の印 promptSuggestions: 'native' はターンの中で届く、補うは Pleiad が suggestNext で後から作る）が
// 有効なエージェントの中に 1 つでもあるときだけ出す。無ければ行ごと出さない（入れても何も起きない設定にしない。#147）
import { N } from '../lib/dom-stub.mjs';
import { setupInputSettings } from '../../web/input-settings.mjs';
import { t as tr } from '../../web/i18n.mjs';

export const name = 'input-settings';
export const title = '設定 › 入力: 次の発言の候補の行は、候補を出せるエージェントがあるときだけ';

const fake = { id: 'fake', label: 'Fake (test)', capabilities: { promptSuggestions: true } };
const claude = { id: 'claude', label: 'Claude', capabilities: { promptSuggestions: 'native' } };
const devin = { id: 'devin', label: 'Devin', capabilities: { promptSuggestions: false } };

function panel(backends, { prefs = {} } = {}) {
  const root = new N('div');
  const savedGet = document.getElementById;
  document.getElementById = id => (id === 'inputPanel' ? root : null);
  try {
    const ui = setupInputSettings({ cmd: async () => ({}), getPrefs: () => prefs, getBackends: backends });
    return { root, ui, labels: () => root.querySelectorAll('.nf-label').map(n => n.textContent),
      descs: () => root.querySelectorAll('small').map(n => n.textContent) };
  } finally { document.getElementById = savedGet; }
}

export default function (t) {
  // ---- 行の出し分け（能力の印で見る。エージェントの id の一覧は持たない）----
  const none = panel(() => []);
  t.ok('候補を出せるエージェントが無ければ候補の行は出ない（呼び出しの行だけ）',
    none.labels().length === 1 && none.labels()[0] === tr('settings.input.historyRecall.title'));
  const devinOnly = panel(() => [devin]);
  t.ok('対応の無いエージェントだけなら同じく行は出ない', devinOnly.labels().length === 1);

  // ---- 対応エージェントがあるとき: 行が出て、説明に対応しているエージェントの名前が載る ----
  const withFake = panel(() => [fake]);
  t.ok('出せるエージェントがあれば行は出る', withFake.labels().includes(tr('settings.input.suggestions.title')));
  t.ok('説明に対応しているエージェントの名前が載る', withFake.descs().some(d => d.includes('Fake (test)')));
  // 補う分（suggestNext で後から作る）は使用量を使うので、その旨も説明にある
  t.ok('補う分（covered）は使用量を使う旨が説明に出る',
    withFake.descs().some(d => d.includes('使用量を少し使います') && d.includes('Fake (test)')));
  const native = panel(() => [claude]);
  t.ok('native の分は使用量の注記は出ない（ターンの中で届く）',
    native.labels().includes(tr('settings.input.suggestions.title'))
    && !native.descs().some(d => d.includes('使用量を少し使います')));
  const mixed = panel(() => [claude, fake, devin]);
  t.ok('混在なら対応している名前だけが載る（対応の無いものは外れる）',
    mixed.descs().some(d => d.includes('Claude') && d.includes('Fake (test)') && !d.includes('Devin')));

  // ---- 一覧の到着で描き直す（backends は後から届く。paint で出し分けが変わる）----
  let list = [devin];
  const re = panel(() => list);
  t.ok('届く前（対応なし）では行は出ない', re.labels().length === 1);
  list = [devin, fake];
  re.ui.paint();
  t.ok('対応エージェントが届けば描き直しで行が出る', re.labels().includes(tr('settings.input.suggestions.title')));
}
