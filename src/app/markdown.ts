// 公告 Markdown 的渲染和引文高亮（不含 React，便于在 Node 中测试）。

import { Marked } from 'marked';
import { normalize } from '../core/textfind.ts';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // 原文里的尖括号等按文字显示，不当成 HTML
    html: ({ text }) => escapeHtml(text),
  },
});

const PAGE = /<!--\s*page\s+(\d+)\s*-->/g;

/** Markdown → HTML：页码标记变成分隔线，开头重复的标题只留一个。 */
export function renderNoticeMarkdown(src: string): string {
  let text = src.replace(/\r\n/g, '\n');
  // 转换时常把标题写成 "# 标题" 紧接 "## 标题"，去掉重复的那一个
  const m = text.match(/^#\s+(.+)\n+(?:<!--[^\n]*-->\n+)?##\s+(.+)\n/);
  if (m && m[1].trim() === m[2].trim()) text = text.replace(/^#\s+.+\n+/, '');
  text = text.replace(PAGE, (_, n) => (n === '1' ? '' : `\n\n@@PAGE ${n}@@\n\n`));
  const html = md.parse(text, { async: false }) as string;
  return html.replace(/<p>@@PAGE (\d+)@@<\/p>/g, '<div class="md-page" aria-label="第 $1 页"><span>第 $1 页</span></div>');
}

/** 在容器的文字里找引文（忽略空白、全半角差异），把找到的部分包上 <mark>。返回是否找到。 */
export function highlightQuote(root: HTMLElement, quote: string): HTMLElement | null {
  const nodes: { node: Text; start: number }[] = [];
  let raw = '';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (t.parentElement?.closest('.md-page')) continue;
    nodes.push({ node: t, start: raw.length });
    raw += t.data;
  }
  const hay = normalize(raw);
  const q = normalize(quote).text;
  if (!q) return null;
  let s = hay.text.indexOf(q);
  let len = q.length;
  if (s < 0) {
    // 整句找不到时（比如跨了表格单元格），退而求其次，找最长的开头或结尾片段
    for (let L = q.length - 1; L >= Math.min(6, q.length); L--) {
      const a = hay.text.indexOf(q.slice(0, L));
      if (a >= 0) {
        s = a;
        len = L;
        break;
      }
      const b = hay.text.indexOf(q.slice(q.length - L));
      if (b >= 0) {
        s = b;
        len = L;
        break;
      }
    }
  }
  if (s < 0) return null;
  const from = hay.map[s];
  const to = hay.map[s + len - 1] + 1;
  let first: HTMLElement | null = null;
  // 从后往前包，避免切分文字节点后偏移失效
  for (let i = nodes.length - 1; i >= 0; i--) {
    const { node, start } = nodes[i];
    const end = start + node.data.length;
    if (end <= from || start >= to) continue;
    const a = Math.max(from - start, 0);
    const b = Math.min(to - start, node.data.length);
    const mid = node.splitText(a);
    mid.splitText(b - a);
    const mark = document.createElement('mark');
    mid.parentNode!.replaceChild(mark, mid);
    mark.appendChild(mid);
    first = mark;
  }
  return first;
}

