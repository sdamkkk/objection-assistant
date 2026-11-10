// 文件库：按页保存原始文件中提取的文字，供 agent 检索、阅读和核对引用。
// 两种库：某只基金历次披露的文件（公告库），以及监管规则和自律规则的原文（规则库）。
// 时间边界：处理某份公告时，只能看到当时已经发布的文件（不含当前公告自己），避免用"未来"的信息。

import { PagedText, articleAt, type PagedHit } from './paged.ts';
import { Bm25Index, VectorIndex, bestSnippet, bigramSet, fuseRanks, overlap, type Chunk, type EmbeddingMeta } from './search.ts';
import { compactText, normalize } from './textfind.ts';

export type LibraryKind = 'fund' | 'rules';

export interface KbItem {
  id: string;
  no: number;
  title: string;
  /** 大类：法律文件 / 定期报告 / 临时公告；规则库为部门规章、规范性文件、自律规则等 */
  category: string;
  /** 小类：基金合同、季度报告、基金经理变更……；规则库为规则简称 */
  type: string;
  /** 巨潮披露日期；规则库为发布日期 */
  published: string;
  /** 公告日期（优先取正文中的送出日期）；规则库为发布日期 */
  date: string;
  /** 规则库：施行日期 */
  effective?: string;
  /** 规则库：发布机关、文号、效力状态 */
  issuer?: string;
  docNo?: string;
  status?: string;
  /** 收录的页数（Word 原件为章数） */
  pages: number;
  /** 收录的第一页在原件中的页码（原件只有一部分属于本文件时，如修正决定附件中的全文） */
  firstPage?: number;
  /** Word 原件按章切分时，每一段的名称 */
  labels?: string[];
  format?: 'pdf' | 'doc';
  chars: number;
  /** 原始文件的发布地址 */
  source: string;
  /** 发布原始文件的网页 */
  sourcePage?: string;
  note?: string;
  /** 原始文件在本站的相对路径（相对于 /kb/<库编号>/） */
  pdf: string;
  text: string;
}

export interface KbIndex {
  /** 库编号：基金代码，或 rules */
  code: string;
  kind?: LibraryKind;
  name: string;
  source: string;
  count: number;
  items: KbItem[];
}

export interface KbPage {
  id: string;
  page: number;
  text: string;
}

/** 把检索问题转成向量（网站上由 /api/embed 调用 Workers AI）。 */
export type Embedder = (text: string) => Promise<number[]>;

/** 检索打分的参数（由 scripts/eval-retrieval.py 的评测结果确定）。 */
export const KEYWORD_BONUS = 0.15;
export const FUSE_DEPTH = 50;
export const FUSE_WEIGHTS = { lexical: 1, dense: 1 };

/** 用于向量检索的问题文字：有问题原句时只用原句（关键词交给 BM25），没有时用关键词。 */
export function searchText(query: string, keywords: string[]): string {
  return (query.trim() || keywords.join(' ')).slice(0, 500);
}

export interface KbData {
  index: KbIndex;
  /** 原件逐页提取的文字：核对引用、定位页码用 */
  pages: KbPage[];
  /** 由原件转换成的 Markdown 按结构切成的分段：检索和阅读用 */
  chunks?: Chunk[];
  /** 各分段的向量（与 chunks 一一对应） */
  embeddings?: { meta: EmbeddingMeta; data: Int8Array };
}

export interface KbScope {
  code: string;
  /** 当前公告的日期，YYYY-MM-DD */
  asOf: string;
  /** 当前公告在库里的编号（如果它本身就在库里） */
  excludeId?: string;
}

export interface CatalogEntry {
  code: string;
  name: string;
  count: number;
  kind?: LibraryKind;
}

export type Availability = 'ok' | 'future' | 'self' | 'missing';

interface PageEntry extends KbPage {
  key: string;
}

