import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { N } from '../lib/dom-stub.mjs';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

export const name = 'agent-accounts-ui';
export const title = 'Account UI keeps login attempts, views and cache generations separate across delayed responses';
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

export default async function test(t) {
  const i18n = await import('../../web/i18n.mjs');
  const originalLanguage = i18n.lang;
  await i18n.setLanguage('en');
  const globals = { document: globalThis.document, window: globalThis.window };
  const nodes = new Map(), popups = [];
  class Node extends N {
    set id(value) { super.id = value; nodes.set(value, this); }
    get id() { return super.id; }
    set innerHTML(value) {
      super.innerHTML = value;
      // Parse only the fixed panel's ID anchors. Dynamic account cards/actions
      // use real element trees, so assertions observe the production handlers.
      for (const match of value.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/gi)) {
        const node = new Node(match[1]); node.id = match[3]; node.hidden = /\bhidden\b/.test(match[2]); node.value = ''; this.append(node);
      }
    }
    get isConnected() { return true; }
  }
  globalThis.document = {
    documentElement: { lang: 'en' }, createElement: tag => new Node(tag),
    getElementById: id => nodes.get(id),
    createTextNode: text => { const node = new Node('span'); node.textContent = text; return node; },
  };
  globalThis.window = { open: () => { const popup = { location: { href: '' }, closed: 0, close() { this.closed++; } }; popups.push(popup); return popup; } };
  const { setupAgentAccounts, createAccountRequestCache, composerAccount } = await import('../../web/agent-accounts.mjs');
  const { paintAuthFailure } = await import('../../web/auth-expired.mjs');
  const { t: tr } = i18n;
  const $ = id => nodes.get(id);
  const account = (id, name = id) => ({ id, name, hasCredential: false });
  const calls = [];
  let autoLists = true, rows = new Map();
  const changes = [];
  const cmd = (name, { op, args }) => {
    assert.equal(name, 'invoke');
    const response = deferred(), verb = op.slice('accounts.'.length);
    calls.push({ verb, args, ...response });
    if (verb === 'list' && autoLists) response.resolve({ accounts: rows.get(args.backend) ?? [] });
    return response.promise;
  };
  const fresh = () => {
    nodes.clear(); popups.length = 0; calls.length = 0; changes.length = 0;
    const controls = new Node('div'); controls.id = 'agentControls';
    autoLists = true; rows = new Map([['codex', [account('A'), account('B'), account('C')]], ['opencode', [account('O')]]]);
    return setupAgentAccounts({ cmd, openSettings() {}, labelOf: id => id, onChange: id => changes.push(id) });
  };
  const requests = verb => calls.filter(c => c.verb === verb);
  const login = id => {
    const card = $('aaList').children.find(n => n.querySelector('strong')?.textContent === id);
    assert.ok(card, `account ${id} exists`);
    return card.querySelectorAll('button')[0].onclick();
  };
  const cancel = () => $('aaFlowBody').querySelectorAll('button').find(b => b.textContent === tr('agentAccounts.cancel')).onclick();
  const beginForm = value => { $('aaAdd').onclick(); $('aaName').value = value; };
  const submit = () => $('aaForm').onsubmit({ preventDefault() {} });
  const check = label => t.ok(label, true);

  try {
    {
      const ui = fresh(); await ui.open('codex'); await login('A');
      const old = requests('login')[0], oldPopup = popups[0];
      ui.authEvent({ backend: 'codex', accountId: 'A', loginId: old.args.attempt, phase: 'url', url: 'https://auth.example.invalid/old' });
      assert.ok(oldPopup.location.href.endsWith('/old'));
      const cancelling = cancel(); await tick();
      const retry = login('A'); await tick();
      assert.equal(requests('login').length, 1, 'same-ID retry waits for cancellation acknowledgment');
      requests('cancel')[0].resolve({ cancelled: true }); await cancelling; await retry;
      const current = requests('login')[1], currentPopup = popups[1];
      assert.notEqual(old.args.attempt, current.args.attempt);
      assert.equal(requests('cancel')[0].args.attempt, old.args.attempt);
      old.reject(new Error('old login failed')); await tick();
      ui.authEvent({ backend: 'codex', accountId: 'A', phase: 'url', url: 'https://auth.example.invalid/missing-nonce' });
      ui.authEvent({ backend: 'codex', accountId: 'A', loginId: old.args.attempt, phase: 'url', url: 'https://auth.example.invalid/stale' });
      assert.equal(currentPopup.location.href, ''); assert.equal(currentPopup.closed, 0);
      assert.ok($('aaFlowBody').textContent.includes(tr('agentAccounts.flow.starting')));
      ui.authEvent({ backend: 'codex', accountId: 'A', loginId: current.args.attempt, phase: 'url', url: 'https://auth.example.invalid/current' });
      assert.ok(currentPopup.location.href.endsWith('/current'));
      current.resolve({ label: 'new identity' }); await tick();
      assert.ok($('aaFlowBody').textContent.includes('new identity'));
      check('cancel and same-ID retry serialize; old results and missing/wrong nonce events cannot repaint or close the new popup');
    }
    {
      const ui = fresh(); await ui.open('codex'); await login('A');
      const old = requests('login')[0];
      const b = login('B'); await tick(); const c = login('C'); await tick();
      assert.equal(requests('login').length, 1);
      await ui.open('codex');
      requests('cancel')[0].resolve({ cancelled: false }); await b; await c;
      assert.deepEqual(requests('login').map(r => r.args.id), ['A', 'C']);
      assert.ok(popups[1].closed > 0); assert.equal(popups[2].closed, 0);
      old.resolve({ label: 'old success' }); await tick();
      assert.ok($('aaFlowTitle').textContent.includes('C')); assert.equal(popups[2].closed, 0);
      requests('login')[1].resolve({ label: 'C done' }); await tick();
      check('overlapping A-to-B-to-C cancellation starts only C; an already committed old login updates only its backend cache');
    }
    {
      const ui = fresh(); await ui.open('codex'); await login('A');
      const old = requests('login')[0];
      await ui.open('opencode'); const next = login('O'); await tick();
      assert.equal(requests('login').length, 1);
      requests('cancel')[0].resolve({ cancelled: true }); await next;
      old.resolve({ label: 'old backend identity' }); await tick();
      assert.ok($('aaTitle').textContent.includes('opencode')); assert.ok($('aaFlowTitle').textContent.includes('O'));
      assert.equal(popups[1].closed, 0); assert.equal(requests('list').at(-1).args.backend, 'codex');
      const current = requests('login')[1];
      ui.authEvent({ backend: 'codex', accountId: 'O', loginId: current.args.attempt, phase: 'url', url: 'https://auth.example.invalid/wrong-backend' });
      assert.equal(popups[1].location.href, '');
      current.resolve({ label: 'O' }); await tick();
      check('backend changes cancel before dispatch, and old backend login completion cannot repaint the new flow');
    }
    {
      const ui = fresh(); await ui.open('codex'); await login('A');
      const stopping = cancel(); await tick(); requests('cancel')[0].reject(new Error('cancel failed')); await stopping;
      const retry = login('A'); await tick();
      assert.equal(requests('login').length, 1); assert.equal(requests('cancel').length, 2);
      requests('cancel')[1].resolve({ cancelled: true }); await retry;
      requests('login')[0].reject(new Error('cancelled old attempt')); requests('login')[1].resolve({ label: 'A' }); await tick();
      check('a failed cancellation retains attempt ownership and must be retried before another login can start');
    }
    {
      const ui = fresh(); autoLists = false;
      const openingA = ui.open('codex'); await tick();
      const openingB = ui.open('opencode'); await tick();
      requests('list')[1].resolve({ accounts: [account('O')] }); await openingB;
      beginForm('keep B form');
      requests('list')[0].resolve({ accounts: [account('A')] }); await openingA;
      assert.ok($('aaTitle').textContent.includes('opencode'));
      assert.equal($('aaName').value, 'keep B form'); assert.equal($('aaForm').hidden, false);
      assert.equal($('aaList').querySelector('strong').textContent, 'O');
      check('older panel-open response cannot repaint or reset another backend view');
    }
    for (const action of ['create', 'rename', 'remove']) {
      const ui = fresh(); await ui.open('codex');
      let pending;
      if (action === 'remove') {
        $('aaList').children[0].querySelectorAll('button')[2].onclick();
        pending = $('aaList').children[0].querySelectorAll('button').at(-1).onclick();
      } else {
        if (action === 'rename') $('aaList').children[0].querySelectorAll('button')[1].onclick();
        else beginForm('new A');
        $('aaName').value = 'changed A'; pending = submit();
      }
      await tick();
      await ui.open('opencode'); beginForm('keep O');
      requests(action)[0].resolve({ id: 'new-A', name: 'changed A' }); await pending; await tick();
      assert.equal($('aaName').value, 'keep O'); assert.equal($('aaForm').hidden, false);
      assert.equal(requests('login').length, 0);
      assert.equal(requests('list').at(-1).args.backend, 'codex');
      assert.deepEqual(changes, ['codex']);
      check(`delayed ${action} refreshes its original backend and preserves the new view's form without starting a hidden login`);
    }
    {
      const ui = fresh(); await ui.open('codex'); await login('A');
      const card = $('aaList').children[0]; card.querySelectorAll('button')[2].onclick();
      $('aaList').children[0].querySelectorAll('button').at(-1).onclick();
      requests('remove')[0].reject(new Error('account busy')); await tick();
      assert.equal($('aaFlow').hidden, false); assert.ok($('aaFlowTitle').textContent.includes('A'));
      assert.ok($('aaState').textContent.includes('account busy'));
      requests('login')[0].resolve({ label: 'A' }); await tick();
      check('refused deletion preserves visible login status and exposes the deletion error');
    }
    {
      const ui = fresh(); autoLists = false;
      const old = ui.load('codex', true); await tick();
      const newer = ui.load('codex', true); await tick();
      requests('list')[1].resolve({ accounts: [{ ...account('A'), hasCredential: true }] }); await newer;
      requests('list')[0].resolve({ accounts: [account('deleted')] }); await old;
      assert.deepEqual(ui.list('codex').map(a => a.id), ['A']); assert.equal(ui.list('codex')[0].hasCredential, true);
      const pending = ui.load('codex', true); await tick(); ui.invalidate();
      requests('list')[2].resolve({ accounts: [account('invalidated')] }); await pending;
      assert.deepEqual(ui.list('codex'), []);
      check('old and invalidated list responses cannot restore deleted accounts or stale credential flags');
    }
    {
      const reads = [], cache = createAccountRequestCache({ read: key => { const value = deferred(); reads.push({ key, ...value }); return value.promise; } });
      const old = cache.get('codex:A'); await tick(); cache.invalidate();
      const current = cache.get('codex:A', { force: true }); await tick();
      reads[1].resolve({ models: ['current'] }); await current;
      reads[0].reject(new Error('stale model request')); await old;
      assert.deepEqual(cache.cache.get('codex:A'), { models: ['current'] });
      const one = cache.get('codex:A', { force: true }); await tick();
      const two = cache.get('codex:A', { force: true }); await tick();
      reads[2].reject(new Error('older failed')); await tick();
      const shared = cache.get('codex:A', { force: false });
      reads[3].resolve({ models: ['newer'] }); await Promise.all([one, two, shared]);
      assert.equal(reads.length, 4); assert.deepEqual(cache.cache.get('codex:A'), { models: ['newer'] });
      check('model-cache generations reject stale success/error writes and preserve newer in-flight requests');
    }
    {
      const prefs = { backends: { codex: { account: 'default-A' } }, claudeAccount: 'legacy-token' };
      const base = { backend: 'codex', kind: 'agent', prefs };
      assert.equal(composerAccount(base), 'default-A');
      assert.equal(composerAccount({ ...base, draft: { account: 'draft-A' } }), 'draft-A');
      assert.equal(composerAccount({ ...base, draft: { account: '' } }), '');
      assert.equal(composerAccount({ ...base, session: { backend: 'codex', claudeAccount: 'session-A', nextSettings: { account: 'next-A' } } }), 'next-A');
      assert.equal(composerAccount({ ...base, session: { backend: 'other', claudeAccount: 'foreign', nextSettings: { backend: 'codex' } } }), '');
      assert.equal(composerAccount({ ...base, session: { backend: 'codex', claudeAccount: 'session-A' }, draft: { backend: 'other' } }), '');
      assert.equal(composerAccount({ ...base, homeBot: { backend: 'codex' }, draft: { account: 'draft-A' } }), '');
      assert.equal(composerAccount({ ...base, backend: 'claude', kind: 'token' }), 'legacy-token');
      assert.equal(composerAccount({ ...base, kind: false }), '');
      check('composer account priority matches draft, reservation, session, default and home-bot login policy');
    }
    {
      // Execute the actual client functions with transport/DOM boundaries only;
      // importing the whole client would start its application lifecycle.
      const source = await readFile(new URL('../../web/client.mjs', import.meta.url), 'utf8');
      const functionSource = name => {
        const match = new RegExp(`(?:async )?function ${name}\\(`).exec(source);
        assert.ok(match, name);
        return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
      };
      const accountReads = [], vocabReads = [], effortReads = [], headers = [];
      const state = { sessions: [], current: null, prefs: { backends: { codex: { account: 'default-A' } } }, draft: { changes: [] }, backendId: 'codex' };
      const homeDest = { paint() {}, bot: null };
      const sandbox = vm.createContext({ state, composerAccount, homeDest, topbarVersion: 0, bootHold: null,
        justCreated: () => false, unsentHere: () => true, activeBackendId: () => 'codex',
        capsOf: () => ({ accounts: 'agent', compatEndpoints: false }),
        $: id => { if (!nodes.has(id)) { const node = new Node('div'); node.id = id; } return $(id); },
        t: tr, syncParentEntry() {}, rememberTitle() {}, syncTitleControls() {}, controls: { paint() {} },
        headerUsage: { show: info => headers.push(info) }, refreshGit: async () => {}, refreshWorktree: async () => {},
        paintSettingsNotice() {}, renderSessions() {}, selectedMode: () => 'default',
        loadVocab: async (backend, account) => { vocabReads.push({ backend, account }); return { modes: { default: {} }, models: { '': {} } }; },
        cmd: async (op, args) => { assert.equal(op, 'efforts'); effortReads.push(args); return { '': {} }; },
        loadAccounts: backend => { const response = deferred(); accountReads.push({ backend, ...response }); return response.promise; },
        compatEndpoints: { load: async () => [] }, accountWarning: '', endpointWarning: '',
      });
      vm.runInContext(['draftView', 'endpointOf', 'composerSelection', 'syncEndpoint', 'syncAccount', 'syncTopbar'].map(functionSource).join('\n'), sandbox);
      const old = sandbox.syncTopbar(); await tick();
      assert.equal(accountReads.length, 1);
      state.prefs.backends.codex.account = 'default-B';
      const current = sandbox.syncTopbar(); await tick();
      accountReads[1].resolve([{ id: 'default-B', name: 'B', ready: true }]); await current;
      accountReads[0].resolve([{ id: 'default-A', name: 'A', ready: true }]); await old;
      assert.equal(state.account, 'default-B');
      assert.equal(vocabReads[0].account, 'default-A'); assert.equal(vocabReads[1].account, 'default-B');
      assert.equal(effortReads[1].account, 'default-B'); assert.equal(headers[1].account, 'default-B');
      homeDest.bot = { backend: 'codex', model: '', effort: '' };
      await sandbox.syncTopbar();
      assert.equal(vocabReads.at(-1).account, ''); assert.equal(effortReads.at(-1).account, '');
      assert.equal(headers.at(-1).account, ''); assert.equal(state.accountShown, false);
      check('real client synchronization uses the same effective account for header/models/efforts, discards stale account-list continuation and gives homeBot login priority');

      const modelReads = [], modelState = { vocab: new Map() };
      let refreshed = 0;
      const vocabSandbox = vm.createContext({ state: modelState, createAccountRequestCache,
        cmd: async (operation, args) => {
          if (operation === 'modes') return { ask: {} };
          assert.equal(operation, 'models'); const response = deferred(); modelReads.push({ args, ...response }); return response.promise;
        }, syncTopbar: async () => { refreshed++; },
      });
      const vocabStart = source.indexOf('const accountVocabs =');
      const vocabEnd = source.indexOf('// ----------------------------------------------------------------', vocabStart);
      vm.runInContext(source.slice(vocabStart, vocabEnd) + '\nglobalThis.vocabCaches = { accountVocabs, accountVocabRequests };', vocabSandbox);
      const older = vocabSandbox.loadVocab('codex', 'A'); await tick();
      vocabSandbox.revalidateVocab('codex', 'A'); await tick();
      modelReads[1].resolve({ latest: {} }); await tick();
      modelReads[0].resolve({ obsolete: {} }); await older;
      assert.deepEqual([...vocabSandbox.vocabCaches.accountVocabs.values()].map(v => Object.keys(v.models)), [['latest']]);
      assert.equal(modelState.vocab.size, 0); assert.equal(refreshed, 1);
      assert.ok(modelReads.every(r => r.args.account === 'A'));
      check('real client model revalidation refreshes only the selected account catalog and rejects older late model results');
    }
    {
      let opened = 0, signedIn = 0;
      const node = new Node('div');
      paintAuthFailure(node, { auth: { mode: 'account', name: 'A' }, reissue: () => opened++, login: () => signedIn++ });
      const button = node.querySelector('button');
      assert.equal(button.textContent, tr('chat.authExpired.openAccounts'));
      button.onclick({ stopPropagation() {} });
      assert.equal(opened, 1); assert.equal(signedIn, 0);
      check('account auth-expired action opens account settings without pretending to start a login or resend');
    }
  } finally {
    await i18n.setLanguage(originalLanguage);
    if (globals.document === undefined) delete globalThis.document; else globalThis.document = globals.document;
    if (globals.window === undefined) delete globalThis.window; else globalThis.window = globals.window;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await test({ ok: (label, value) => { assert.ok(value, label); console.log(`ok ${label}`); } });
}
