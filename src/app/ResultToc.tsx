// 结果目录：右下角的浮动按钮，点开是章节列表浮窗，点击跳转到对应章节，并高亮当前所在章节。

import { useCallback, useEffect, useRef, useState } from 'react';

export interface TocEntry {
  /** 章节锚点的 DOM id */
  id: string;
  title: string;
  /** 读者或补充说明，例如"给客服""共 6 处" */
  sub?: string;
  /** 章节编号，概览类章节可以不编号 */
  no?: number;
  /** 未解决的问题数，标红提示 */
  must?: number;
  /** 检查建议数 */
  suggest?: number;
}

/** 视口顶部往下这么多像素以内，算作"正在看这一章" */
const ACTIVE_OFFSET = 140;

export function scrollToAnchor(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

function useActiveChapter(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (ids.length === 0) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      let current: string | null = null;
      for (const id of ids) {
        const el = document.getElementById(id);
        if (!el) continue;
        if (el.getBoundingClientRect().top <= ACTIVE_OFFSET) current = id;
        else break;
      }
      // 滚到页面底部、后面几章顶不到上方时，取视口上半部分里最靠后的一章
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        for (const id of ids) {
          const top = document.getElementById(id)?.getBoundingClientRect().top;
          if (top !== undefined && top < window.innerHeight * 0.4) current = id;
        }
      }
      setActive(current ?? ids[0]);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [ids.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps
  return active;
}

export function ResultToc({ entries }: { entries: TocEntry[] }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const scrolled = useActiveChapter(entries.map((e) => e.id));
  // 点目录跳转后，在用户自己滚动之前，一直高亮点中的那一章（页面底部的短章节滚不到顶部）
  const [pinned, setPinned] = useState<string | null>(null);
  useEffect(() => {
    if (!pinned) return;
    const clear = () => setPinned(null);
    window.addEventListener('wheel', clear, { passive: true });
    window.addEventListener('touchmove', clear, { passive: true });
    window.addEventListener('keydown', clear);
    return () => {
      window.removeEventListener('wheel', clear);
      window.removeEventListener('touchmove', clear);
      window.removeEventListener('keydown', clear);
    };
  }, [pinned]);
  const active = pinned ?? scrolled;
  const chapters = entries.filter((e) => e.no !== undefined).length;
  const mustTotal = entries.reduce((n, e) => n + (e.must ?? 0), 0);

  const close = useCallback((refocus = false) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panelRef.current?.contains(t) && !buttonRef.current?.contains(t)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    // 打开时把焦点放到当前章节上，方便键盘上下选择
    const current = panelRef.current?.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? panelRef.current?.querySelector<HTMLButtonElement>('button[data-toc]');
    current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open, close]);

  if (entries.length < 2) return null;

  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(panelRef.current?.querySelectorAll<HTMLButtonElement>('button[data-toc]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
    e.preventDefault();
  };

  return (
    <div className="toc-float fixed right-4 bottom-24 z-30 flex flex-col items-end gap-2 lg:right-6">
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="结果目录"
          className="toc-panel w-[min(320px,calc(100vw-2rem))] overflow-hidden rounded-[20px] border border-white bg-sheet/[0.97] shadow-[0_0_0_1px_rgba(77,107,254,0.08),0_22px_48px_-18px_rgba(45,70,160,0.45)] backdrop-blur-xl"
        >
          <div className="flex items-baseline justify-between border-b border-rule px-4 py-2.5">
            <span className="text-[14px] font-semibold">目录</span>
            <span className="text-[12px] text-muted">
              {chapters} 个章节{mustTotal ? <span className="text-seal">，{mustTotal} 处待审核</span> : null}
            </span>
          </div>
          <nav className="max-h-[min(60vh,480px)] overflow-y-auto py-1.5" onKeyDown={onListKey}>
            <ol>
              {entries.map((e) => {
                const isActive = e.id === active;
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      data-toc
                      aria-current={isActive ? 'true' : undefined}
                      className={`group flex w-full items-start gap-2.5 border-l-2 px-4 py-2 text-left text-[13.5px] transition-colors focus:outline-none focus-visible:bg-indigo-soft ${
                        isActive ? 'border-indigo bg-indigo-soft/60 text-ink' : 'border-transparent text-ink-soft hover:bg-paper hover:text-ink'
                      }`}
                      onClick={() => {
                        scrollToAnchor(e.id);
                        setPinned(e.id);
                        close();
                      }}
                    >
                      <span className={`num w-5 shrink-0 pt-px text-right text-[12px] ${isActive ? 'text-indigo' : 'text-muted'}`}>{e.no !== undefined ? String(e.no).padStart(2, '0') : '·'}</span>
                      <span className="min-w-0 flex-1">
                        <span className={`block leading-snug ${isActive ? 'font-semibold' : 'font-medium'}`}>{e.title}</span>
                        {e.sub && <span className="block text-[12px] text-muted">{e.sub}</span>}
                      </span>
                      {e.must ? (
                        <span className="mt-0.5 shrink-0 rounded bg-seal-soft px-1.5 text-[11.5px] leading-5 text-seal" title="需要重点审核的内容">
                          {e.must} 待审核
                        </span>
                      ) : e.suggest ? (
                        <span className="mt-0.5 shrink-0 rounded bg-amber-soft px-1.5 text-[11.5px] leading-5 text-amber" title="建议">
                          {e.suggest} 建议
                        </span>
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className="flex border-t border-rule text-[12.5px]">
            <button
              type="button"
              className="flex-1 px-4 py-2 text-ink-soft hover:bg-paper hover:text-ink"
              onClick={() => {
                window.scrollTo({ top: 0, behavior: 'smooth' });
                close();
              }}
            >
              回到页面顶部
            </button>
          </div>
        </div>
      )}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-2 rounded-full border px-4 py-2 text-[13.5px] font-medium shadow-[0_0_0_1px_rgba(77,107,254,0.1),0_12px_28px_-12px_rgba(45,70,160,0.5)] transition-colors ${
          open ? 'border-indigo bg-indigo text-white' : 'border-white bg-sheet/90 text-ink backdrop-blur hover:text-indigo'
        }`}
        title="按章节快速跳转"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
          <path d="M2 3.5h1.5M5.5 3.5H14M2 8h1.5M5.5 8H14M2 12.5h1.5M5.5 12.5H14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        </svg>
        目录
        {mustTotal > 0 && <span className="h-2 w-2 rounded-full bg-seal" aria-label="有待审核的内容" />}
      </button>
    </div>
  );
}

/** 结果顶部的目录：报告有哪些章节，点击跳转。 */
export function ResultTocInline({ entries, title }: { entries: TocEntry[]; title?: string }) {
  if (entries.length === 0) return null;
  return (
    <nav aria-label="报告目录" className="rounded-[20px] border border-rule bg-paper/60 px-4 py-3.5">
      <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[14px] font-semibold">报告目录</span>
        {title && <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{title}</span>}
      </div>
      <ol className="grid gap-x-4 gap-y-0.5 sm:grid-cols-2">
        {entries.map((e) => (
          <li key={e.id}>
            <button
              type="button"
              className="group flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-sheet"
              onClick={() => scrollToAnchor(e.id)}
            >
              <span className="num w-5 shrink-0 text-right text-[12px] text-indigo">{e.no !== undefined ? String(e.no).padStart(2, '0') : '·'}</span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink group-hover:text-indigo">{e.title}</span>
              {e.must ? (
                <span className="shrink-0 rounded-full bg-seal-soft px-1.5 text-[11.5px] leading-5 text-seal">{e.must} 待审核</span>
              ) : e.suggest ? (
                <span className="shrink-0 rounded-full bg-amber-soft px-1.5 text-[11.5px] leading-5 text-amber">{e.suggest} 建议</span>
              ) : e.sub ? (
                <span className="shrink-0 text-[12px] text-muted">{e.sub}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  );
}