/** 可以被引用、并能定位到原始文件的一份文件 */
export interface CitableDoc {
  id: string;
  library: LibraryKind | 'notice';
  title: string;
  date?: string;
  /** 发布机关、文号等 */
  meta?: string;
  paged: PagedText;
  /** 原始文件地址（本站保存的原件） */
  fileUrl?: string;
  format?: 'pdf' | 'doc' | 'text';
  /** 原始文件的发布地址 */
  sourceUrl?: string;
  sourcePage?: string;
  /** 原始文件的二进制内容（上传的 PDF） */
  fileData?: ArrayBuffer;
  /** 第 idx 段（1 起算）在原件中的位置 */
  location: (idx: number) => { page?: number; label: string };
  /** 法规：位置所在的条 */
  article?: (pos: number) => string | undefined;
  availability: Availability;
  unavailableReason?: string;
}

const READ_LIMIT = 6000;

function snippetAround(key: string, at: number, len: number, pad = 60): string {
  const a = Math.max(0, at - pad);
  const b = Math.min(key.length, at + len + pad);
  return (a > 0 ? '…' : '') + key.slice(a, b) + (b < key.length ? '…' : '');
}

function countOf(hay: string, needle: string, cap = 20): number {
  let n = 0;
  let from = 0;
  while (n < cap) {
    const i = hay.indexOf(needle, from);
    if (i < 0) break;
    n += 1;
    from = i + needle.length;
  }
  return n;
}

export function splitKeywords(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[\s,，、;；]+/) : [];
  const out: string[] = [];
  for (const k of list) {
    const n = normalize(k).text;
    if (n && !out.includes(n)) out.push(n);
  }
  return out.slice(0, 8);
}

export class KnowledgeBase {
  readonly index: KbIndex;
  readonly scope: KbScope;
  readonly kind: LibraryKind;
  private readonly pagesById = new Map<string, PageEntry[]>();
  private readonly paged = new Map<string, PagedText>();
  private readonly bm25?: Bm25Index;
  private readonly vectors?: VectorIndex;
  private embedder?: Embedder;
  private readonly queryVectors = new Map<string, number[]>();
  private readonly chunksById = new Map<string, Chunk[]>();

  constructor(data: KbData, scope: KbScope) {
    if (data.index.code !== scope.code) throw new Error(`文件库是 ${data.index.code}，与 ${scope.code} 不符`);
    this.index = data.index;
    this.scope = scope;
    this.kind = data.index.kind ?? 'fund';
    if (data.chunks?.length) {
      this.bm25 = new Bm25Index(data.chunks);
      if (data.embeddings && data.embeddings.meta.count === data.chunks.length) this.vectors = new VectorIndex(data.embeddings.meta, data.embeddings.data);
      for (const c of data.chunks) {
        const list = this.chunksById.get(c.doc) ?? [];
        list.push(c);
        this.chunksById.set(c.doc, list);
      }
    }
    for (const p of data.pages) {
      const list = this.pagesById.get(p.id) ?? [];
      list.push({ ...p, key: normalize(p.text).text });
      this.pagesById.set(p.id, list);
    }
    for (const list of this.pagesById.values()) list.sort((a, b) => a.page - b.page);
  }

  get label(): string {
    return this.kind === 'rules' ? '规则库' : '公告库';
  }

  item(id: string): KbItem | undefined {
    return this.index.items.find((x) => x.id === id.trim());
  }

  has(id: string): boolean {
    return Boolean(this.item(id));
  }

  availability(id: string): Availability {
    const it = this.item(id);
    if (!it) return 'missing';
    if (it.id === this.scope.excludeId) return 'self';
    if (it.date > this.scope.asOf) return 'future';
    return 'ok';
  }

  /** 时间边界内可用的文件，按日期从早到晚。 */
  available(): KbItem[] {
    return this.index.items.filter((x) => this.availability(x.id) === 'ok').sort((a, b) => (a.date === b.date ? a.no - b.no : a.date < b.date ? -1 : 1));
  }

