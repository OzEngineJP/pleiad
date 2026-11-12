import { createRequire } from 'node:module';
export const name = 'right-panel-motion-cost';
export const title = '右の欄の開け閉めの間に重い処理を走らせない（本物の画面。受け渡しは動き始めに量る・幅に反応する処理は止めて終わりに 1 度）';
export default async function(t) {
  if (process.env.B1_BROWSER_TEST !== '1') { t.note('Set B1_BROWSER_TEST=1 for the real-page Playwright checks.'); return; }
  const require = createRequire(import.meta.url);
  const playwright = process.env.B1_PLAYWRIGHT_PACKAGE
    ? createRequire(process.env.B1_PLAYWRIGHT_PACKAGE)('playwright-core') : require('playwright-core');
  const browser = await playwright.chromium.launch({ headless:true, ...(process.env.B1_CHROME ? { executablePath:process.env.B1_CHROME } : {}), args:['--use-angle=d3d11','--num-raster-threads=4'], ignoreDefaultArgs:['--hide-scrollbars'] });
  try {
    const { default: run } = await import('../browser/right-panel-motion-cost.mjs');
    await run({ browser, check:(label, result, detail) => t.ok(label, result, detail) });
  } finally { await browser.close(); }
}
