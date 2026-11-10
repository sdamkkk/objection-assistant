// 在案例材料中查找引用：忽略空白、换行和全角半角差异；找不到时给出最接近的片段。

export interface Normalized {
  text: string;
  /** map[i] = 归一化文本第 i 个字符在原文中的下标 */
  map: number[];
}

const DASHES = /[—–‒―－]/;
const QUOTES: Record<string, string> = { '“': '"', '”': '"', '‘': "'", '’': "'", '「': '"', '」': '"' };

function normChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0);
  if (code === 0x3000) return '';
  if (DASHES.test(ch)) return '-';
  if (QUOTES[ch]) return QUOTES[ch];
  if (ch === '〔' || ch === '［') return '[';
  if (ch === '〕' || ch === '］') return ']';
  return ch;
}

export function normalize(src: string): Normalized {
  let text = '';
  const map: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (/\s/.test(ch)) continue;
    const n = normChar(ch);
    if (!n) continue;
    // 千分位逗号统一去掉，"10,000" 与 "10000" 视为相同
    if ((n === ',') && /\d/.test(text[text.length - 1] ?? '') && /^\s*\d{3}/.test(src.slice(i + 1))) continue;
    text += n;
    map.push(i);
  }
  return { text, map };
}

export interface FindHit {
  start: number;
  end: number;
  text: string;
  context: string;
}

export interface FindResult {
  found: boolean;
  hits: FindHit[];
  closest?: { text: string; similarity: number; start: number; end: number };
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    m.set(g, (m.get(g) ?? 0) + 1);
  }
  return m;
}

function dice(a: Map<string, number>, b: Map<string, number>, total: number): number {
  let inter = 0;
  for (const [g, c] of a) inter += Math.min(c, b.get(g) ?? 0);
  return total === 0 ? 0 : (2 * inter) / total;
}

function slice(src: Normalized, original: string, ns: number, ne: number): { start: number; end: number; text: string } {
  const start = src.map[ns];
  const end = src.map[ne - 1] + 1;
  return { start, end, text: original.slice(start, end) };
}

function contextOf(original: string, start: number, end: number, pad = 24): string {
  const a = Math.max(0, start - pad);
  const b = Math.min(original.length, end + pad);
  return (a > 0 ? '…' : '') + original.slice(a, b).replace(/\s+/g, ' ') + (b < original.length ? '…' : '');
}

/** 给模型看的文字：去掉 PDF 版式带来的大段空白（不改变任何字符内容）。 */
export function compactText(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/^[ \t　]+|[ \t　]+$/g, '').replace(/[ \t　]{3,}/g, '  '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class NoticeIndex {
  readonly original: string;
  readonly norm: Normalized;

  constructor(original: string) {
    this.original = original;
    this.norm = normalize(original);
  }

  find(query: string, maxHits = 3): FindResult {
    const q = normalize(query).text;
    if (!q) return { found: false, hits: [] };
    const hits: FindHit[] = [];
    let from = 0;
    while (hits.length < maxHits) {
      const idx = this.norm.text.indexOf(q, from);
      if (idx < 0) break;
      const s = slice(this.norm, this.original, idx, idx + q.length);
      hits.push({ ...s, context: contextOf(this.original, s.start, s.end) });
      from = idx + 1;
    }
    if (hits.length) return { found: true, hits };

    // 找最接近的片段：长度与查询相同（及 ±20%）的窗口，按二元组相似度打分
    const qb = bigrams(q);
    const qCount = Math.max(q.length - 1, 0);
    let best = { sim: 0, s: 0, e: 0 };
    const text = this.norm.text;
    const lens = [q.length, Math.round(q.length * 0.8), Math.round(q.length * 1.2)].filter((l) => l >= 2);
    for (const L of lens) {
      for (let i = 0; i + L <= text.length; i++) {
        const w = text.slice(i, i + L);
        const wb = bigrams(w);
        const sim = dice(qb, wb, qCount + Math.max(L - 1, 0));
        if (sim > best.sim) best = { sim, s: i, e: i + L };
      }
    }
    if (best.sim >= 0.4) {
      const s = slice(this.norm, this.original, best.s, best.e);
      return { found: false, hits: [], closest: { text: s.text, similarity: Math.round(best.sim * 100) / 100, start: s.start, end: s.end } };
    }
    return { found: false, hits: [] };
  }
}