  unavailableMessage(id: string): string {
    const it = this.item(id);
    switch (this.availability(id)) {
      case 'missing':
        return `${this.label}里没有编号为 ${id} 的文件。`;
      case 'self':
        return `${id} 就是当前正在处理的公告，请直接使用案例材料（find_quote 不填 doc_id）。`;
      case 'future':
        return `${id}（${it?.title}）的发布日期是 ${it?.date}，晚于业务日期（${this.scope.asOf}），不能使用。`;
      default:
        return '';
    }
  }

  private pagedOf(id: string): PagedText {
    let p = this.paged.get(id);
    if (!p) {
      const it = this.item(id);
      const first = it?.firstPage ?? 1;
      const list = this.pagesById.get(id) ?? [];
      const pages: string[] = Array.from({ length: it?.pages ?? list.length }, () => '');
      for (const e of list) pages[e.page - first] = e.text;
      p = new PagedText(pages);
      this.paged.set(id, p);
    }
    return p;
  }

  /** 第 idx 段（1 起算）在原件中的位置说明，如"第 199 页"、"第四章 申购和赎回" */
  locationOf(it: KbItem, idx: number): { page?: number; label: string } {
    if (it.labels?.length) return { label: it.labels[idx - 1] ?? `第 ${idx} 段` };
    const page = (it.firstPage ?? 1) + idx - 1;
    return { page, label: `第 ${page} 页` };
  }

  /** 原始文件在本站的地址 */
  fileUrl(it: KbItem): string {
    return `/kb/${this.index.code}/${it.pdf}`;
  }

  /** 供引用定位使用的文件（不受时间边界限制，但会标出是否可用） */
  citable(id: string): CitableDoc | undefined {
    const it = this.item(id);
    if (!it) return undefined;
    const availability = this.availability(id);
    return {
      id: it.id,
      library: this.kind,
      title: it.title,
      date: it.date,
      meta: [it.issuer, it.docNo].filter(Boolean).join(' '),
      paged: this.pagedOf(it.id),
      fileUrl: this.fileUrl(it),
      format: it.format ?? 'pdf',
      sourceUrl: it.source,
      sourcePage: it.sourcePage,
      location: (idx: number) => this.locationOf(it, idx),
      article: this.kind === 'rules' ? (pos: number) => articleAt(this.pagedOf(it.id).full, pos) : undefined,
      availability,
      unavailableReason: availability === 'ok' ? undefined : this.unavailableMessage(id),
    };
  }

  private itemBrief(x: KbItem): Record<string, unknown> {
    const out: Record<string, unknown> = { id: x.id, date: x.date, type: `${x.category}/${x.type}`, title: x.title };
    if (x.effective) out.effective = x.effective;
    if (x.status) out.status = x.status;
    return out;
  }

  /** 设置把问题转成向量的函数。 */
  setEmbedder(fn: Embedder | undefined): void {
    this.embedder = fn;
  }

  get hasVectors(): boolean {
    return Boolean(this.vectors && this.embedder);
  }

  /** 检索前先把问题转成向量（异步）；失败时本次检索只用 BM25。 */
  async prepareSearch(o: { query?: unknown; keywords?: unknown }): Promise<void> {
    if (!this.vectors || !this.embedder) return;
    const query = typeof o.query === 'string' ? o.query.trim() : '';
    const text = searchText(query, splitKeywords(o.keywords));
    if (!text || this.queryVectors.has(text)) return;
    try {
      const v = await this.embedder(text);
      if (v.length === this.vectors.dim) this.queryVectors.set(text, v);
    } catch {
      // 向量服务不可用：这次只用 BM25
    }
  }

