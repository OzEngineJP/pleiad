// コネクターで止まった発言の、失敗の行（web/connectors-fail.mjs。ADR 0340 段 3）をブラウザー無しで確かめる。
// 期待値は承認済みのモック（temporary/mockups/claude-connectors-account-stage3.html）と docs/design-system.md
// 「登録した Claude アカウントごとの claude.ai のコネクター」から書いた（今の実装から写さない）:
//   - 止めた理由ごとに一文を出し、直せる理由（未ログイン・ログイン切れ・反映・Mac のキーチェーン）だけ直す入口を出す
//   - 直す入口が無い理由（版・OS・環境変数・settings.json・履歴の置き場）は一文で直し方を書き、［取り消す］だけ
//   - ログインする → 済んだら自動でもう一度送る。取り消し・失敗なら元の行へ戻し、押したボタンへ焦点を戻す
//   - ［コネクターをオフにして送る］は出さない（ADR 0353 から、オフのアカウントも同じ専用フォルダのログインで動き、同じ条件で止まる）
// 描画は本物の web/connectors-fail.mjs と web/i18n.mjs（辞書）。下に小さな DOM を置く（依存を足さない）
export const name = 'connectors-fail-ui';
export const title = 'コネクターで止まった発言の失敗の行: 理由ごとの一文・直す入口・ログインの後の自動の送り直し・焦点';

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
      const calls = { login: 0, resend: [], cancel: 0 };
      const ctl = { login: null, resend: null };
      const on = {
        // 本物（web/client.mjs の connectorsLoginEvent）は、同じアカウントのログインが済んだ知らせで待っている全部を解く。開き直しも同じ約束を待つ
        login: () => { calls.login += 1; ctl.login ??= deferred(); return ctl.login.p; },
        resend: (o) => { calls.resend.push(o); ctl.resend = deferred(); return ctl.resend.p; },
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
    const KINDS = ['login', 'version', 'platform', 'env', 'settings', 'history', 'profile', ...ownDirKinds, 'keychain', 'keychainAuth', 'ssh'];
    for (const lng of ['ja', 'en']) {
      await i18n.setLanguage(lng);
      const bad = [];
      for (const k of KINDS) {
        const c = k === 'settings' ? ce('env', { scope: 'settings' }) : ce(k, k === 'version' ? { params: { cli: '9.9.9', sdk: '8.8.8', verified: 'CLI 1 / SDK 2' } } : {});
        const msg = connectorsFailMessage(c, NAME);
        if (!i18n.has(`chat.connectorsFail.why.${k}`) || msg.includes('{{') || msg.includes('chat.connectorsFail') || (['login', 'profile', 'keychainAuth', ...ownDirKinds].includes(k) && !msg.includes(NAME))) bad.push(`${k}: ${msg}`);
        if (k === 'version' && !(msg.includes('9.9.9') && msg.includes('8.8.8'))) bad.push(`version の版が出ない: ${msg}`);
      }
      for (const k of ['fix.relogin', 'fix.login', 'fix.resend', 'cancel', 'waiting', 'sending', 'done.relogin', 'done.login', 'done.resend', 'resendFailed', 'loginFailed']) {
        if (!i18n.has(`chat.connectorsFail.${k}`)) bad.push(`訳が無い: ${k}`);
      }
      t.ok(`理由ごとの一文（${lng}）: すべてに訳があり、アカウントで直す理由には名前が、版の理由には版が埋まる`, bad.length === 0, bad.join(' / '));
    }
    await i18n.setLanguage('ja');
    t.ok('理由の鍵: settings.json の分（env・scope settings）は settings、知らない種類は login（黙って空にしない）',
      connectorsFailKey(ce('env', { scope: 'settings' })) === 'settings' && connectorsFailKey(ce('env', { scope: 'env' })) === 'env' && connectorsFailKey({ kind: 'weird' }) === 'login' && connectorsFailKey(null) === 'login');

    // 2. 専用フォルダのログインが無い・切れた（ownDirLogin）: 発言の下の行
    {
      const v = mount('ownDirLogin');
      const names = v.node.querySelectorAll('button').map(b => b.dataset.fix);
      t.ok('ログインが無い・切れた: 発言の下の行（outbox-fix conn-fail）に「送れませんでした」と理由・直す入口・取り消す（オフにして送るは無い）',
        v.node.classList.contains('outbox-fix') && v.node.classList.contains('conn-fail') && v.text().includes(tr('chat.delivery.failed'))
          && v.text().includes(connectorsFailMessage(ce('ownDirLogin'), NAME)) && JSON.stringify(names) === JSON.stringify(['fix', 'cancel']),
        JSON.stringify(names));
      t.ok('ログインが無い・切れた: 直す入口は［claude.ai にログイン］で主（btn-primary）・どれも type=button・補足の一文は出さない',
        v.btn('fix').textContent === tr('chat.connectorsFail.fix.login') && v.btn('fix').classList.contains('btn-primary')
          && v.node.querySelectorAll('button').every(b => b.type === 'button') && v.node.querySelector('.auth-fail-note') === null);
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
      t.ok('送れたら「claude.ai にログインして、もう一度送りました」', v.view.phase === 'done' && v.text().includes(tr('chat.connectorsFail.done.login', { name: NAME })), v.text());
    }
    // 3. ログインを取り消した・失敗した → 元へ戻り、焦点を戻す
    {
      const v = mount('ownDirLogin');
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
    // 6. 直す入口が無い理由は、［取り消す］だけ（直し方は一文に書く）
    {
      const bad = [];
      const only = v => JSON.stringify(v.node.querySelectorAll('button').map(b => b.dataset.fix)) === JSON.stringify(['cancel']);
      for (const k of ['version', 'platform', 'env', 'history', 'ssh', 'ownDirLinks', 'ownDirLinksWindows']) {
        if (!only(mount(k))) bad.push(k);
      }
      if (!only(mount('env', { extra: { scope: 'settings' } }))) bad.push('settings');
      t.ok('版・OS・ssh からの起動・環境変数・settings.json・履歴の置き場・リンクを作れない: 直す入口を出さず、［取り消す］だけ', bad.length === 0, bad.join(','));
    }
    // 6b. Mac でログインが断られた（keychainAuth。キーチェーンのロックか取り消しかを見分けられない。ADR 0351）: ［再送する］が主、横に［claude.ai にログインし直す］
    {
      const v = mount('keychainAuth');
      const names = v.node.querySelectorAll('button').map(b => b.dataset.fix);
      t.ok('Mac でログインが断られた: ［再送する］（主）・［claude.ai にログインし直す］（主でない）・取り消すの順',
        JSON.stringify(names) === JSON.stringify(['fix', 'also', 'cancel']) && v.btn('fix').textContent === tr('chat.connectorsFail.fix.resend')
          && v.btn('fix').classList.contains('btn-primary') && v.btn('also').textContent === tr('chat.connectorsFail.fix.relogin')
          && !v.btn('also').classList.contains('btn-primary'), JSON.stringify(names));
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
    // 7. 反映
    {
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
      const v = mount('ownDirLogin', { layout: 'sys', cancel: false });
      t.ok('ターンの途中で止まったときは会話の失敗の行（turn-failed auth-fail）。取り消すは出さない',
        v.node.classList.contains('turn-failed') && v.node.classList.contains('auth-fail') && !v.btn('cancel') && v.btn('fix') && !v.btn('off')
          && v.text().includes(connectorsFailMessage(ce('ownDirLogin'), NAME)));
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
      const v = mount('ownDirLogin');
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
        async cmd(command, request) { calls.push([command, request]); },
      };
      const render = () => {
        host.replaceChildren();
        matrix.reset();
        matrix.render(host, ctx);
        return host.textContent;
      };
      // 専用フォルダ方式だけ（ADR 0350）。方式を切り替えるスイッチは無い
      for (const enabled of [false, true]) {
        row.enabled = enabled;
        render();
        t.ok(`方式の切り替えは出さない（コネクター${enabled ? 'オン' : 'オフ'}の行）`, host.querySelector('.cx-acct-mode') === null && calls.length === 0);
      }
      // 更新のあとの準備で共有へ移した・退避した項目は、オンの行に出す（移したことを画面で知らせる）
      row.moved = { shared: ['projects', 'skills'], archived: ['settings.json'] };
      const shown = render();
      t.ok('更新のあとの準備で移した項目（共有へ移した・名前が重なって退避した）を行に出す',
        shown.includes(tr('mcp.accounts.movedShared', { entries: 'projects, skills' })) && shown.includes(tr('mcp.accounts.movedArchived', { entries: 'settings.json' })), shown);
      row.moved = { shared: [], archived: [] };
      const quiet = render();
      t.ok('移した項目が無ければ何も出さない', !quiet.includes('projects') && !quiet.includes('claude-usage'), quiet);
    }
  } finally {
    globalThis.document = saved.document;
    globalThis.CSS = saved.CSS;
  }
}
