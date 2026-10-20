// playwright-cli run-code --filename=tests/browser/remote-other-plus.cjs
// または node tests/browser/remote-other-plus.cjs
// 設定 › リモート「ほかの PC へ」の Plus ホスト（issue B6）:
//   - 未ログイン（Pleiad Plus にログイン）
//   - free（Pleiad Plus にする）
//   - disabled（このアカウントでは公式の中継を使えません）
//   - plus（オンライン 1 台、オフライン 1 台、自分の中継 1 台）
//   - 公式の中継を使うスイッチのオン／オフで Plus の行が出し入れされる
//   - maintenance（Pleiad Plus はメンテナンス中です）
//   - off（見出しごと消える）
//   - 「PC を追加」ウィザード: Plus 選択 -> 相手の待機 -> オンライン検出でチェックマークと名前 -> つなぎました完了
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SHOTS_DIR = process.env.SHOTS_DIR || 'D:/dev/pleiad/temporary/screenshots';

async function runTest(page, { isDirect = false } = {}) {
  const results = [];
  const check = (ok, label, detail) => {
    if (!ok) throw new Error(`${label}${detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`);
    results.push(label);
  };

  const shot = async (name) => {
    if (!SHOTS_DIR) return;
    try {
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      const target = path.join(SHOTS_DIR, `remote-other-plus-${name}.png`);
      await page.screenshot({ path: target, fullPage: true, animations: 'allow' });
    } catch (e) {
      console.warn(`screenshot failed for ${name}:`, e.message);
    }
  };

  const diag = await page.evaluate(() => ({
    hasDesktop: !!window.plyDesktop,
    hasHosts: !!window.plyDesktop?.hosts,
    plyRemote: !!window.plyRemote,
    remoteTab: !!document.getElementById('remoteTab'),
    remotePanel: !!document.getElementById('remotePanel'),
  }));
  console.log('Page Diagnostics:', diag);

  // 初回案内ダイアログがあれば確実に閉じてから設定を開く
  await page.evaluate(() => document.getElementById('onboardingDialog')?.close());
  await page.evaluate(() => document.getElementById('settings')?.click());
  await page.waitForFunction(() => document.body.classList.contains('settings'), { timeout: 10_000 });

  // リモート設定を開く
  await page.locator('#remoteTab').click();
  await page.waitForSelector('#remotePanel:not([hidden])', { timeout: 10_000 });

  // 「ほかの PC へ」タブへ切り替え
  const otherTabBtn = page.locator('#remotePanel button[data-fk="seg-other"]');
  await otherTabBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await otherTabBtn.click();
  await page.waitForTimeout(300);

  // 状態変更をブラウザ側の mockHosts に送るヘルパー
  const setMockState = async (state) => {
    await page.evaluate((s) => {
      window.__mockUpdate(s);
    }, state);
    await page.waitForTimeout(100);
  };

  const setTheme = async (theme) => {
    await page.evaluate((t) => {
      document.documentElement.dataset.theme = t;
    }, theme);
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(100);
  };

  // ================================================================
  // 1. 未ログイン（ログインしていない）
  // ================================================================
  await page.setViewportSize({ width: 1280, height: 800 });
  await setTheme('light');
  await setMockState({
    plus: { use: true, ok: false, available: true, status: null, email: null, hosts: [] },
    hosts: [
      { hostId: 'own-host-1', name: 'home-server', via: 'own', relay: 'relay.example.com', state: 'connected', lastConnectedAt: new Date().toISOString() },
    ],
  });

  // 見出し「Pleiad Plus」が表示されている
  const plusHead = page.locator('#remotePanel .rm-group .rm-gh:has-text("Pleiad Plus")');
  await plusHead.waitFor({ state: 'visible', timeout: 5_000 });
  check(await plusHead.isVisible(), '未ログイン: Pleiad Plus 見出しが表示される');

  // 「Pleiad Plus にログイン」が表示されている
  const loginRow = page.locator('#remotePanel .rm-group button:has-text("Pleiad Plus にログイン")');
  check(await loginRow.isVisible(), '未ログイン: Pleiad Plus にログイン 行が表示される');

  await shot('01-not-signed-in-light-1280');
  await setTheme('dark');
  await shot('01-not-signed-in-dark-1280');
  await page.setViewportSize({ width: 390, height: 800 });
  await shot('01-not-signed-in-dark-narrow');
  await setTheme('light');
  await shot('01-not-signed-in-light-narrow');

  // ================================================================
  // 2. status: free
  // ================================================================
  await page.setViewportSize({ width: 1280, height: 800 });
  await setTheme('light');
  await setMockState({
    plus: { use: true, ok: true, available: true, status: 'free', email: 'user@example.test', hosts: [] },
    hosts: [
      { hostId: 'own-host-1', name: 'home-server', via: 'own', relay: 'relay.example.com', state: 'connected' },
    ],
  });

  const upgradeRow = page.locator('#remotePanel .rm-group button:has-text("Pleiad Plus にする")');
  await upgradeRow.waitFor({ state: 'visible', timeout: 5_000 });
  check(await upgradeRow.isVisible(), 'free: Pleiad Plus にする が表示される');

  await shot('02-free-light-1280');
  await setTheme('dark');
  await shot('02-free-dark-1280');

  // ================================================================
  // 3. status: disabled
  // ================================================================
  await setTheme('light');
  await setMockState({
    plus: { use: true, ok: true, available: true, status: 'disabled', email: 'user@example.test', hosts: [] },
    hosts: [
      { hostId: 'own-host-1', name: 'home-server', via: 'own', relay: 'relay.example.com', state: 'connected' },
    ],
  });

  const disabledText = page.locator('#remotePanel :has-text("このアカウントでは公式の中継を使えません")').first();
  await disabledText.waitFor({ state: 'visible', timeout: 5_000 });
  check(await disabledText.isVisible(), 'disabled: このアカウントでは公式の中継を使えません が表示される');

  await shot('03-disabled-light-1280');
  await setTheme('dark');
  await shot('03-disabled-dark-1280');

  // ================================================================
  // 4. status: plus（2 台: 1 台オンライン、1 台オフライン、独自中継 1 台）
  // ================================================================
  await setTheme('light');
  await setMockState({
    plus: {
      use: true, ok: true, available: true, status: 'plus', email: 'user@example.test',
      hosts: [
        { hostId: 'plus-host-online', name: 'STUDIO-PC', online: true, platform: 'desktop', createdAt: '2026-10-01T00:00:00Z' },
        { hostId: 'plus-host-offline', name: 'LAPTOP-OFFLINE', online: false, platform: 'desktop', createdAt: '2026-10-02T00:00:00Z' },
      ],
    },
    hosts: [
      { hostId: 'plus-host-online', name: 'STUDIO-PC', via: 'plus', state: 'connected', plusOnline: true, lastConnectedAt: new Date().toISOString() },
      { hostId: 'plus-host-offline', name: 'LAPTOP-OFFLINE', via: 'plus', state: 'offline', plusOnline: false, lastConnectedAt: null },
      { hostId: 'own-host-1', name: 'home-server', via: 'own', relay: 'relay.example.com', state: 'connected', lastConnectedAt: new Date().toISOString() },
    ],
  });

  const studioPc = page.locator('#remotePanel .rm-group .rm-nm:has-text("STUDIO-PC")');
  await studioPc.waitFor({ state: 'visible', timeout: 5_000 });
  check(await studioPc.isVisible(), 'plus: STUDIO-PC が表示される');

  const laptopOffline = page.locator('#remotePanel .rm-group .rm-nm:has-text("LAPTOP-OFFLINE")');
  check(await laptopOffline.isVisible(), 'plus: LAPTOP-OFFLINE が表示される');

  const offlineSub = page.locator('#remotePanel .rm-group .rm-row:has-text("LAPTOP-OFFLINE") .rm-sub:has-text("オフライン")');
  check(await offlineSub.isVisible(), 'plus: オフラインの文言が表示される');

  const ownGroup = page.locator('#remotePanel .rm-group .rm-gh:has-text("自分の中継")');
  check(await ownGroup.isVisible(), '自分の中継 見出しが表示される');
  const ownPc = page.locator('#remotePanel .rm-group .rm-nm:has-text("home-server")');
  check(await ownPc.isVisible(), '自分の中継: home-server が表示される');

  await shot('04-plus-hosts-light-1280');
  await setTheme('dark');
  await shot('04-plus-hosts-dark-1280');
  await page.setViewportSize({ width: 390, height: 800 });
  await shot('04-plus-hosts-dark-narrow');
  await setTheme('light');
  await shot('04-plus-hosts-light-narrow');

  // ================================================================
  // 5. スイッチ「公式の中継を使う」のオン／オフ
  // ================================================================
  await page.setViewportSize({ width: 1280, height: 800 });
  const plusSwitch = page.locator('#remotePanel button[data-fk="plusConnect"]');
  check(await plusSwitch.isVisible(), 'スイッチ: 公式の中継を使う スイッチが存在する');
  check(await plusSwitch.getAttribute('aria-checked') === 'true', 'スイッチ: 初期状態は ON');

  // スイッチをクリックして OFF にする
  await plusSwitch.click();
  await page.waitForTimeout(200);

  // Plus のホスト行が消える
  check(await page.locator('#remotePanel .rm-nm:has-text("STUDIO-PC")').count() === 0, 'スイッチ OFF: STUDIO-PC が消える');
  check(await page.locator('#remotePanel .rm-nm:has-text("LAPTOP-OFFLINE")').count() === 0, 'スイッチ OFF: LAPTOP-OFFLINE が消える');
  check(await ownPc.isVisible(), 'スイッチ OFF: 自分の中継の PC は残る');

  await shot('05-switch-off-light-1280');

  // スイッチを再度クリックして ON にする
  await plusSwitch.click();
  await page.waitForTimeout(200);
  check(await studioPc.isVisible(), 'スイッチ ON: STUDIO-PC が再表示される');

  // ================================================================
  // 6. state: maintenance
  // ================================================================
  await setMockState({
    plus: { use: true, ok: true, state: 'maintenance', available: true, status: 'plus', email: 'user@example.test', hosts: [] },
    hosts: [
      { hostId: 'own-host-1', name: 'home-server', via: 'own', relay: 'relay.example.com', state: 'connected' },
    ],
  });

  const maintenanceText = page.locator('#remotePanel :has-text("Pleiad Plus はメンテナンス中です")').first();
  await maintenanceText.waitFor({ state: 'visible', timeout: 5_000 });
  check(await maintenanceText.isVisible(), 'maintenance: Pleiad Plus はメンテナンス中です が表示される');

  await shot('06-maintenance-light-1280');

  // ================================================================
  // 7. state: off（または available: false）
  // ================================================================
  await setMockState({
    plus: { use: true, ok: true, state: 'off', available: false, status: 'plus', email: 'user@example.test', hosts: [] },
    hosts: [
      { hostId: 'own-host-1', name: 'home-server', via: 'own', relay: 'relay.example.com', state: 'connected' },
    ],
  });

  await page.waitForTimeout(200);
  check(await page.locator('#remotePanel .rm-gh:has-text("Pleiad Plus")').count() === 0, 'off: Pleiad Plus 見出しごと出ない');
  check(await ownPc.isVisible(), 'off: 自分の中継は引き続き表示される');

  // ================================================================
  // 8. 「PC を追加」の手順（ウィザード）
  // ================================================================
  // 状態を通常 Plus に戻す
  await setMockState({
    plus: {
      use: true, ok: true, available: true, status: 'plus', email: 'user@example.test',
      hosts: [
        { hostId: 'plus-host-online', name: 'STUDIO-PC', online: true, platform: 'desktop', createdAt: '2026-10-01T00:00:00Z' },
      ],
    },
    hosts: [
      { hostId: 'plus-host-online', name: 'STUDIO-PC', via: 'plus', state: 'connected', plusOnline: true },
      { hostId: 'own-host-1', name: 'home-server', via: 'own', relay: 'relay.example.com', state: 'connected' },
    ],
  });

  // ＋ ボタン（PC を追加）を押す
  const addBtn = page.locator('#remotePanel button[data-fk="add"]');
  await addBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await addBtn.click();

  // Step 1: アプリを入れる
  const wizardDialog = page.locator('dialog#remoteAddHost');
  await wizardDialog.waitFor({ state: 'visible', timeout: 5_000 });
  check(await wizardDialog.isVisible(), 'ウィザード: 開いた');

  // Step 1 の「次へ」
  const nextBtn = page.locator('dialog#remoteAddHost button[data-fk="next"]');
  await nextBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await nextBtn.click();

  // Step 2: つなぎ方
  const methodRadioPlus = page.locator('dialog#remoteAddHost [role="radio"][data-fk="plus"]');
  await methodRadioPlus.waitFor({ state: 'visible', timeout: 5_000 });
  check(await methodRadioPlus.isVisible(), 'ウィザード Step 2: Pleiad Plus の選択肢がある');
  check(await page.locator('dialog#remoteAddHost :has-text("user@example.test")').first().isVisible(), 'ウィザード Step 2: アカウントのメールが表示される');

  await methodRadioPlus.click();
  await page.waitForTimeout(100);

  await shot('08-wizard-step2-method-light');
  await setTheme('dark');
  await shot('08-wizard-step2-method-dark');
  await setTheme('light');

  // Step 2 の「次へ」
  await nextBtn.click();

  // Step 3: つなぐ（待っている）
  const waitingText = page.locator('dialog#remoteAddHost :has-text("相手の PC を待っています")').first();
  await waitingText.waitFor({ state: 'visible', timeout: 5_000 });
  check(await waitingText.isVisible(), 'ウィザード Step 3: 相手の PC を待っています が表示される');

  // 案内文の検証: 「ほかの PC からの操作を許可する」が含まれること
  const guideText = page.locator('dialog#remoteAddHost .rm-lead');
  check((await guideText.textContent()).includes('ほかの端末からの操作を許可する'), 'ウィザード Step 3: スイッチ名を含む案内文が表示される');

  // 「次へ」ボタンが disabled であること
  check(await nextBtn.isDisabled(), 'ウィザード Step 3: 検出前は次へボタンが無効');

  await shot('08-wizard-step3-waiting-light');
  await setTheme('dark');
  await shot('08-wizard-step3-waiting-dark');
  await setTheme('light');

  // 相手の PC（新ホスト）を検出させる
  const newHostId = 'new-desktop-host-999';
  await setMockState({
    plus: {
      use: true, ok: true, available: true, status: 'plus', email: 'user@example.test',
      hosts: [
        { hostId: 'plus-host-online', name: 'STUDIO-PC', online: true, platform: 'desktop', createdAt: '2026-10-01T00:00:00Z' },
        { hostId: newHostId, name: 'NEW-DESKTOP', online: true, platform: 'desktop', createdAt: '2026-10-21T00:00:00Z' },
      ],
    },
  });

  // 相手の名前が表示され、青チェックマーク（.rm-ok）が出る
  const foundName = page.locator('dialog#remoteAddHost .rm-nm:has-text("NEW-DESKTOP")');
  await foundName.waitFor({ state: 'visible', timeout: 5_000 });
  check(await foundName.isVisible(), 'ウィザード Step 3: 検出されたホスト名 NEW-DESKTOP が表示される');

  const checkMark = page.locator('dialog#remoteAddHost .rm-end.rm-ok');
  check(await checkMark.isVisible(), 'ウィザード Step 3: 青いチェックマークが表示される');
  check(!await nextBtn.isDisabled(), 'ウィザード Step 3: 検出後は次へボタンが有効になる');

  await shot('08-wizard-step3-found-light');
  await setTheme('dark');
  await shot('08-wizard-step3-found-dark');
  await setTheme('light');

  // Step 3 の「次へ」をクリック -> Step 4（完了）
  await nextBtn.click();

  // Step 4: 完了
  const doneTitle = page.locator('dialog#remoteAddHost :has-text("NEW-DESKTOP をつなぎました")').first();
  await doneTitle.waitFor({ state: 'visible', timeout: 5_000 });
  check(await doneTitle.isVisible(), 'ウィザード Step 4: NEW-DESKTOP をつなぎました が表示される');

  const closeBtn = page.locator('dialog#remoteAddHost button[data-fk="next"]');
  check(await closeBtn.isVisible(), 'ウィザード Step 4: 閉じる ボタンが表示される');

  await shot('08-wizard-step4-done-light');
  await setTheme('dark');
  await shot('08-wizard-step4-done-dark');
  await setTheme('light');

  // 閉じるをクリック
  await closeBtn.click();
  await page.waitForTimeout(200);
  check(await wizardDialog.evaluate(d => !d.open), 'ウィザード Step 4: 閉じるとダイアログが閉じる');

  return { passed: true, checks: results };
}

