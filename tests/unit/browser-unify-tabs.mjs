import { createRequire } from 'node:module';
import { addressCrumbs } from '../../web/address-bar.mjs';
export const name = 'browser-unify-tabs';
export const title = 'Conversation browser tabs and responsive address bar';
export default async function(t) {
  t.ok('drive root remains an absolute breadcrumb', addressCrumbs('D:/dev/notes.md')[0].path === 'D:/');
  if (process.env.B1_BROWSER_TEST !== '1') { t.note('Set B1_BROWSER_TEST=1 for isolated Playwright checks.'); return; }
  const require = createRequire(import.meta.url);
  const playwright = process.env.B1_PLAYWRIGHT_PACKAGE
    ? createRequire(process.env.B1_PLAYWRIGHT_PACKAGE)('playwright-core') : require('playwright-core');
  const browser = await playwright.chromium.launch({ headless:true, ...(process.env.B1_CHROME ? {executablePath:process.env.B1_CHROME} : {}), args:['--use-angle=d3d11','--num-raster-threads=4'] });
  try { await require('../browser/browser-unify-tabs.cjs')({ browser, check:(label, result, detail) => t.ok(label, result, detail), screenshots:process.env.B1_SCREENSHOTS, mockShots:process.env.B1_MOCK_SHOTS }); }
  finally { await browser.close(); }
}