  /**
   * 检索。有分段数据时：问题原句和关键词一起按 BM25 给 Markdown 分段打分，关键词在分段中原样出现的再加分；
   * 没有分段数据时，退回按页的关键词匹配。
   */
  search(o: { query?: unknown; keywords?: unknown; types?: unknown; date_from?: unknown; date_to?: unknown; limit?: unknown }): Record<string, unknown> {
    const keywords = splitKeywords(o.keywords);
    const query = typeof o.query === 'string' ? o.query.trim() : '';
    const types = Array.isArray(o.types) ? o.types.map((t) => String(t).trim()).filter(Boolean) : typeof o.types === 'string' && o.types.trim() ? o.types.split(/[\s,，、]+/) : [];
    const from = o.date_from ? String(o.date_from) : '';
    const to = o.date_to ? String(o.date_to) : '';
    const items = this.available().filter(
      (x) => (!types.length || types.some((t) => x.type.includes(t) || x.category.includes(t) || x.title.includes(t))) && (!from || x.date >= from) && (!to || x.date <= to),
    );
    if (!keywords.length && !query) {
      return { mode: 'list', count: items.length, documents: items.map((x) => ({ ...this.itemBrief(x), pages: x.pages })) };
    }
    const limit = Math.min(Math.max(Number(o.limit) || 8, 1), 20);
    if (this.bm25) return this.searchChunks(query, keywords, new Set(items.map((x) => x.id)), limit);
    if (!keywords.length) keywords.push(...splitKeywords(query));
    type Hit = { item: KbItem; page: PageEntry; matched: string[]; score: number };
    const hits: Hit[] = [];
    for (const it of items) {
      for (const p of this.pagesById.get(it.id) ?? []) {
        const matched: string[] = [];
        let occ = 0;
        for (const k of keywords) {
          const c = countOf(p.key, k, 5);
          if (c) {
            matched.push(k);
            occ += c;
          }
        }
        if (matched.length) hits.push({ item: it, page: p, matched, score: matched.length * 1000 + occ });
      }
    }
    hits.sort((a, b) => b.score - a.score || (a.item.date === b.item.date ? a.page.page - b.page.page : a.item.date < b.item.date ? 1 : -1));
    const top = hits.slice(0, limit);
    const byDoc = new Map<string, number>();
    for (const h of hits) byDoc.set(h.item.id, (byDoc.get(h.item.id) ?? 0) + 1);
    return {
      mode: 'search',
      keywords,
      total_pages_matched: hits.length,
      matched_all_keywords: hits.filter((h) => h.matched.length === keywords.length).length,
      documents_matched: [...byDoc.entries()].map(([id, pages]) => ({ id, title: this.item(id)?.title, pages_matched: pages })).slice(0, 15),
      results: top.map((h) => ({
        ...this.itemBrief(h.item),
        page: h.page.page,
        ...(h.item.labels ? { location: this.locationOf(h.item, h.page.page).label } : {}),
        matched: h.matched,
        snippets: h.matched.slice(0, 3).map((k) => snippetAround(h.page.key, h.page.key.indexOf(k), k.length)),
      })),
      note: '片段已去掉空白；需要上下文时用 read_document 读取对应页，引用前用 find_quote 填 doc_id 核对。',
    };
  }

  private readonly grams = new Map<number, Set<string>>();

  private gramsOf(i: number): Set<string> {
    let g = this.grams.get(i);
    if (!g) {
      g = bigramSet(this.bm25!.plainText[i]);
      this.grams.set(i, g);
    }
    return g;
  }

