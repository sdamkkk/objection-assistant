// 左栏"文字"视图：把公告的 Markdown（按原件版面还原，含表格）渲染出来；
// 没有 Markdown 的（粘贴的文字）按原样换行显示。点引用角标时，在渲染后的文字里定位并高亮。

import { useEffect, useMemo, useRef } from 'react';
import { highlightQuote, renderNoticeMarkdown } from './markdown.ts';

export function MarkdownView({ markdown, text, quote, className = '', onLocate }: { markdown?: string; text: string; quote?: string; className?: string; onLocate?: (found: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderNoticeMarkdown(markdown ?? text), [markdown, text]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = html;
    if (!quote) return;
    const mark = highlightQuote(el, quote);
    onLocate?.(Boolean(mark));
    mark?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [html, quote]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={ref} className={`md ${className}`} />;
}
