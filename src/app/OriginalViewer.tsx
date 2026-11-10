// 查看原件：PDF 原件直接渲染那一页并高亮引文；Word 原件和文字材料显示原文并高亮。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { citationLabel, type Citation } from '../core/citations.ts';
import type { CitableDoc } from '../core/kb.ts';
import { isTextItem, type TextItemLike } from '../core/pdftext.ts';
import { normalize } from '../core/textfind.ts';

export interface ViewerTarget {
  doc: CitableDoc;
  citation?: Citation;
  /** 打开时显示的段序号（1 起算，对应 doc.paged 的页） */
  index?: number;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const pdfCache = new Map<string, Promise<PDFDocumentProxy>>();

export interface PdfSource {
  fileUrl?: string;
  fileData?: ArrayBuffer;
}

async function openDoc(doc: PdfSource): Promise<PDFDocumentProxy> {
  const { openPdf } = await import('./pdf.ts');
  if (doc.fileData) return openPdf({ data: doc.fileData });
  const url = doc.fileUrl!;
  let p = pdfCache.get(url);
  if (!p) {
    p = openPdf({ url });
    p.catch(() => pdfCache.delete(url));
    pdfCache.set(url, p);
  }
  return p;
}

/** 在一页的文字块里找引文的位置；整段不在本页的（跨页），高亮在本页的那一部分。 */
async function findRects(page: PDFPageProxy, scale: number, needle: string, allowPartial = true): Promise<Rect[]> {
  const { Util } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const viewport = page.getViewport({ scale });
  const content = await page.getTextContent();
  const items = (content.items as unknown[]).filter(isTextItem) as TextItemLike[];
  let key = '';
  const map: { i: number; c: number }[] = [];
  items.forEach((it, i) => {
    const n = normalize(it.str);
    for (let j = 0; j < n.text.length; j++) {
      key += n.text[j];
      map.push({ i, c: n.map[j] });
    }
  });
  const q = normalize(needle).text;
  if (!q) return [];
  let start = key.indexOf(q);
  let len = q.length;
  if (start < 0 && allowPartial) {
    for (let L = q.length - 1; L >= Math.min(6, q.length); L--) {
      const pre = key.indexOf(q.slice(0, L));
      if (pre >= 0) {
        start = pre;
        len = L;
        break;
      }
      const suf = key.indexOf(q.slice(q.length - L));
      if (suf >= 0) {
        start = suf;
        len = L;
        break;
      }
    }
  }
  if (start < 0) return [];
  const spans = new Map<number, { min: number; max: number }>();
  for (const m of map.slice(start, start + len)) {
    const s = spans.get(m.i);
    if (s) {
      s.min = Math.min(s.min, m.c);
      s.max = Math.max(s.max, m.c);
    } else spans.set(m.i, { min: m.c, max: m.c });
  }
  const rects: Rect[] = [];
  for (const [i, s] of spans) {
    const it = items[i];
    const tx = Util.transform(viewport.transform, it.transform);
    const fontH = Math.hypot(tx[2], tx[3]) || 10;
    const w = it.width * viewport.scale;
    const n = it.str.length || 1;
    rects.push({ left: tx[4] + (w * s.min) / n, top: tx[5] - fontH * 0.95, width: Math.max((w * (s.max + 1 - s.min)) / n, 2), height: fontH * 1.2 });
  }
  return rects;
}

function PdfPageView({ doc, pageNo, needle }: { doc: CitableDoc; pageNo: number; needle?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rects, setRects] = useState<Rect[]>([]);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [err, setErr] = useState('');
  const [total, setTotal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setErr('');
    setRects([]);
    (async () => {
      const pdf = await openDoc(doc);
      if (cancelled) return;
      setTotal(pdf.numPages);
      const page = await pdf.getPage(Math.min(Math.max(pageNo, 1), pdf.numPages));
      const width = Math.min(wrapRef.current?.clientWidth ?? 760, 900);
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setSize({ w: viewport.width, h: viewport.height });
      const ctx = canvas.getContext('2d')!;
      await page.render({ canvasContext: ctx, canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
      if (needle && !cancelled) setRects(await findRects(page, scale, needle));
    })().catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [doc, pageNo, needle]);

  useEffect(() => {
    if (rects.length && wrapRef.current) {
      const top = Math.min(...rects.map((r) => r.top));
      wrapRef.current.closest('[data-scroll]')?.scrollTo({ top: Math.max(top - 120, 0), behavior: 'smooth' });
    }
  }, [rects]);

  return (
    <div ref={wrapRef} className="relative mx-auto w-full">
      {err && <div className="text-[13px] text-seal">原件没有打开：{err}</div>}
      <div className="relative mx-auto shadow-sm ring-1 ring-rule" style={size ? { width: size.w, height: size.h } : undefined}>
        <canvas ref={canvasRef} className="block" />
        {rects.map((r, i) => (
          <div key={i} className="pointer-events-none absolute rounded-[2px] bg-amber/35 mix-blend-multiply ring-1 ring-amber/60" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
        ))}
      </div>
      {total > 0 && <div className="mt-1 text-center text-[12px] text-muted">原件第 {pageNo} 页，共 {total} 页{needle && !rects.length ? '（本页没有定位到引文）' : ''}</div>}
    </div>
  );
}

function TextChunkView({ text, excerpt }: { text: string; excerpt?: string }) {
  const markRef = useRef<HTMLElement>(null);
  const range = useMemo(() => {
    if (!excerpt) return null;
    const i = text.indexOf(excerpt);
    return i >= 0 ? { start: i, end: i + excerpt.length } : null;
  }, [text, excerpt]);
  useEffect(() => {
    markRef.current?.scrollIntoView({ block: 'center' });
  }, [range]);
  return (
    <article className="doc whitespace-pre-wrap rounded-2xl border border-rule bg-paper/60 px-5 py-4 text-[14.5px]">
      {range ? (
        <>
          {text.slice(0, range.start)}
          <mark ref={markRef}>{text.slice(range.start, range.end)}</mark>
          {text.slice(range.end)}
        </>
      ) : (
        text
      )}
    </article>
  );
}

export function OriginalViewer({ target, onClose }: { target: ViewerTarget; onClose: () => void }) {
  const { doc, citation } = target;
  const count = doc.paged.pageCount;
  // 引文所在的那一段
  const citedIdx = useMemo(() => {
    if (!citation) return undefined;
    const first = doc.location(1).page;
    if (citation.page && first) return citation.page - first + 1;
    if (citation.location) return Array.from({ length: count }, (_, i) => i + 1).find((i) => doc.location(i).label === citation.location);
    return undefined;
  }, [citation, doc, count]);
  const [idx, setIdx] = useState(Math.min(Math.max(target.index ?? citedIdx ?? 1, 1), count));
  const loc = doc.location(idx);
  const isPdf = (doc.format === 'pdf' || (!doc.format && Boolean(doc.fileUrl))) && Boolean(doc.fileUrl || doc.fileData);
  const pdfPage = loc.page ?? idx;
  const needle = citation?.found && (citedIdx === undefined || citedIdx === idx) ? citation.excerpt : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-ink/40 p-0 sm:p-4" role="dialog" aria-modal="true" aria-label="查看原件" onClick={onClose}>
      <div className="flex w-full max-w-[980px] flex-col overflow-hidden bg-sheet shadow-xl sm:rounded" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-rule px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[15px] font-semibold">{citation ? `[${citation.n}] ` : ''}{citation ? citationLabel(citation) : doc.title}</div>
            {citation && (
              <div className="mt-1 space-y-0.5 text-[13px]">
                {citation.found ? (
                  <div className="text-ink-soft">
                    原件中的文字：<span className="text-ink">“{citation.excerpt}”</span>
                  </div>
                ) : (
                  <div className="text-seal">
                    {citation.problem}
                    {citation.closest ? `原文中最接近的一段：“${citation.closest}”` : ''}
                  </div>
                )}
                {citation.found && citation.problem && <div className="text-seal">{citation.problem}</div>}
              </div>
            )}
          </div>
          <button className="btn btn-quiet shrink-0 text-[13px]" onClick={onClose} aria-label="关闭">
            关闭
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-rule px-4 py-2 text-[13px]">
          <button className="btn btn-quiet" disabled={idx <= 1} onClick={() => setIdx((i) => i - 1)}>
            上一{doc.format === 'doc' ? '章' : '页'}
          </button>
          <span className="text-ink-soft">{loc.label}</span>
          <button className="btn btn-quiet" disabled={idx >= count} onClick={() => setIdx((i) => i + 1)}>
            下一{doc.format === 'doc' ? '章' : '页'}
          </button>
          <span className="flex-1" />
          {doc.fileUrl && (
            <a className="text-indigo hover:underline" href={doc.fileUrl} target="_blank" rel="noreferrer">
              打开原件
            </a>
          )}
          {(doc.sourcePage || doc.sourceUrl) && (
            <a className="text-indigo hover:underline" href={doc.sourcePage || doc.sourceUrl} target="_blank" rel="noreferrer">
              发布出处
            </a>
          )}
        </div>
        <div data-scroll className="min-h-0 flex-1 overflow-auto bg-paper px-3 py-4 sm:px-6">
          {isPdf ? <PdfPageView doc={doc} pageNo={pdfPage} needle={needle} /> : <TextChunkView text={doc.paged.pages[idx - 1] ?? ''} excerpt={needle} />}
          <p className="mt-3 text-center text-[12px] text-muted">
            {isPdf
              ? '上面是原件的页面图像；高亮位置按原件的文字层定位。'
              : doc.format === 'doc'
                ? '原件为 Word 文档，这里显示从原件中提取的文字，可点“打开原件”下载核对。'
                : '这份材料是文字形式，这里显示原文。'}
          </p>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 左栏：整份原件

/** 一页：进入可视区域附近才渲染，避免长文件一次画完。 */
function LazyPdfPage(props: { pdf: PDFDocumentProxy; pageNo: number; width: number; ratio: number; rects: Rect[]; root: HTMLElement | null; anchor: (el: HTMLDivElement | null) => void }) {
  const { pdf, pageNo, width, ratio, rects, root } = props;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [height, setHeight] = useState(Math.round(width * ratio));

  useEffect(() => {
    const el = boxRef.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((es) => es.some((e) => e.isIntersecting) && setVisible(true), { root, rootMargin: '900px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [root, visible]);

  useEffect(() => {
    if (!visible || !width) return;
    let cancelled = false;
    (async () => {
      const page = await pdf.getPage(pageNo);
      const base = page.getViewport({ scale: 1 });
      const scale = width / base.width;
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      if (!canvas || cancelled) return;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setHeight(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d')!, canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined }).promise;
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [visible, pdf, pageNo, width]);

  return (
    <div
      ref={(el) => {
        boxRef.current = el;
        props.anchor(el);
      }}
      data-page={pageNo}
      className="relative mx-auto bg-white shadow-[0_1px_3px_rgba(29,39,66,0.12)] ring-1 ring-rule"
      style={{ width, height }}
    >
      <canvas ref={canvasRef} className="block" />
      {rects.map((r, i) => (
        <div key={i} className="pointer-events-none absolute rounded-[2px] bg-amber/35 mix-blend-multiply ring-1 ring-amber/60" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
      ))}
    </div>
  );
}

/**
 * 整份 PDF 原件，逐页向下排列（左栏默认的显示方式）。
 * needle：要高亮的引文；会先找整句完全一致的页，找不到再按部分匹配。
 */
export function PdfDocView({ src, needle, className = '', onLocate }: { src: PdfSource; needle?: string; className?: string; onLocate?: (found: boolean) => void }) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [root, setRoot] = useState<HTMLElement | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [ratio, setRatio] = useState(1.414);
  const [width, setWidth] = useState(0);
  const [err, setErr] = useState('');
  const [hit, setHit] = useState<{ page: number; rects: Rect[] } | null>(null);
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const attachScroll = useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setRoot(el);
  }, []);

  useEffect(() => {
    let alive = true;
    setPdf(null);
    setErr('');
    openDoc(src)
      .then(async (d) => {
        const first = await d.getPage(1);
        const v = first.getViewport({ scale: 1 });
        if (!alive) return;
        setRatio(v.height / v.width);
        setPdf(d);
      })
      .catch((e) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [src.fileUrl, src.fileData]); // eslint-disable-line react-hooks/exhaustive-deps

  // 跟随容器宽度
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(Math.floor((el.clientWidth - 32) / 10) * 10, 200));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 定位引文所在的页
  useEffect(() => {
    if (!pdf || !width) return;
    if (!needle) {
      setHit(null);
      return;
    }
    let cancelled = false;
    (async () => {
      for (const partial of [false, true]) {
        for (let p = 1; p <= pdf.numPages; p++) {
          const page = await pdf.getPage(p);
          const scale = width / page.getViewport({ scale: 1 }).width;
          const rects = await findRects(page, scale, needle, partial);
          if (cancelled) return;
          if (rects.length) {
            setHit({ page: p, rects });
            onLocate?.(true);
            const el = pageEls.current.get(p);
            const box = scrollRef.current;
            if (el && box) box.scrollTo({ top: Math.max(el.offsetTop + Math.min(...rects.map((r) => r.top)) - 140, 0), behavior: 'smooth' });
            return;
          }
        }
      }
      if (!cancelled) {
        setHit(null);
        onLocate?.(false);
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [pdf, needle, width]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={attachScroll} data-scroll
      className={`overflow-auto ${className}`}
    >
      {err && <div className="p-4 text-[13px] text-seal">原件没有打开：{err}</div>}
      {!pdf && !err && <div className="p-6 text-center text-[13px] text-muted">正在打开原件…</div>}
      {pdf && width > 0 && (
        <div className="flex flex-col items-center gap-3 px-4 py-4">
          {Array.from({ length: pdf.numPages }, (_, i) => i + 1).map((p) => (
            <LazyPdfPage
              key={`${p}:${width}`}
              pdf={pdf}
              pageNo={p}
              width={width}
              ratio={ratio}
              root={root}
              rects={hit?.page === p ? hit.rects : []}
              anchor={(el) => {
                if (el) pageEls.current.set(p, el);
                else pageEls.current.delete(p);
              }}
            />
          ))}
          <div className="text-[12px] text-muted">共 {pdf.numPages} 页</div>
        </div>
      )}
    </div>
  );
}
