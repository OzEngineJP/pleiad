import { createRequire } from 'node:module';
export const name = 'right-panel-tabs';
export const title = '右の欄のタブの列と開け閉め（本物の画面とマウス・タッチ）';
export default async function(t) {
  if (process.env.B1_BROWSER_TEST !== '1') { t.note('Set B1_BROWSER_TEST=1 for the real-page Playwright checks.'); return; }
  const require = createRequire(import.meta.url);
  const playwright = process.env.B1_PLAYWRIGHT_PACKAGE
    ? createRequire(process.env.B1_PLAYWRIGHT_PACKAGE)('playwright-core') : require('playwright-core');
  const browser = await playwright.chromium.launch({ headless:true, ...(process.env.B1_CHROME ? { executablePath:process.env.B1_CHROME } : {}), args:['--use-angle=d3d11','--num-raster-threads=4'], ignoreDefaultArgs:['--hide-scrollbars'] });
  try {
    const { default: run } = await import('../browser/right-panel-tabs.mjs');
    await run({ browser, check:(label, result, detail) => t.ok(label, result, detail) });
  } finally { await browser.close(); }
}
