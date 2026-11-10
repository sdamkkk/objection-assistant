// 分页的原文：在整份文件中查找引用，并换算成页码。返回的片段取自原文本身，不用模型写的引文。

import { NoticeIndex } from './textfind.ts';

export const PAGE_SEPARATOR = '\n\n';

export interface PagedHit {
  found: boolean;
  /** 1 起算的页码 */
  page?: number;
  /** 原文中与引文对应的那一段（逐字取自原文） */
  text?: string;
  /** 在整份文字中的位置 */
  start?: number;
  end?: number;
  context?: string;
  occurrences?: number;
  /** 找不到时，原文中最接近的一段 */
  closest?: { text: string; page: number; similarity: number };
}

/** 法规条文：pos 所在的条，取它之前最近一个行首的"第X条"。 */
export function articleAt(full: string, pos: number): string | undefined {
  const head = full.slice(0, pos + 1);
  const re = /(?:^|\n)[ \t　]*(第[ \t　]*[一二三四五六七八九十百零〇][一二三四五六七八九十百零〇 \t　]*?条)/g;
  let last: string | undefined;
  for (let m = re.exec(head); m; m = re.exec(head)) last = m[1];
  return last?.replace(/[ \t　]/g, '');
}

export class PagedText {
  readonly pages: string[];
  readonly full: string;
  private readonly starts: number[] = [];
  private index?: NoticeIndex;

  constructor(pages: string[]) {
    this.pages = pages.length ? pages : [''];
    let pos = 0;
    for (const p of this.pages) {
      this.starts.push(pos);
      pos += p.length + PAGE_SEPARATOR.length;
    }
    this.full = this.pages.join(PAGE_SEPARATOR);
  }

  static fromText(text: string): PagedText {
    return new PagedText([text]);
  }

  get pageCount(): number {
    return this.pages.length;
  }

  pageAt(pos: number): number {
    let page = 1;
    for (let i = 0; i < this.starts.length; i++) if (this.starts[i] <= pos) page = i + 1;
    return page;
  }

  /**
   * 查找用的文字：把页码行和每页重复出现的页眉页脚换成等长的空白，使跨页的引文也能找到。
   * 位置与原文一一对应，找到后片段仍从原文中截取。
   */
  private maskedCache?: string;

  /**
   * 引文跨页时，按页拆开原文片段，并去掉夹在中间的页码、页眉页脚行（这些行不是正文）。
   * 返回的文字逐字取自原文。
   */
  segments(start: number, end: number): { page: number; text: string }[] {
    const masked = this.masked();
    const out: { page: number; text: string }[] = [];
    let pos = start;
    while (pos < end) {
      const page = this.pageAt(pos);
      const pageEnd = page < this.starts.length ? this.starts[page] - PAGE_SEPARATOR.length : this.full.length;
      const stop = Math.min(end, Math.max(pageEnd, pos + 1));
      const orig = this.full.slice(pos, stop).split('\n');
      const mask = masked.slice(pos, stop).split('\n');
      const text = orig
        .filter((l, i) => !(l.trim() && !(mask[i] ?? '').trim()))
        .join('\n')
        .trim();
      if (text) out.push({ page, text });
      pos = page < this.starts.length ? this.starts[page] : end;
    }
    return out;
  }

  private masked(): string {
    if (this.maskedCache !== undefined) return this.maskedCache;
    this.maskedCache = this.computeMasked();
    return this.maskedCache;
  }

  private computeMasked(): string {
    const pageNo = /^[ \t　]*(?:[-－—–]?[ \t　]*\d{1,4}[ \t　]*[-－—–]?|第[ \t　]*\d+[ \t　]*页[ \t　]*(?:共[ \t　]*\d+[ \t　]*页)?)[ \t　]*$/;
    const edge = (p: string, last: boolean) => {
      const lines = p.split('\n').map((l) => l.trim()).filter((l) => l && !pageNo.test(l));
      return last ? lines[lines.length - 1] : lines[0];
    };
    const repeated = new Set<string>();
    if (this.pages.length >= 3) {
      for (const last of [false, true]) {
        const counts = new Map<string, number>();
        for (const p of this.pages) {
          const l = edge(p, last);
          if (l) counts.set(l, (counts.get(l) ?? 0) + 1);
        }
        for (const [l, c] of counts) if (c >= 3 && c >= this.pages.length / 2) repeated.add(l);
      }
    }
    return this.pages
      .map((p) =>
        p
          .split('\n')
          .map((l) => (pageNo.test(l) || repeated.has(l.trim()) ? ' '.repeat(l.length) : l))
          .join('\n'),
      )
      .join(PAGE_SEPARATOR);
  }

  private idx(): NoticeIndex {
    if (!this.index) this.index = new NoticeIndex(this.masked());
    return this.index;
  }

  private context(start: number, end: number, pad = 24): string {
    const a = Math.max(0, start - pad);
    const b = Math.min(this.full.length, end + pad);
    return (a > 0 ? '…' : '') + this.full.slice(a, b).replace(/\s+/g, ' ') + (b < this.full.length ? '…' : '');
  }

  find(quote: string): PagedHit {
    // 引文若是从 Markdown 里摘的，去掉表格分隔符、换行标记和加粗记号（原文中没有这些字符）
    const q = quote.replace(/<br\s*\/?>/g, '').replace(/\*\*/g, '').replace(/\s*\|\s*/g, '');
    const r = this.idx().find(q);
    if (r.found) {
      const h = r.hits[0];
      return {
        found: true,
        page: this.pageAt(h.start),
        text: this.full.slice(h.start, h.end),
        start: h.start,
        end: h.end,
        context: this.context(h.start, h.end),
        occurrences: r.hits.length,
      };
    }
    if (r.closest) {
      return { found: false, closest: { text: this.full.slice(r.closest.start, r.closest.end), page: this.pageAt(r.closest.start), similarity: r.closest.similarity } };
    }
    return { found: false };
  }
}