module.exports = async (page) => {
  return runTest(page);
};

// Node スクリプトとして直接起動された場合（playwright-cli を通さずに実行可能）
if (require.main === module) {
  (async () => {
    const { startServer } = await import('../lib/server.mjs');
    const PW = process.env.PW_CORE || 'C:/Program Files/nodejs/node_modules/@playwright/cli/node_modules/playwright-core';
    const { chromium } = require(PW);

    function findChromium() {
      const base = path.join(os.homedir(), 'AppData/Local/ms-playwright');
      if (!fs.existsSync(base)) return undefined;
      const dirs = fs.readdirSync(base).filter(d => d.startsWith('chromium-') || d.startsWith('chromium_headless_shell-')).sort();
      for (const dir of dirs.reverse()) {
        const p1 = path.join(base, dir, 'chrome-win64/chrome.exe');
        if (fs.existsSync(p1)) return p1;
        const p2 = path.join(base, dir, 'chrome-headless-shell-win64/chrome-headless-shell.exe');
        if (fs.existsSync(p2)) return p2;
      }
      return undefined;
    }

    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pleiad-browser-test-'));
    // あらかじめ onboarding 完了済みの印を置いておく
    fs.writeFileSync(path.join(scratch, 'onboarding.json'), JSON.stringify({ setupComplete: true, seen: true }));

    console.log('Starting test server...');
    const server = await startServer({
      dataDir: scratch,
      env: { AGENT_HOST_BACKENDS: 'fake', AGENT_HOST_LOCALE: 'ja' },
    });

    const url = `http://127.0.0.1:${server.port}/?token=${encodeURIComponent(server.token)}`;
    console.log(`Server started at ${url}`);
    const browser = await chromium.launch({
      headless: true,
      executablePath: findChromium(),
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
    page.on('pageerror', err => console.error('BROWSER ERROR STACK:', err.stack));

    // mockHostsApi を注入
    await page.addInitScript(() => {
      let state = {
        plus: { use: true, ok: false, available: true, status: null, email: null, hosts: [] },
        hosts: [],
      };
      const changeListeners = [];
      const codeListeners = [];

      const getVisibleHosts = () => (state.plus.use !== false
        ? state.hosts
        : state.hosts.filter(h => (h.via ?? 'own') !== 'plus'));

      window.__mockUpdate = (patch) => {
        if (patch.plus) state.plus = { ...state.plus, ...patch.plus };
        if (patch.hosts) state.hosts = patch.hosts;
        for (const fn of changeListeners) fn({ hosts: getVisibleHosts(), plus: state.plus });
      };

      window.plyDesktop = {
        platform: 'win32',
        setTitleBar: () => {},
        notifyCompletion: () => {},
        onNotificationClick: () => {},
        chooseFolder: async () => null,
        openRemoteHosts: async () => {},
        hosts: {
          init: async () => ({ ok: true, hosts: getVisibleHosts(), plus: state.plus, encrypted: true }),
          list: async ({ fresh } = {}) => ({ ok: true, hosts: getVisibleHosts(), plus: state.plus }),
          setPlusUse: async (use) => {
            state.plus.use = use;
            for (const fn of changeListeners) fn({ hosts: getVisibleHosts(), plus: state.plus });
            return { ok: true, use };
          },
          admit: async (hostId) => {
            const h = { hostId, name: 'NEW-DESKTOP', via: 'plus', state: 'connected' };
            state.hosts.push(h);
            return { ok: true, host: h };
          },
          pair: async () => ({ ok: true }),
          cancelPair: async () => ({ ok: true }),
          open: async (hostId, opts) => ({ ok: true }),
          rename: async (hostId, label, via) => ({ ok: true }),
          remove: async (hostId, via) => ({ ok: true }),
          onCode: (fn) => codeListeners.push(fn),
          onChange: (fn) => changeListeners.push(fn),
          onOpen: () => {},
        },
      };
    });

    try {
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForTimeout(1500);
      const res = await runTest(page, { isDirect: true });
      console.log('Test PASSED!');
      console.log('Passed checks count:', res.checks.length);
    } catch (e) {
      console.error('Test FAILED:', e);
      process.exitCode = 1;
    } finally {
      await browser.close().catch(() => {});
      await server.stop().catch(() => {});
      try { fs.rmSync(scratch, { recursive: true, force: true }); } catch {}
    }
  })();
}