  private searchChunks(query: string, keywords: string[], docs: Set<string>, limit: number): Record<string, unknown> {
    const bm25 = this.bm25!;
    const text = [query, ...keywords].join(' ');
    const allowed = (c: Chunk) => docs.has(c.doc);
    const ranked = bm25.rank(text, allowed);
    const top = ranked[0]?.score ?? 1;
    const exact = keywords.filter((k) => k.length >= 2);
    const matchedOf = (i: number) => exact.filter((k) => bm25.plainText[i].includes(k));
    const lexical = ranked.map((r) => ({ i: r.i, score: r.score + top * KEYWORD_BONUS * matchedOf(r.i).length })).sort((a, b) => b.score - a.score);
    // 有问题向量时，与向量检索的排序融合
    const qv = this.vectors ? this.queryVectors.get(searchText(query, keywords)) : undefined;
    let order: number[];
    let method: string;
    if (qv && this.vectors) {
      const dense = this.vectors.similarities(qv, (i) => allowed(bm25.chunks[i])).slice(0, FUSE_DEPTH).map((x) => x.i);
      const fused = fuseRanks([lexical.slice(0, FUSE_DEPTH).map((x) => x.i), dense], [FUSE_WEIGHTS.lexical, FUSE_WEIGHTS.dense]);
      order = [...fused.entries()].sort((a, b) => b[1] - a[1]).map(([i]) => i);
      method = '关键词（BM25）+ 语义向量';
    } else {
      order = lexical.map((x) => x.i);
      method = this.vectors ? '关键词（BM25），向量服务暂不可用' : '关键词（BM25）';
    }
    const scored = order.map((i) => ({ i, matched: matchedOf(i) }));
    // 基金合同、各版招募说明书里大量段落几乎一样：只保留一份（取最新的文件），其余列在 same_text_in 里，把名额让给不同的内容
    type Group = { i: number; matched: string[]; grams: Set<string>; docs: string[] };
    const groups: Group[] = [];
    for (const h of scored.slice(0, 80)) {
      const grams = this.gramsOf(h.i);
      const same = groups.find((g) => overlap(g.grams, grams) > 0.7);
      if (same) {
        same.docs.push(bm25.chunks[h.i].doc);
        const cur = this.item(bm25.chunks[same.i].doc)!;
        const cand = this.item(bm25.chunks[h.i].doc)!;
        if (cand.date > cur.date) same.i = h.i;
        continue;
      }
      if (groups.length < limit) groups.push({ i: h.i, matched: h.matched, grams, docs: [bm25.chunks[h.i].doc] });
    }
    const hits = groups;
    const byDoc = new Map<string, number>();
    for (const h of scored.slice(0, 60)) byDoc.set(bm25.chunks[h.i].doc, (byDoc.get(bm25.chunks[h.i].doc) ?? 0) + 1);
    const q = [query, ...keywords].join(' ');
    return {
      mode: 'search',
      method,
      sections_matched: order.length,
      ...(query ? { query } : {}),
      ...(keywords.length ? { keywords } : {}),
      documents_matched: [...byDoc.entries()].slice(0, 12).map(([id, n]) => ({ id, title: this.item(id)?.title, sections: n })),
      results: hits.map((h) => {
        const c = bm25.chunks[h.i];
        const it = this.item(c.doc)!;
        const loc = this.locationOf(it, c.page - (it.firstPage ?? 1) + 1);
        return {
          ...this.itemBrief(it),
          section: c.id,
          heading: c.heading || undefined,
          location: c.page_to > c.page && !it.labels ? `第 ${c.page}–${c.page_to} 页` : loc.label,
          page: c.page,
          ...(exact.length ? { keywords_found: h.matched } : {}),
          ...(h.docs.length > 1 ? { same_text_in: [...new Set(h.docs)].filter((d) => d !== c.doc) } : {}),
          snippet: bestSnippet(c.text, q),
        };
      }),
      note: '按相关程度排序，排在前面的不一定就是答案，请阅读后判断。用 read_document 填 section 读取整段（或填页码读取多页）；引用前用 find_quote 填 doc_id 核对。没找到时换个说法再查，比如换成规定里的正式用语。',
    };
  }

