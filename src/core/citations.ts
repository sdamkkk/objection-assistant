// 引用角标：把产出里引用原文的来源（当前公告、本基金此前的披露文件、法规原文）逐条定位到原始文件。
// 角标显示的片段由系统在原文中找到后逐字取出，不用模型写的引文；找不到的标出来，不替模型补全。

import type { Availability, CitableDoc } from './kb.ts';
import type { OpsResult, Source } from './types.ts';

/** 引用原始文件的来源标签：这几类会生成角标 */
export const ORIGINAL_TAGS = ['案例材料', '披露文件', '法规原文'] as const;
export type OriginalTag = (typeof ORIGINAL_TAGS)[number];

export function isOriginal(s: Source): boolean {
  return (ORIGINAL_TAGS as readonly string[]).includes(s.tag);
}

/** 文件编号：优先用 doc 字段，没填的从 note 里找 */
export function docIdOf(s: Source): string | undefined {
  if (s.doc && s.doc.trim()) return s.doc.trim();
  const m = /\b(\d{6}-\d{2}|R\d{2})\b/.exec(s.note ?? '');
  return m?.[1];
}

export interface DocProvider {
  notice: CitableDoc;
  get(id: string): CitableDoc | undefined;
}

export interface Citation {
  /** 角标编号，从 1 开始 */
  n: number;
  tag: OriginalTag;
  /** 模型写的引文 */
  quote: string;
  docId?: string;
  doc?: CitableDoc;
  found: boolean;
  /** 原文中与引文对应的那一段（逐字取自原文） */
  excerpt?: string;
  /** 引文跨页时，按页拆开的原文片段（已去掉中间的页码行） */
  segments?: { location: string; text: string }[];
  context?: string;
  /** 在原件中的位置 */
  page?: number;
  location?: string;
  article?: string;
  /** 找不到时，原文中最接近的一段 */
  closest?: string;
  /** 找不到或不能使用的原因 */
  problem?: string;
  availability?: Availability;
}

export interface CitationSet {
  list: Citation[];
  /** item id → 该条目引用的角标编号（按 sources 的顺序，去重） */
  byItem: Record<string, number[]>;
}

function keyOf(tag: string, docId: string | undefined, quote: string): string {
  return `${tag}|${docId ?? ''}|${quote.replace(/\s+/g, '')}`;
}

export function resolveCitation(s: Source, provider: DocProvider): Omit<Citation, 'n'> {
  const tag = s.tag as OriginalTag;
  const quote = (s.quote ?? '').trim();
  const base = { tag, quote };
  let doc: CitableDoc | undefined;
  let docId: string | undefined;
  if (tag === '案例材料') {
    doc = provider.notice;
  } else {
    docId = docIdOf(s);
    if (!docId) return { ...base, found: false, problem: '没有写明引用的是哪一份文件（缺少文件编号）。' };
    doc = provider.get(docId);
    if (!doc) return { ...base, docId, found: false, problem: `文件库中没有编号为 ${docId} 的文件。` };
  }
  if (!quote) return { ...base, docId, doc, found: false, problem: '没有给出原文片段。' };
  const hit = doc.paged.find(quote);
  const availability = doc.availability;
  const problem = availability === 'ok' ? undefined : doc.unavailableReason;
  if (!hit.found) {
    return {
      ...base,
      docId,
      doc,
      found: false,
      availability,
      closest: hit.closest?.text,
      location: hit.closest ? doc.location(hit.closest.page).label : undefined,
      problem: problem ?? '这段引文在原文中找不到。',
    };
  }
  const loc = doc.location(hit.page ?? 1);
  const segs = hit.start !== undefined && hit.end !== undefined ? doc.paged.segments(hit.start, hit.end) : [];
  return {
    ...base,
    docId,
    doc,
    found: true,
    availability,
    excerpt: segs.length > 1 ? segs.map((s) => s.text).join('') : hit.text,
    segments: segs.length > 1 ? segs.map((s) => ({ location: doc.location(s.page).label, text: s.text })) : undefined,
    context: hit.context,
    page: loc.page,
    location: loc.label,
    article: doc.article && hit.start !== undefined ? doc.article(hit.start) : undefined,
    problem,
  };
}

/** 按产出中出现的顺序给原文引用编号；同一份文件的同一段引文共用一个编号。 */
export function collectCitations(result: OpsResult, provider: DocProvider, order?: { id: string }[]): CitationSet {
  const list: Citation[] = [];
  const index = new Map<string, number>();
  const byItem: Record<string, number[]> = {};
  const sections = order ? order.map((o) => result.sections.find((s) => s.id === o.id)).filter((s): s is NonNullable<typeof s> => Boolean(s)) : result.sections;
  for (const sec of sections) {
    for (const it of sec.items) {
      const nums: number[] = [];
      for (const s of it.sources) {
        if (!isOriginal(s)) continue;
        const key = keyOf(s.tag, s.tag === '案例材料' ? undefined : docIdOf(s), s.quote ?? '');
        let n = index.get(key);
        if (n === undefined) {
          n = list.length + 1;
          index.set(key, n);
          list.push({ n, ...resolveCitation(s, provider) });
        }
        if (!nums.includes(n)) nums.push(n);
      }
      if (nums.length) byItem[it.id] = nums;
    }
  }
  return { list, byItem };
}

/** 引用的出处，一行文字：文件、日期、位置、条 */
export function citationLabel(c: Citation): string {
  const d = c.doc;
  const parts: string[] = [];
  if (!d) parts.push(c.docId ? `文件 ${c.docId}` : '未指明文件');
  else if (d.library === 'notice') parts.push('案例材料');
  else parts.push(`${d.id}《${d.title}》`);
  if (d?.meta) parts.push(d.meta);
  if (d?.date && d.library !== 'notice') parts.push(d.date);
  if (c.location && (d?.paged.pageCount ?? 1) > 1) parts.push(c.location);
  if (c.article) parts.push(c.article);
  return parts.join('，');
}
