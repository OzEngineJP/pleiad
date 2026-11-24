// コネクターで止まった発言の、失敗の行（web/connectors-fail.mjs。ADR 0340 段 3）をブラウザー無しで確かめる。
// 期待値は承認済みのモック（temporary/mockups/claude-connectors-account-stage3.html）と docs/design-system.md
// 「登録した Claude アカウントごとの claude.ai のコネクター」から書いた（今の実装から写さない）:
//   - 止めた理由ごとに一文を出し、直せる理由（切れ・未ログイン・設定の破損・持ち主・反映）だけ直す入口を出す
//   - 直す入口が無い理由（版・OS・環境変数・settings.json・履歴の置き場）は［コネクターをオフにして送る］が主
//   - ログインし直す → 済んだら自動でもう一度送る。取り消し・失敗なら元の行へ戻し、押したボタンへ焦点を戻す
//   - ［コネクターをオフにして送る］はスイッチを切ってから送り直す。横に「同じアカウントのほかの会話にも効く」一文
// 描画は本物の web/connectors-fail.mjs と web/i18n.mjs（辞書）。下に小さな DOM を置く（依存を足さない）
export const name = 'connectors-fail-ui';
export const title = 'コネクターで止まった発言の失敗の行: 理由ごとの一文・直す入口・ログインの後の自動の送り直し・オフにして送る・焦点';

// ---------------------------------------------------------------- 小さな DOM（この行が使う分だけ）
let doc;
class Text {
  constructor(data) { this.nodeType = 3; this.data = String(data); this.parentNode = null; }
  get textContent() { return this.data; }
}
class El {
  constructor(tag) {
    this.nodeType = 1; this.tagName = tag.toUpperCase(); this.attrs = new Map(); this.childNodes = []; this.parentNode = null;
    this.className = ''; this.type = ''; this.disabled = false; this.onclick = null;
    this.dataset = {};
  }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c) => { self.className = [...new Set([...list(), ...c])].join(' '); },
      remove: (...c) => { self.className = list().filter(x => !c.includes(x)).join(' '); },
      contains: c => list().includes(c),
    };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  set textContent(v) { this.childNodes = []; if (v !== '') this.append(new Text(v)); }
  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  append(...nodes) {
    for (const n of nodes) {
      const node = typeof n === 'string' ? new Text(n) : n;
      if (node.parentNode) node.parentNode.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
      node.parentNode = this; this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; this.append(...nodes); }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  contains(n) { for (let p = n; p; p = p.parentNode) if (p === this) return true; return false; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null; }
  querySelectorAll(sel) {
    const m = /^\[data-fix="([^"]+)"\]$/.exec(sel);
    if (m) return [...this.walk()].filter(e => e.dataset.fix === m[1]);
    const cls = /^\.([\w-]+)$/.exec(sel);
    if (cls) return [...this.walk()].filter(e => e.classList.contains(cls[1]));
    if (sel === 'button') return [...this.walk()].filter(e => e.tagName === 'BUTTON');
    throw new Error(`この小さな DOM は ${sel} を引けない`);
  }
  get isConnected() { for (let p = this; p; p = p.parentNode) if (p === doc.body) return true; return false; }
  focus() { doc.activeElement = this; }
  click() { if (!this.disabled) this.onclick?.({ stopPropagation() {} }); }
}

const tick = () => new Promise(r => setTimeout(r, 0));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