  /** 阅读一份文件：可按分段（section）或页码读取 Markdown 正文。单次最多约 6000 字。 */
  read(id: string, pageFrom?: unknown, pageTo?: unknown, section?: unknown): Record<string, unknown> {
    const sec = typeof section === 'string' && section.includes('#') ? section : '';
    if (sec && !id) id = sec.split('#')[0];
    const it = this.item(id);
    if (!it || this.availability(id) !== 'ok') return { error: this.unavailableMessage(id) };
    const chunks = this.chunksById.get(it.id);
    if (chunks?.length) return this.readMarkdown(it, chunks, pageFrom, pageTo, sec);
    return this.readPages(it, pageFrom, pageTo);
  }

  private readMarkdown(it: KbItem, chunks: Chunk[], pageFrom: unknown, pageTo: unknown, section: string): Record<string, unknown> {
    const lo = it.firstPage ?? 1;
    const hi = lo + it.pages - 1;
    let start = 0;
    let last = hi;
    if (section) {
      start = chunks.findIndex((c) => c.id === section);
      if (start < 0) return { error: `${it.id} 中没有分段 ${section}` };
      last = Number(pageTo) || hi;
    } else {
      const first = Math.max(Number(pageFrom) || lo, lo);
      if (first > hi) return { error: `${it.id} 的页码范围是 ${lo}–${hi}` };
      last = Math.min(Number(pageTo) || hi, hi);
      start = chunks.findIndex((c) => c.page_to >= first);
      if (start < 0) start = chunks.length;
    }
    const parts: string[] = [];
    let chars = 0;
    let heading = '';
    let end = start;
    for (let i = start; i < chunks.length; i++) {
      const c = chunks[i];
      if (!section && c.page > last) break;
      if (chars > 0 && chars + c.text.length > READ_LIMIT) break;
      if (section && i > start && chars > 2500) break;
      if (c.heading !== heading) {
        parts.push(`## ${c.heading || it.title}`);
        heading = c.heading;
      }
      parts.push(`<!-- ${c.id}，${this.locationOf(it, c.page - lo + 1).label} -->\n${c.text}`);
      chars += c.text.length;
      end = i + 1;
    }
    const out: Record<string, unknown> = {
      ...this.itemBrief(it),
      format: 'markdown',
      page_range: `${lo}-${hi}`,
      sections: end > start ? `${chunks[start].id} 至 ${chunks[end - 1].id}` : '无',
      text: parts.join('\n\n'),
    };
    if (it.labels) out.note = '原件为 Word 文档，按章切分，页码即章的序号。';
    if (end < chunks.length && (section || chunks[end].page <= last)) {
      out.truncated = true;
      out.message = `后面还有内容，可以用 section="${chunks[end].id}" 继续读取。`;
    }
    out.reminder = '这是由原件转换的 Markdown，表格中的 | 是单元格分隔。引用时只摘原文文字，不带 Markdown 记号，并用 find_quote 核对。';
    return out;
  }

  /** 读取一份文件的若干页（页码按原件编号）。没有 Markdown 分段时使用。 */
  private readPages(it: KbItem, pageFrom?: unknown, pageTo?: unknown): Record<string, unknown> {
    const id = it.id;
    const pages = this.pagesById.get(it.id) ?? [];
    const lo = it.firstPage ?? 1;
    const hi = lo + it.pages - 1;
    const first = Math.max(Number(pageFrom) || lo, lo);
    const last = Math.min(Number(pageTo) || hi, hi);
    if (first > hi) return { error: `${id} 的页码范围是 ${lo}–${hi}` };
    const parts: string[] = [];
    let chars = 0;
    let end = first - 1;
    for (const p of pages) {
      if (p.page < first || p.page > last) continue;
      const text = compactText(p.text);
      if (chars > 0 && chars + text.length > READ_LIMIT) break;
      parts.push(`【${this.locationOf(it, p.page - lo + 1).label}】\n${text}`);
      chars += text.length;
      end = p.page;
    }
    const out: Record<string, unknown> = {
      ...this.itemBrief(it),
      pages_total: it.pages,
      page_range: `${lo}-${hi}`,
      page_from: first,
      page_to: end,
      text: parts.join('\n\n'),
    };
    if (it.labels) out.note = '原件为 Word 文档，按章切分，页码即章的序号。';
    if (end < last) {
      out.truncated = true;
      out.message = `内容较长，只返回到第 ${end} 页。需要后面的内容，请用 page_from=${end + 1} 继续读取，或先检索定位页码。`;
    }
    return out;
  }

