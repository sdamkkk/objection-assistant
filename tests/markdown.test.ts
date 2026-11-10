import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderNoticeMarkdown } from '../src/app/markdown.ts';

test('公告 Markdown 渲染：表格、页码分隔、重复标题、HTML 转义', () => {
  const src = '# 某公告\n\n<!-- page 1 -->\n\n## 某公告\n\n|项目|内容|\n|---|---|\n|限额|10,000元|\n\n<!-- page 2 -->\n\n说明 <script>alert(1)</script> 结束';
  const html = renderNoticeMarkdown(src);
  assert.equal((html.match(/某公告/g) ?? []).length, 1, '开头重复的标题只留一个');
  assert.match(html, /<table>/);
  assert.match(html, /<td>10,000元<\/td>/);
  assert.match(html, /class="md-page"[^>]*><span>第 2 页<\/span>/);
  assert.doesNotMatch(html, /第 1 页/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});

test('没有 Markdown 的纯文字按原样换行', () => {
  const html = renderNoticeMarkdown('第一行\n第二行');
  assert.match(html, /第一行<br>\s*第二行/);
});