export default async function (t) {
  const saved = { document: globalThis.document, CSS: globalThis.CSS };
  doc = { createElement: tag => new El(tag), createElementNS: (_ns, tag) => new El(tag), createTextNode: s => new Text(s), body: new El('body'), activeElement: null };
  doc.activeElement = doc.body;
  globalThis.document = doc;
  globalThis.CSS = { escape: value => value };
  try {
    const { paintConnectorsFailure, connectorsFailKey, connectorsFailMessage } = await import('../../web/connectors-fail.mjs');
    const i18n = await import('../../web/i18n.mjs');
    const tr = i18n.t;
    const NAME = '個人';
    const ce = (kind, extra = {}) => ({ kind, accountId: 'acct-000000000001', accountName: NAME, params: {}, ...extra });
    const mount = (kind, { layout = 'outbox', cancel = true, extra = {} } = {}) => {
      const node = doc.createElement('div');
      doc.body.append(node);
      const calls = { login: 0, openAccount: 0, resend: [], off: 0, cancel: 0 };
      const ctl = { login: null, off: null, resend: null };
      const on = {
        // 本物（web/client.mjs の connectorsLoginEvent）は、同じアカウントのログインが済んだ知らせで待っている全部を解く。開き直しも同じ約束を待つ
        login: () => { calls.login += 1; ctl.login ??= deferred(); return ctl.login.p; },
        openAccount: () => { calls.openAccount += 1; },
        resend: (o) => { calls.resend.push(o); ctl.resend = deferred(); return ctl.resend.p; },
        off: () => { calls.off += 1; ctl.off = deferred(); return ctl.off.p; },
        spinner: () => doc.createElement('span'),
        ...(cancel ? { cancel: () => { calls.cancel += 1; } } : {}),
      };
      const view = paintConnectorsFailure(node, { ce: ce(kind, extra), name: NAME, layout, on });
      const btn = k => node.querySelector(`[data-fix="${k}"]`);
      const text = () => node.textContent;
      return { node, view, calls, ctl, btn, text };
    };

    // 1. 理由ごとの一文（両方の言語に訳がある・名前と版が埋まる・{{ が残らない）
    const ownDirKinds = ['ownDirLogin', 'ownDirLinks', 'ownDirLinksWindows', 'ownDirProfile'];
    const KINDS = ['expired', 'login', 'owner', 'version', 'platform', 'env', 'settings', 'history', 'profile', 'format', ...ownDirKinds, 'keychain', 'keychainAuth', 'ssh'];
    for (const lng of ['ja', 'en']) {
      await i18n.setLanguage(lng);
      const bad = [];
      for (const k of KINDS) {
        const c = k === 'settings' ? ce('env', { scope: 'settings' }) : ce(k, k === 'version' ? { params: { cli: '9.9.9', sdk: '8.8.8', verified: 'CLI 1 / SDK 2' } } : {});
        const msg = connectorsFailMessage(c, NAME);
        if (!i18n.has(`chat.connectorsFail.why.${k}`) || msg.includes('{{') || msg.includes('chat.connectorsFail') || (['expired', 'login', 'owner', 'profile', 'keychainAuth', ...ownDirKinds].includes(k) && !msg.includes(NAME))) bad.push(`${k}: ${msg}`);
        if (k === 'version' && !(msg.includes('9.9.9') && msg.includes('8.8.8'))) bad.push(`version の版が出ない: ${msg}`);
      }
      for (const k of ['fix.relogin', 'fix.login', 'fix.openAccount', 'fix.resend', 'off', 'offNote', 'cancel', 'waiting', 'sending', 'done.relogin', 'done.login', 'done.off', 'done.resend', 'resendFailed', 'loginFailed', 'offFailed']) {
        if (!i18n.has(`chat.connectorsFail.${k}`)) bad.push(`訳が無い: ${k}`);
      }
      t.ok(`理由ごとの一文（${lng}）: すべてに訳があり、アカウントで直す理由には名前が、版の理由には版が埋まる`, bad.length === 0, bad.join(' / '));
    }
    await i18n.setLanguage('ja');
    t.ok('理由の鍵: settings.json の分（env・scope settings）は settings、知らない種類は login（黙って空にしない）',
      connectorsFailKey(ce('env', { scope: 'settings' })) === 'settings' && connectorsFailKey(ce('env', { scope: 'env' })) === 'env' && connectorsFailKey({ kind: 'weird' }) === 'login' && connectorsFailKey(null) === 'login');

    // 2. 切れ（expired）: 発言の下の行
    {
      const v = mount('expired');
      const names = v.node.querySelectorAll('button').map(b => b.dataset.fix);
      t.ok('切れ: 発言の下の行（outbox-fix conn-fail）に「送れませんでした」と理由・直す入口・オフにして送る・取り消す',
        v.node.classList.contains('outbox-fix') && v.node.classList.contains('conn-fail') && v.text().includes(tr('chat.delivery.failed'))
          && v.text().includes(connectorsFailMessage(ce('expired'), NAME)) && JSON.stringify(names) === JSON.stringify(['fix', 'off', 'cancel']),
        JSON.stringify(names));
      t.ok('切れ: 直す入口は［claude.ai にログインし直す］で主（btn-primary）。オフにして送るは主ではない・どれも type=button',
        v.btn('fix').textContent === tr('chat.connectorsFail.fix.relogin') && v.btn('fix').classList.contains('btn-primary') && !v.btn('off').classList.contains('btn-primary')
          && v.node.querySelectorAll('button').every(b => b.type === 'button'));
      t.ok('オフにして送るの横に「同じアカウントのほかの会話にも効く」一文（名前つき）',
        v.node.querySelector('.auth-fail-note')?.textContent === tr('chat.connectorsFail.offNote', { name: NAME }) && tr('chat.connectorsFail.offNote', { name: NAME }).includes(NAME));
      t.ok('動きを伝える箇所は role=status（読み上げ）', v.node.querySelector('.acts')?.getAttribute('role') === 'status');
      // ログインし直す → 待つ → 済んだら自動で送る
      v.btn('fix').focus();
      v.btn('fix').click();
      await settle();
      t.ok('ログインし直す: ログインの流れを 1 回開き、待つ印を出す（送らない）。待つ間も入口を押せば開き直せる',
        v.calls.login === 1 && v.view.phase === 'waiting' && v.text().includes(tr('chat.connectorsFail.waiting')) && v.calls.resend.length === 0 && v.btn('fix') && !v.btn('fix').classList.contains('btn-primary'));
      v.btn('fix').click();
      await settle();
      t.ok('待つ間に入口を押すと、ログインを開き直すだけ（待ちは前のまま）', v.calls.login === 2 && v.view.phase === 'waiting');
      v.ctl.login.resolve('done');
      await settle();
      t.ok('ログインが済んだら、自動でもう一度送る（auto: true）', v.calls.resend.length === 1 && v.calls.resend[0]?.auto === true && v.view.phase === 'sending');
      v.ctl.resend.resolve(true);
      await settle();
      t.ok('送れたら「claude.ai にログインし直して、もう一度送りました」', v.view.phase === 'done' && v.text().includes(tr('chat.connectorsFail.done.relogin', { name: NAME })), v.text());
    }
    // 3. ログインを取り消した・失敗した → 元へ戻り、焦点を戻す
    {
      const v = mount('expired');
      v.btn('fix').focus();
      v.btn('fix').click();
      await settle();
      v.ctl.login.resolve('cancelled');
      await settle();
      t.ok('ログインを取り消したら元の行へ戻り（送らない）、押したボタンへ焦点を戻す',
        v.view.phase === 'failed' && v.calls.resend.length === 0 && doc.activeElement === v.btn('fix') && !v.text().includes(tr('chat.connectorsFail.loginFailed')));
      v.ctl.login = null;
      v.btn('fix').click();
      await settle();
      v.ctl.login.resolve('error');
      await settle();
      t.ok('ログインが失敗したら元の行へ戻り、失敗を一文で添える', v.view.phase === 'failed' && v.text().includes(tr('chat.connectorsFail.loginFailed')) && v.calls.resend.length === 0);
    }
    // 4. 送り直しが失敗 → 元へ戻り理由を添える
    {
      const v = mount('login');
      t.ok('未ログイン: 直す入口は［claude.ai にログイン］', v.btn('fix')?.textContent === tr('chat.connectorsFail.fix.login'));
      v.btn('fix').click();
      await settle();
      v.ctl.login.resolve('done');
      await settle();
      v.ctl.resend.reject(new Error('boom'));
      await settle();
      t.ok('自動の送り直しが失敗したら元の行へ戻り、失敗を添える（黙って消さない）',
        v.view.phase === 'failed' && v.text().includes(tr('chat.connectorsFail.resendFailed', { error: 'boom' })));
    }
    // 5. オフにして送る
    {
      const v = mount('expired');
      v.btn('off').focus();
      v.btn('off').click();
      await settle();
      t.ok('オフにして送る: 先にスイッチを切り（送る前）、送るを待つ', v.calls.off === 1 && v.calls.resend.length === 0 && v.view.phase === 'sending');
      v.ctl.off.resolve();
      await settle();
      t.ok('オフにして送る: 切れたら送り直す', v.calls.resend.length === 1);
      v.ctl.resend.resolve(true);
      await settle();
      t.ok('オフにして送る: 送れたら完了の一文', v.view.phase === 'done' && v.text().includes(tr('chat.connectorsFail.done.off', { name: NAME })), v.text());
      const w = mount('expired');
      w.btn('off').focus();
      w.btn('off').click();
      await settle();
      w.ctl.off.reject(new Error('nope'));
      await settle();
      t.ok('オフにできなければ送らず、元の行へ戻して失敗を添え、焦点を戻す',
        w.view.phase === 'failed' && w.calls.resend.length === 0 && w.text().includes(tr('chat.connectorsFail.offFailed', { error: 'nope' })) && doc.activeElement === w.btn('off'));
    }
    // 6. 直す入口が無い理由は、オフにして送るが主
    {
      const bad = [];
      for (const k of ['version', 'platform', 'env', 'history', 'ssh']) {
        const v = mount(k);
        if (v.btn('fix') || !v.btn('off')?.classList.contains('btn-primary')) bad.push(k);
      }
      const s = mount('env', { extra: { scope: 'settings' } });
      if (s.btn('fix') || !s.btn('off')?.classList.contains('btn-primary')) bad.push('settings');
      t.ok('版・OS・ssh からの起動・環境変数・settings.json・履歴の置き場: 直す入口を出さず、［コネクターをオフにして送る］が主', bad.length === 0, bad.join(','));
    }
    // 6b. Mac でログインが断られた（keychainAuth。キーチェーンのロックか取り消しかを見分けられない。ADR 0351）: ［再送する］が主、横に［claude.ai にログインし直す］
    {
      const v = mount('keychainAuth');
      const names = v.node.querySelectorAll('button').map(b => b.dataset.fix);
      t.ok('Mac でログインが断られた: ［再送する］（主）・［claude.ai にログインし直す］（主でない）・オフにして送る・取り消すの順',
        JSON.stringify(names) === JSON.stringify(['fix', 'also', 'off', 'cancel']) && v.btn('fix').textContent === tr('chat.connectorsFail.fix.resend')
          && v.btn('fix').classList.contains('btn-primary') && v.btn('also').textContent === tr('chat.connectorsFail.fix.relogin')
          && !v.btn('also').classList.contains('btn-primary') && !v.btn('off').classList.contains('btn-primary'), JSON.stringify(names));
      v.btn('fix').click();
      await settle();
      t.ok('Mac でログインが断られた: ［再送する］はログインを開かずに送り直す', v.calls.login === 0 && v.calls.resend.length === 1 && v.view.phase === 'sending');
      v.ctl.resend.resolve(false);
      await settle();
      v.btn('also').focus();
      v.btn('also').click();
      await settle();
      t.ok('Mac でログインが断られた: ［claude.ai にログインし直す］はログインを開いて待つ（送らない）',
        v.calls.login === 1 && v.view.phase === 'waiting' && v.calls.resend.length === 1);
      v.ctl.login.resolve('cancelled');
      await settle();
      t.ok('Mac でログインが断られた: ログインを取り消したら元の行へ戻り、［claude.ai にログインし直す］へ焦点を戻す',
        v.view.phase === 'failed' && doc.activeElement === v.btn('also'));
      v.ctl.login = null;
      v.btn('also').click();
      await settle();
      v.ctl.login.resolve('done');
      await settle();
      v.ctl.resend.resolve(true);
      await settle();
      t.ok('Mac でログインが断られた: ログインが済んだら自動で送り、「ログインし直して、もう一度送りました」',
        v.calls.resend.length === 2 && v.calls.resend[1]?.auto === true && v.view.phase === 'done' && v.text().includes(tr('chat.connectorsFail.done.relogin', { name: NAME })), v.text());
      const k = mount('keychain');
      t.ok('Mac のキーチェーンを開けない（keychain）: ［再送する］だけで、ログインし直しは出さない', k.btn('fix')?.textContent === tr('chat.connectorsFail.fix.resend') && !k.btn('also'));
    }
    // 7. 持ち主・反映
    {
      const v = mount('owner');
      v.btn('fix').click();
      await settle();
      t.ok('持ち主の不一致: ［アカウントを開く］で設定のアカウントを開くだけ（送らない・行はそのまま）',
        v.btn('fix').textContent === tr('chat.connectorsFail.fix.openAccount') && v.calls.openAccount === 1 && v.calls.resend.length === 0 && v.view.phase === 'failed');
      const p = mount('profile');
      p.btn('fix').click();
      await settle();
      t.ok('共有の設定フォルダーへの反映の失敗: ［再送する］はそのまま送り直す', p.btn('fix') === null && p.calls.resend.length === 1 && p.view.phase === 'sending');
      p.ctl.resend.resolve(true);
      await settle();
      t.ok('反映の失敗の再送が通れば完了の一文', p.view.phase === 'done' && p.text().includes(tr('chat.connectorsFail.done.resend', { name: NAME })));
    }
    // 8. 会話の失敗の行（ターンの途中で止まった）
    {
      const v = mount('expired', { layout: 'sys', cancel: false });
      t.ok('ターンの途中で止まったときは会話の失敗の行（turn-failed auth-fail）。取り消すは出さない',
        v.node.classList.contains('turn-failed') && v.node.classList.contains('auth-fail') && !v.btn('cancel') && v.btn('fix') && v.btn('off')
          && v.text().includes(connectorsFailMessage(ce('expired'), NAME)));
    }
    // 9. 取り消す
    {
      const v = mount('version');
      v.btn('cancel').click();
      v.btn('cancel').click();
      t.ok('取り消すは 1 回だけ届く（押した後は押せない）', v.calls.cancel === 1 && v.btn('cancel').disabled === true);
    }
    // 10. 行を外した後に届いた結果は描かない
    {
      const v = mount('expired');
      v.btn('fix').click();
      await settle();
      v.node.parentNode.childNodes.splice(v.node.parentNode.childNodes.indexOf(v.node), 1);
      v.node.parentNode = null;
      v.ctl.login.resolve('done');
      await settle();
      t.ok('行が画面から外れた後にログインが済んでも、送り直さない（別の描画が受け持つ）', v.calls.resend.length === 0);
    }
    {
      const { createMcpMatrix } = await import('../../web/mcp-matrix.mjs');
      const matrix = createMcpMatrix({ section: { addButton: () => doc.createElement('button') } });
      const row = { id: 'acct-000000000001', name: NAME, enabled: false, usageLogin: true, status: 'ok', connectors: [] };
      const host = doc.createElement('div');
      const calls = [];
      const ctx = {
        matrix: { agents: [], rows: [], connectorAccounts: [row] },
        scan: {}, cwd: '/example', opened: new Set(),
        work: run => run(), rerender() {}, async reloadMatrix() {},
        async cmd(command, request) {
          calls.push([command, request]);
          row.mode = request.args.mode;
        },
      };
      const renderMode = () => {
        host.replaceChildren();
        matrix.reset();
        matrix.render(host, ctx);
        return host.querySelector('.cx-acct-mode')?.querySelector('button');
      };
      t.ok('コネクターがオフの行には専用フォルダ方式を出さない', renderMode() === undefined);
      row.enabled = true;
      const off = renderMode();
      t.ok('コネクターがオンの行では既定の方式が表示される',
        off?.getAttribute('role') === 'switch' && off.getAttribute('aria-checked') === 'false');
      off?.click();
      await settle();
      const on = renderMode();
      t.ok('専用フォルダ方式を選ぶとスイッチがオンになる', on?.getAttribute('aria-checked') === 'true');
      on?.click();
      await settle();
      const expected = ['own-dir', 'b1'].map(mode => ['invoke', { op: 'accounts.setConnectors', args: { id: row.id, enabled: true, mode, cwd: ctx.cwd } }]);
      t.ok('両方向の切り替えをアカウント設定操作に渡す',
        JSON.stringify(calls) === JSON.stringify(expected) && renderMode()?.getAttribute('aria-checked') === 'false');
    }
  } finally {
    globalThis.document = saved.document;
    globalThis.CSS = saved.CSS;
  }
}