  /** 在某份文件中查找一段文字（核对引用），返回页码和原文中对应的片段。 */
  find(id: string, text: string): Record<string, unknown> {
    const it = this.item(id);
    if (!it || this.availability(id) !== 'ok') return { found: false, error: this.unavailableMessage(id) };
    const paged = this.pagedOf(it.id);
    const r: PagedHit = paged.find(text);
    if (r.found) {
      const loc = this.locationOf(it, r.page ?? 1);
      const article = this.kind === 'rules' && r.start !== undefined ? articleAt(paged.full, r.start) : undefined;
      return {
        found: true,
        doc_id: it.id,
        title: it.title,
        location: loc.label,
        ...(loc.page ? { page: loc.page } : {}),
        ...(article ? { article } : {}),
        occurrences: r.occurrences,
        original: r.text,
        context: r.context,
      };
    }
    if (r.closest) {
      const loc = this.locationOf(it, r.closest.page);
      return {
        found: false,
        doc_id: it.id,
        closest: r.closest.text,
        location: loc.label,
        similarity: r.closest.similarity,
        message: '这份文件里没有这段文字。如需引用，请改用原文中的写法（见 closest）。',
      };
    }
    return { found: false, doc_id: it.id, message: '这份文件里没有这段文字，也没有相近的片段。' };
  }

  /** 产品档案之外，时间边界内本基金的临时公告（按日期从早到晚）。code 不是本库基金时返回空。 */
  laterNoticesFor(code: string): { id: string; date: string; type: string; title: string }[] {
    if (this.kind !== 'fund' || code.trim() !== this.index.code) return [];
    return this.available()
      .filter((x) => x.category === '临时公告')
      .map((x) => ({ id: x.id, date: x.date, type: x.type, title: x.title }));
  }

  /** 时间边界内最近一份产品资料概要。 */
  latestProfile(): KbItem | undefined {
    if (this.kind !== 'fund') return undefined;
    const list = this.available().filter((x) => x.type === '产品资料概要');
    return list[list.length - 1];
  }

  /** 产品资料概要中"一、产品概况"和"三、投资本基金涉及的费用"两部分的原文。 */
  profileSummary(): Record<string, unknown> | undefined {
    const it = this.latestProfile();
    if (!it) return undefined;
    const full = compactText(this.pagedOf(it.id).full);
    const section = (start: RegExp, end: RegExp): string => {
      const s = full.search(start);
      if (s < 0) return '';
      const rest = full.slice(s);
      const e = rest.slice(4).search(end);
      return (e < 0 ? rest : rest.slice(0, e + 4)).trim().slice(0, 3000);
    };
    const overview = section(/一、\s*产品概况/, /\n\s*二、/);
    const fees = section(/三、\s*投资本基金涉及的费用/, /\n\s*（三）|\n\s*四、/);
    const later = this.available().filter((x) => x.date > it.date && x.category === '临时公告');
    return {
      based_on: { id: it.id, title: it.title, date: it.date },
      产品概况: overview || full.slice(0, 2000),
      费用: fees || '（未能从概要中定位费用部分，请用 read_document 阅读）',
      later_notices: later.map((x) => ({ id: x.id, date: x.date, type: x.type, title: x.title })),
      note: `以上摘自 ${it.id}（${it.date}）原文，PDF 提取的表格可能错行。概要之后披露的临时公告（later_notices）可能已经改变了其中的信息，用到的字段请核对。引用时来源标【披露文件】，doc 填 ${it.id}，quote 用 find_quote 核对过的原文。`,
    };
  }

