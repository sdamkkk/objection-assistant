// 本地界面冒烟测试：用模拟后端跑一遍题目案例，检查关键界面元素并截图。
// 用法：node scripts/mock-server.mjs 4173 &  然后  node scripts/ui-smoke.mjs [截图目录]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw;
try {
  pw = require('playwright');
} catch {
  pw = require('/opt/npm-tools/node_modules/playwright');
}
const out = process.argv[2] || '.';
const base = process.env.BASE_URL || 'http://localhost:4173';

const browser = await pw.chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(base);
await page.screenshot({ path: `${out}/01-start.png` });
await page.getByRole('button', { name: /题目案例/ }).click();
await page.screenshot({ path: `${out}/02-form.png` });
await page.getByRole('button', { name: '使用这个案例' }).click();
await page.getByRole('button', { name: '两版话术（题目原话）' }).click();
await page.screenshot({ path: `${out}/03-ready.png` });
await page.getByRole('button', { name: '生成话术' }).click();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/04-running.png` });
await page.getByRole('button', { name: '换一个要求' }).waitFor({ timeout: 90000 });
await page.screenshot({ path: `${out}/05-process.png`, fullPage: true });
await page.getByRole('tab', { name: '结果' }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/06-result.png`, fullPage: true });
const marks = await page.locator('span.align-super button').count();
const badMarks = await page.locator('span.align-super button.text-seal').count();
console.log('citation marks:', marks, 'not found:', badMarks);
// 案例材料的角标：左栏高亮
await page.locator('span.align-super button').first().click();
await page.waitForTimeout(500);
console.log('highlight in case pane:', await page.locator('mark').count());
// 法规原文的角标：打开原件
await page.locator('li[id^="cite-"]', { hasText: 'R06' }).first().getByRole('button', { name: '查看原件' }).click();
await page.locator('canvas').first().waitFor({ timeout: 20000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/07-rule-original.png` });
await page.keyboard.press('Escape');
// 工具计算来源
await page.getByRole('button', { name: /工具计算 T13/ }).first().click();
await page.waitForTimeout(300);
console.log('tool detail:', await page.getByText(/T13 计算/).first().textContent());
// 运行记录
const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载运行记录' }).click()]);
await download.saveAs(`${out}/run-record.md`);
console.log('run record:', download.suggestedFilename());
// 窄屏
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/08-mobile.png` });
// 验证页
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto(`${base}/#/eval`);
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/09-eval.png` });
console.log('page errors:', errors.length ? errors : 'none');
await browser.close();