  /** 给 agent 的说明（放在用户消息里）。 */
  describe(): string {
    const list = this.available();
    const hidden = this.index.items.filter((x) => this.availability(x.id) === 'future');
    if (this.kind === 'rules') {
      const lines = list.map((x) => `${x.id}｜${x.type}｜${x.title}｜${[x.issuer, x.docNo].filter(Boolean).join(' ')}｜发布 ${x.date}${x.effective ? `，施行 ${x.effective}` : ''}${x.status ? `｜${x.status}` : ''}（${x.pages} 页）`);
      return [
        `规则库：监管规则和自律规则的原始文件，共 ${list.length} 份可用（业务日期 ${this.scope.asOf} 以前发布的）。${hidden.length ? `另有 ${hidden.length} 份在业务日期之后发布，不能使用。` : ''}`,
        '可用工具：search_rules 检索条文段落；read_document 阅读原文（Markdown）；find_quote 填 doc_id 核对引用。引用时来源标【法规原文】，doc 填编号。',
        '',
        '文件清单（编号｜简称｜标题｜发布机关 文号｜日期｜状态）：',
        ...lines,
      ].join('\n');
    }
    const lines = list.map((x) => `${x.id}｜${x.date}｜${x.category}/${x.type}｜${x.title}（${x.pages} 页）`);
    return [
      `基金：${this.index.name}（${this.index.code}）`,
      `当前公告日期：${this.scope.asOf}${this.scope.excludeId ? `（当前公告在库中的编号为 ${this.scope.excludeId}）` : ''}`,
      `可以使用的文件：${list.length} 份，均为本基金在当前公告日期及以前披露的文件（不含当前公告）。${hidden.length ? `另有 ${hidden.length} 份文件晚于当前公告，处理时视为尚未披露，不能使用。` : ''}`,
      '可用工具：search_notices 检索段落（可按类型过滤）；read_document 阅读原文（Markdown）；find_quote 填 doc_id 核对引用；get_product 查询产品资料（有产品档案的用档案，并列出之后发布的公告；否则取最近一份产品资料概要）。引用时来源标【披露文件】，doc 填编号。',
      '',
      '文件清单（编号｜日期｜类型｜标题）：',
      ...lines,
    ].join('\n');
  }
}

// ---------------------------------------------------------------- 识别公告属于哪只基金、哪一天

/** 从公告文字中识别日期：优先"公告送出日期"，其次正文最后出现的日期。 */
export function detectNoticeDate(text: string): string | undefined {
  const pick = (y: string, m: string, d: string) => `${y}-${String(+m).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;
  const sent = /送出日期[:：]?\s*(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})/.exec(text);
  if (sent) return pick(sent[1], sent[2], sent[3]);
  const all = [...text.matchAll(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)];
  const last = all[all.length - 1];
  return last ? pick(last[1], last[2], last[3]) : undefined;
}

/** 在公告文字中找公告库里收录的基金代码；同时判断这份公告本身是否就在库里。 */
export function detectScope(text: string, catalog: CatalogEntry[], index?: KbIndex): { code?: string; asOf?: string; excludeId?: string } {
  const head = text.slice(0, 3000);
  const code = catalog.filter((c) => (c.kind ?? 'fund') === 'fund').find((c) => new RegExp(`(^|\\D)${c.code}(\\D|$)`).test(head))?.code;
  const asOf = detectNoticeDate(text);
  let excludeId: string | undefined;
  if (code && index && index.code === code && asOf) {
    const key = normalize(text.slice(0, 600)).text;
    const sameDay = index.items.filter((x) => x.date === asOf);
    const exact = sameDay.find((x) => key.includes(normalize(x.title).text));
    const loose = sameDay.filter((x) => key.includes(normalize(x.title).text.slice(0, 16)));
    excludeId = exact?.id ?? (loose.length === 1 ? loose[0].id : undefined);
  }
  return { code, asOf, excludeId };
}
